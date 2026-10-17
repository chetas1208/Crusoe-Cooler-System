"""Laya typed incident triage for LOOPKEEPER cooling incidents. ADVISORY ONLY: it never grants robot or repair
authority; the deterministic policy guard decides.

Two engines, always labelled on every decision (`engine`):
  * `laya_router`  - the real Laya SDK Router running the cached `convaiinnovations/laya` checkpoint on CPU
                     (typed questions: choice / score / noul). Used only if the SDK imports AND a prediction succeeds.
  * `rule_fallback` - a keyword rule baseline used when the SDK/weights are unavailable. It is NOT Laya.
"""
from __future__ import annotations

import os
import sys
import time
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("loopkeeper.intelligence.laya")

# Optional pinned clone (see pyproject [laya] extra); a normal `pip install laya` needs no path hack
repo_root = Path(__file__).resolve().parents[4]
for cand in [repo_root / ".references" / "laya"]:
    if cand.is_dir() and str(cand) not in sys.path:
        sys.path.insert(0, str(cand))

try:
    from laya import Router
    HAS_LAYA_SDK = True
except ImportError:
    HAS_LAYA_SDK = False
    Router = None

COOLING_QUESTIONS = {
    "task_family": {
        "type": "choice",
        "instructions": "Route this simulated data-center cooling incident to the most relevant specialist task; do not authorize a repair.",
        "criteria": {
            "inpipe_inspection": "investigate reachable internal pipe deposits, fouling, and lumen obstruction",
            "exterior_service": "diagnose accessible external strainer, valve, fitting, or pump hardware",
            "hydraulics_review": "explain loop pressure loss, flow network imbalances, and pump head curves",
            "thermal_review": "investigate server rack compute load, thermal margin, and CDU heat exchange",
            "sensor_validation": "cross-check drifting, conflicting, or physically impossible sensor telemetry",
            "human_review": "insufficient evidence or high-impact ambiguous decision requiring human intervention",
        },
    },
    "urgency": {
        "type": "score",
        "instructions": "Estimate incident urgency from observed evidence, not authority to repair.",
        "criteria": ["routine", "needs_investigation", "time_sensitive", "critical_attention"],
    },
    "insufficient_evidence": {
        "type": "noul",
        "instructions": "Is the evidence ambiguous or insufficient to choose a specialist reliably?"
    },
}

SCENARIO_TRIAGE_QUESTIONS = {
    "incident_family": {
        "type": "choice",
        "instructions": "Choose dominant data center event category.",
        "criteria": {
            "flow_restriction": "Partial or full water flow loss / clogged strainer",
            "pump_failure": "Loss of pump or CDU circulation",
            "leak": "Coolant escape, burst pipe or wet floor",
            "overheating": "Rack temperature rises or heat-rejection failure",
            "power_failure": "Electrical supply interruption / power outage",
            "fire_smoke": "Electrical burning, smoke or fire hazard",
            "sensor_fault": "Telemetry disagreement or sensor drift",
            "unknown": "Insufficient or unrelated description",
        },
    },
    "urgency": {
        "type": "score",
        "instructions": "Severity/urgency of the described simulated incident",
        "criteria": ["minor", "moderate", "severe", "emergency"],
    },
    "possible_immediate_hazard": {
        "type": "noul",
        "instructions": "Does the report plausibly describe a dangerous condition requiring restricted actions?",
    },
    "insufficient_evidence": {
        "type": "noul",
        "instructions": "Is the description ambiguous or insufficient to localize the incident reliably?",
    },
}

@dataclass
class LayaDecision:
    incident_id: str
    task_family: str
    confidence: float
    urgency: str
    insufficient_evidence: bool
    abstained: bool
    latency_ms: float
    routing_rationale: str
    engine: str = "rule_fallback"            # 'laya_router' | 'rule_fallback' (never claim the router when the rules answered)
    checkpoint: Optional[str] = None         # HF repo/revision of the checkpoint that answered, if the router did
    advisory: bool = True                    # classification never confers authority

    def to_dict(self) -> Dict[str, Any]:
        return {
            "incident_id": self.incident_id,
            "task_family": self.task_family,
            "confidence": self.confidence,
            "urgency": self.urgency,
            "insufficient_evidence": self.insufficient_evidence,
            "abstained": self.abstained,
            "latency_ms": self.latency_ms,
            "routing_rationale": self.routing_rationale,
            "engine": self.engine,
            "checkpoint": self.checkpoint,
            "advisory": self.advisory,
        }

class LayaIncidentClassifier:
    """Classifies cooling telemetry incidents with calibrated confidence thresholds."""
    
    CONFIDENCE_THRESHOLD = 0.5      # on Laya's calibrated task_family confidence; a priori, not tuned on the evaluation set
    NOUL_THRESHOLD = 0.5            # abstain if Laya's own "insufficient evidence" probability exceeds this
    CHECKPOINT = "convaiinnovations/laya (english)"

    def __init__(self, device: str = "cpu", use_router: bool = True):
        self.device = device
        self.use_router = use_router and HAS_LAYA_SDK
        self._router = None
        self._router_error: Optional[str] = None
        self.total_queries = 0
        self.total_abstentions = 0
        self.router_calls = 0
        self.fallback_calls = 0

    def _get_router(self):
        if not self.use_router or self._router is not None or self._router_error:
            return self._router
        try:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")        # use the cached checkpoint; never block on the network
            self._router = Router()
        except Exception as e:                                   # noqa: BLE001
            self._router_error = f"{type(e).__name__}: {str(e)[:160]}"
            log.warning("Laya Router unavailable (%s); using the labelled rule fallback.", self._router_error)
        return self._router

    @property
    def engine_name(self) -> str:
        return "laya_router" if (self._router is not None) else "rule_fallback"

    @staticmethod
    def _text(incident: Dict[str, Any]) -> str:
        bits = [str(incident.get("summary") or incident.get("description") or "").strip()]
        for k, label in (("asset_id", "asset"), ("metric", "metric"), ("delta_kpa", "differential pressure change kPa"),
                         ("flow_kg_s", "flow kg/s"), ("thermal_margin_c", "thermal margin C")):
            if incident.get(k) not in (None, "", 0, 0.0):
                bits.append(f"{label}: {incident[k]}")
        return ". ".join(b for b in bits if b)

    def _router_decision(self, text: str) -> Optional[Tuple[str, float, str, bool, str]]:
        r = self._get_router()
        if r is None:
            return None
        try:
            out = r.predict(text, COOLING_QUESTIONS)
            a = out["answers"]
            tf = a["task_family"]["choice"]
            conf = float(a["task_family"]["confidence"])
            urg = a["urgency"]["legend"][str(int(round(a["urgency"]["score"])))] if "legend" in a["urgency"] else "needs_investigation"
            noul = float(a["insufficient_evidence"].get("noul", 0.0))
        except Exception as e:                                   # noqa: BLE001
            self._router_error = f"predict failed: {type(e).__name__}: {str(e)[:120]}"
            log.warning("Laya Router prediction failed (%s); rule fallback for this call.", self._router_error)
            return None
        return tf, conf, urg, noul > self.NOUL_THRESHOLD, f"Laya typed decision (choice conf {conf:.2f}, insufficient-evidence p={noul:.2f})"

    def classify_incident(self, incident: Dict[str, Any]) -> LayaDecision:
        """Classify an incident dict. Advisory; abstains (routes to human_review) when confidence is low."""
        t0 = time.perf_counter()
        self.total_queries += 1
        inc_id = incident.get("id") or incident.get("incident_id") or "INC-UNKNOWN"
        summary = {
            "incident_id": inc_id, "asset_id": incident.get("asset_id", ""), "metric": incident.get("metric", ""),
            "value": incident.get("value", 0.0), "baseline": incident.get("baseline", 0.0),
            "delta_kpa": incident.get("delta_kpa", 0.0), "flow_kg_s": incident.get("flow_kg_s", 0.0),
            "thermal_margin_c": incident.get("thermal_margin_c", 15.0), "description": incident.get("summary", ""),
        }
        decision = self._router_decision(self._text(incident)) if self.use_router else None
        engine, ckpt, threshold = "laya_router", self.CHECKPOINT, self.CONFIDENCE_THRESHOLD
        if decision is None:
            decision = self._rule_classifier(summary)
            engine, ckpt, threshold = "rule_fallback", None, 0.65
            self.fallback_calls += 1
        else:
            self.router_calls += 1
        tf, conf, urg, in_ev, rationale = decision
        dt_ms = (time.perf_counter() - t0) * 1000.0

        abstained = conf < threshold or in_ev
        if abstained:
            self.total_abstentions += 1
            if tf != "human_review":
                rationale += f" [ABSTAINED: confidence {conf:.2f} / insufficient-evidence flag; routed to human_review]"
                tf = "human_review"
        return LayaDecision(incident_id=inc_id, task_family=tf, confidence=round(conf, 3), urgency=urg, insufficient_evidence=in_ev,
                            abstained=abstained, latency_ms=round(dt_ms, 2), routing_rationale=rationale, engine=engine, checkpoint=ckpt)

    def _rule_classifier(self, s: Dict[str, Any]) -> Tuple[str, float, str, bool, str]:
        """Keyword rule baseline (NOT Laya): used only when the Laya router is unavailable."""
        desc = (s.get("description") or "").lower()
        asset = (s.get("asset_id") or "").lower()
        metric = (s.get("metric") or "").lower()
        dp = float(s.get("delta_kpa", 0.0))
        flow = float(s.get("flow_kg_s", 0.0))
        margin = float(s.get("thermal_margin_c", 15.0))

        # Check for ambiguity / compound conflicting evidence
        if "unknown" in desc or ("drift" in desc and dp > 30):
            return "human_review", 0.45, "needs_investigation", True, "Conflicting drift vs pressure signals"

        if "strainer" in asset or "strainer" in desc or (dp > 35 and "strainer" in asset):
            conf = 0.92 if dp > 40 else 0.78
            urg = "critical_attention" if dp > 50 else "time_sensitive"
            return "exterior_service", conf, urg, False, "Strainer differential pressure anomaly"

        if "pipe" in asset or "deposit" in desc or "fouling" in desc or "bore" in desc:
            conf = 0.88 if "fouling" in desc else 0.72
            urg = "time_sensitive" if flow < 3.0 else "needs_investigation"
            return "inpipe_inspection", conf, urg, False, "Internal lumen deposit or wall fouling detected"

        if "pump" in asset or "trip" in desc or "head" in desc:
            conf = 0.90
            urg = "critical_attention"
            return "hydraulics_review", conf, urg, False, "Loop pump head loss / hydraulic imbalance"

        if "rack" in asset or "heat" in desc or margin < 6.0:
            conf = 0.85
            urg = "critical_attention" if margin < 4.0 else "time_sensitive"
            return "thermal_review", conf, urg, False, "Server rack thermal margin depletion"

        if "sensor" in asset or "drift" in desc or "offset" in desc:
            conf = 0.82
            urg = "routine"
            return "sensor_validation", conf, urg, False, "Telemetry calibration drift without hydraulic effect"

        return "human_review", 0.50, "routine", True, "Unclassified anomaly signature; abstaining to human"

    def triage_scenario_prompt(self, raw_text: str) -> Dict[str, Any]:
        """Triage an incoming user natural language prompt into typed scenario categories."""
        t0 = time.perf_counter()
        r = self._get_router()
        text = (raw_text or "").strip()
        desc_lower = text.lower()
        if r is not None:
            try:
                out = r.predict(text, SCENARIO_TRIAGE_QUESTIONS)
                ans = out["answers"]
                fam = ans["incident_family"]["choice"]
                conf = float(ans["incident_family"]["confidence"])
                urg_score = int(round(ans["urgency"]["score"]))
                urg = ans["urgency"]["legend"].get(str(urg_score), "moderate") if "legend" in ans["urgency"] else "moderate"
                hazard_p = float(ans["possible_immediate_hazard"].get("noul", 0.0))
                insuf_p = float(ans["insufficient_evidence"].get("noul", 0.0))
                dt = (time.perf_counter() - t0) * 1000.0
                return {
                    "incident_family": fam,
                    "confidence": round(conf, 3),
                    "urgency": urg,
                    "possible_immediate_hazard": hazard_p > 0.5,
                    "insufficient_evidence": insuf_p > 0.5,
                    "engine": "laya_router",
                    "checkpoint": self.CHECKPOINT,
                    "latency_ms": round(dt, 2),
                    "abstained": conf < self.CONFIDENCE_THRESHOLD or insuf_p > 0.5,
                    "raw_text": text,
                }
            except Exception as e:
                log.warning("Laya scenario predict failed (%s); using rule fallback.", e)

        # Deterministic keyword rule fallback
        fam = "unknown"
        urg = "moderate"
        hazard = False
        insuf = False
        conf = 0.85

        if any(w in desc_lower for w in ["fire", "smoke", "burn", "arc", "flame"]):
            fam = "fire_smoke"
            urg = "emergency"
            hazard = True
        elif any(w in desc_lower for w in ["leak", "flood", "burst", "rupture", "spill", "wet"]):
            fam = "leak"
            urg = "severe"
            hazard = True
        elif any(w in desc_lower for w in ["overheat", "hot", "temperature", "heat", "thermal"]):
            fam = "overheating"
            urg = "severe"
        elif any(w in desc_lower for w in ["pump", "cdu circulation", "circulation"]):
            fam = "pump_failure"
            urg = "severe"
        elif any(w in desc_lower for w in ["power", "substation", "ups", "blackout", "battery"]):
            fam = "power_failure"
            urg = "emergency"
            hazard = True
        elif any(w in desc_lower for w in ["block", "clog", "flow", "strainer", "restriction", "deposit"]):
            fam = "flow_restriction"
            urg = "moderate"
        elif any(w in desc_lower for w in ["sensor", "drift", "lying", "telemetry", "disagreement", "false"]):
            fam = "sensor_fault"
            urg = "minor"
        else:
            fam = "unknown"
            insuf = True
            conf = 0.40

        dt = (time.perf_counter() - t0) * 1000.0
        return {
            "incident_family": fam,
            "confidence": conf,
            "urgency": urg,
            "possible_immediate_hazard": hazard,
            "insufficient_evidence": insuf,
            "engine": "rule_fallback",
            "checkpoint": None,
            "latency_ms": round(dt, 2),
            "abstained": conf < 0.5 or insuf,
            "raw_text": text,
        }

_GLOBAL_LAYA: Optional[LayaIncidentClassifier] = None

def get_laya_classifier() -> LayaIncidentClassifier:
    global _GLOBAL_LAYA
    if _GLOBAL_LAYA is None:
        # LOOPKEEPER_LAYA_ROUTER=0 disables the (slow, CPU) Laya router; the labelled rule fallback answers instead
        _GLOBAL_LAYA = LayaIncidentClassifier(use_router=os.environ.get("LOOPKEEPER_LAYA_ROUTER", "1") != "0")
    return _GLOBAL_LAYA

