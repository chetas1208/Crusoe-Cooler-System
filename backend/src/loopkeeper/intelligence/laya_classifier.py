"""Laya typed incident triage for LOOPKEEPER cooling incidents. ADVISORY ONLY: it never grants robot or repair
authority; the deterministic policy guard decides.

Two engines, always labelled on every decision (`engine`):
  * `laya_router`  - the real Laya SDK Router running the cached `convaiinnovations/laya` checkpoint on CPU
                     (typed questions: choice / score / noul). Used only if the SDK imports AND a prediction succeeds.
  * `rule_fallback` - a keyword rule baseline used when the SDK/weights are unavailable. It is NOT Laya.

V12 (agent X) advisory-quality changes (all measured in `laya_eval.run_v12_evaluation`, never gating):
  * tighter, mutually exclusive criteria for the six task families (`CRITERIA_V12`; the V11 wording is kept as `COOLING_QUESTIONS` for ablation)
  * order/paraphrase ensemble: the same question is asked under several option orders (and a reworded state); probabilities are averaged and the
    advisory ABSTAINS when the member predictions flip (Laya is order-sensitive, see its arXiv note and README)
  * calibration fitted on a TRAIN split only (temperature + per-class log-bias + abstention threshold) from `laya_calibration.json`
  * the deterministic safety override (interlock-defeating / high-impact requests -> human_review) is applied after every engine
"""
from __future__ import annotations

import os
import re
import sys
import json
import time
import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

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

# ---- V12: tighter criteria, order / paraphrase ensemble, train-fitted calibration, deterministic safety override ----------------------
FAMILIES = ["inpipe_inspection", "exterior_service", "hydraulics_review", "thermal_review", "sensor_validation", "human_review"]
CRITERIA_V11 = COOLING_QUESTIONS["task_family"]["criteria"]
# six well-separated, mutually exclusive options (Laya is weak with many similar options); each names its discriminating cue
CRITERIA_V12 = {
    "inpipe_inspection": "deposit, scale, sludge or fouling build-up on the inside wall of a pipe run, narrowing its bore",
    "exterior_service": "one reachable external component needs hands-on service: strainer or filter, valve or actuator, fitting, pump seal or coupling",
    "hydraulics_review": "loop-wide pressure, flow or pump-head problem, or flow imbalance between zones, with no single part or deposit identified",
    "thermal_review": "heat problem at racks or CDU: high temperatures, thin thermal margin, heat load above heat rejection",
    "sensor_validation": "an instrument reading is wrong, frozen, noisy or contradicts the rest of the plant, which otherwise looks normal",
    "human_review": "evidence is missing, vague or self-contradicting, several unrelated faults, or a high-impact or safety-defeating request",
}
CRITERIA_SETS = {"v11": CRITERIA_V11, "v12": CRITERIA_V12}
INSTRUCTIONS = {
    "v11": COOLING_QUESTIONS["task_family"]["instructions"],
    "v12": "Which specialist should act first on this simulated data-center cooling incident? Choosing one never authorizes a repair.",
}
NOUL_V12 = {
    "type": "noul",
    "instructions": "Is the report too vague, incomplete or self-contradicting to pick one specialist?",
    "criteria": {"true": "the report is vague, has no readings, contradicts itself, or mixes unrelated faults",
                 "false": "the report describes one clear symptom or component that a single specialist can act on"},
}
URGENCY_V12 = {"type": "score", "instructions": "Estimate incident urgency from observed evidence, not authority to repair.",
               "criteria": ["routine", "needs_investigation", "time_sensitive", "critical_attention"]}
# option orders (indices into the criteria order): identity, reversed, half-rotation -> every option moves to a very different slot
ORDERS: Dict[str, List[int]] = {"id": [0, 1, 2, 3, 4, 5], "rev": [5, 4, 3, 2, 1, 0], "rot3": [3, 4, 5, 0, 1, 2]}
ORDER_SETS: Dict[str, List[str]] = {"single": ["id"], "orders3": ["id", "rev", "rot3"]}
CALIBRATION_PATH = Path(__file__).with_name("laya_calibration.json")


def rephrase(text: str) -> str:
    """Deterministic reworded state for the paraphrase-consistency check: swap the halves around ';' or ':', else wrap it as a spoken report."""
    t = (text or "").strip()
    for sep in (";", ":"):
        if sep in t:
            a, b = t.split(sep, 1)
            a, b = a.strip().rstrip("."), b.strip().rstrip(".")
            if a and b:
                return f"{b[0].upper()}{b[1:]}. Also: {a[0].lower()}{a[1:]}."
    return f"Control-room report in the operator's own words: {t[0].lower() + t[1:] if t else t}"


def state_variants(text: str, n: int) -> List[str]:
    return [text, rephrase(text)][:max(1, n)]


def build_questions(criteria: str, orders: List[str], with_noul: bool = True, with_urgency: bool = False) -> Dict[str, Any]:
    labels = list(CRITERIA_SETS[criteria])
    qs: Dict[str, Any] = {}
    for o in orders:
        q: Dict[str, Any] = {"type": "choice", "instructions": INSTRUCTIONS[criteria], "criteria": dict(CRITERIA_SETS[criteria])}
        if o != "id":
            q["option_order"] = list(ORDERS[o])
        qs[f"o_{o}"] = q
    assert list(CRITERIA_SETS[criteria]) == labels == FAMILIES
    if with_noul:
        qs["noul"] = dict(NOUL_V12)
    if with_urgency:
        qs["urgency"] = dict(URGENCY_V12)
    return qs


def softmax(x: np.ndarray) -> np.ndarray:
    z = x - x.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def ensemble_probs(members: np.ndarray) -> Tuple[np.ndarray, float]:
    """members: (m, 6) probabilities from the order / paraphrase members. Returns the averaged distribution and the consistency = share of members
    whose own argmax equals the ensemble argmax (1.0 = no flip)."""
    p = members.mean(axis=0)
    top = int(p.argmax())
    return p, float(np.mean(members.argmax(axis=1) == top))


def calibrate(p: np.ndarray, temperature: float, bias: Optional[np.ndarray]) -> np.ndarray:
    """Post-hoc scaling of an (averaged) distribution: softmax((log p + bias) / T). T and bias are fitted on the TRAIN split only."""
    lg = np.log(np.clip(p, 1e-4, 1.0))
    if bias is not None:
        lg = lg + bias
    return softmax(lg / max(temperature, 1e-3))


_UNSAFE = [
    re.compile(r"\bbypass\b", re.I), re.compile(r"\boverride\b.*\b(interlock|alarm|limit)", re.I), re.compile(r"\bdisable\b.*\b(alarm|interlock)", re.I),
    re.compile(r"\bisolate\b.*\b(entire|whole|all|main)\b", re.I), re.compile(r"\b(entire|whole)\b.*\b(loop|hall|cdu)\b.*\b(isolate|shut)", re.I),
    re.compile(r"\bcut\b.*\b(live|pressuri[sz]ed)", re.I), re.compile(r"\bwhile (the )?(hall|loop|pump|plant)\b.*\b(running|live|operating)", re.I),
    re.compile(r"\bduring peak (compute )?load\b", re.I), re.compile(r"\bwhile running\b", re.I),
]
# V12 additions, written from the TRAIN-split unsafe requests only (held-out recall is reported separately in the evaluation artifact)
_UNSAFE_V12: List["re.Pattern[str]"] = [
    re.compile(r"\b(ignore|skip|defeat|circumvent|turn off|switch off|remove|disable)\b[^.]*\b(interlock|lockout|thermal protection|safety|protection)\b", re.I),
    re.compile(r"\bwithout\b[^.]*\b(cutting power|isolating|de-?energi[sz]ing|locking out|checklist|permit)\b", re.I),
]
SAFETY_LABEL = "human_review"


def safety_override(text: str, family: str) -> Tuple[str, Optional[str]]:
    """Deterministic policy applied AFTER any classifier: high-impact / interlock-defeating requests always go to a human, whatever the model said."""
    for p in _UNSAFE + _UNSAFE_V12:
        if p.search(text or ""):
            return SAFETY_LABEL, f"safety rule: {p.pattern[:48]}"
    return family, None


@dataclass
class Calibration:
    """Frozen advisory configuration. Everything numeric here was fitted on the TRAIN split (config choice on dev); see laya_eval.run_v12_evaluation."""
    criteria: str = "v12"
    orders: str = "orders3"
    text_variants: int = 1
    temperature: float = 1.0
    bias: Optional[List[float]] = None
    tau: float = 0.5                          # abstain below this calibrated probability of the predicted family
    min_consistency: float = 1.0              # abstain when fewer than this share of members agree with the ensemble argmax
    noul_threshold: Optional[float] = None    # None = the noul question is not used (it did not separate human_review on TRAIN)
    fitted: bool = False
    dataset_sha256: Optional[str] = None
    provenance: str = "defaults (no fitted calibration file)"

    @classmethod
    def load(cls, path: Path = CALIBRATION_PATH) -> "Calibration":
        try:
            d = json.loads(path.read_text())
            return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})
        except Exception:                                        # noqa: BLE001
            return cls()

    def to_dict(self) -> Dict[str, Any]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


@dataclass
class TriageResult:
    family: str                       # advisory family after abstention and safety override
    raw_family: str                   # calibrated ensemble argmax before abstention / override
    confidence: float                 # calibrated probability of raw_family
    consistency: float
    abstained: bool
    abstain_reasons: List[str]
    override: Optional[str]
    noul: Optional[float]
    probs: Dict[str, float]
    members: int
    urgency: Optional[str] = None


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
    raw_family: Optional[str] = None         # V12: what the calibrated ensemble said before abstention / safety override
    consistency: Optional[float] = None      # V12: share of option-order / paraphrase members that agree
    abstain_reasons: List[str] = field(default_factory=list)
    safety_override: Optional[str] = None    # V12: the deterministic rule that forced human_review, if any
    calibrated: bool = False                 # V12: confidence is the train-fitted calibrated probability

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
            "raw_family": self.raw_family,
            "consistency": self.consistency,
            "abstain_reasons": list(self.abstain_reasons),
            "safety_override": self.safety_override,
            "calibrated": self.calibrated,
        }

class LayaIncidentClassifier:
    """Classifies cooling telemetry incidents with calibrated confidence thresholds."""
    
    CONFIDENCE_THRESHOLD = 0.5      # on Laya's calibrated task_family confidence; a priori, not tuned on the evaluation set
    NOUL_THRESHOLD = 0.5            # abstain if Laya's own "insufficient evidence" probability exceeds this
    CHECKPOINT = "convaiinnovations/laya (english)"

    def __init__(self, device: str = "cpu", use_router: bool = True, calibration: Optional[Calibration] = None):
        self.device = device
        self.use_router = use_router and HAS_LAYA_SDK
        self._router = None
        self._router_error: Optional[str] = None
        self._lock = threading.Lock()              # one forward pass at a time: the engine calls this from worker threads
        self.calibration = calibration if calibration is not None else Calibration.load()
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

    # ---- V12 advisory path ---------------------------------------------------------------------------------------------------
    def raw_members(self, text: str, criteria: str = "v12", orders: str = "orders3", text_variants: int = 1, with_urgency: bool = False
                    ) -> Optional[Dict[str, Any]]:
        """Run the real Laya router once per state variant; each call carries every option-order as a separate choice question (one forward pass).
        Returns {'members': (m, 6) probabilities in FAMILIES order, 'noul': mean P(insufficient), 'urgency': label|None} or None if the router is down."""
        r = self._get_router()
        if r is None:
            return None
        rows: List[List[float]] = []
        noul: List[float] = []
        urgency: Optional[str] = None
        try:
            for i, state in enumerate(state_variants(text, text_variants)):
                qs = build_questions(criteria, ORDER_SETS[orders], with_noul=True, with_urgency=with_urgency and i == 0)
                with self._lock:
                    ans = r.predict(state, qs)["answers"]
                for o in ORDER_SETS[orders]:
                    pr = ans[f"o_{o}"]["probabilities"]
                    rows.append([float(pr[f]) for f in FAMILIES])
                noul.append(float(ans["noul"].get("noul", 0.0)))
                if with_urgency and i == 0 and "urgency" in ans:
                    a = ans["urgency"]
                    urgency = a["legend"].get(str(int(round(a["score"]))), None) if "legend" in a else None
        except Exception as e:                                   # noqa: BLE001
            self._router_error = f"predict failed: {type(e).__name__}: {str(e)[:120]}"
            log.warning("Laya Router prediction failed (%s); rule fallback for this call.", self._router_error)
            return None
        return {"members": np.asarray(rows, dtype=float), "noul": float(np.mean(noul)), "noul_by_variant": noul, "urgency": urgency}

    def triage_from_members(self, text: str, members: np.ndarray, noul: Optional[float], cal: Optional[Calibration] = None, urgency: Optional[str] = None,
                            use_override: bool = True) -> TriageResult:
        """Pure policy on already computed member probabilities (this is exactly what the evaluation scores): ensemble -> calibrate -> abstain -> override."""
        cal = cal or self.calibration
        p_ens, cons = ensemble_probs(members)
        pc = calibrate(p_ens, cal.temperature, np.asarray(cal.bias, dtype=float) if cal.bias else None)
        k = int(pc.argmax())
        raw, conf = FAMILIES[k], float(pc[k])
        reasons: List[str] = []
        if conf < cal.tau:
            reasons.append(f"calibrated confidence {conf:.2f} < {cal.tau:.2f}")
        if members.shape[0] > 1 and cons < cal.min_consistency:
            reasons.append(f"order/paraphrase members disagree (consistency {cons:.2f} < {cal.min_consistency:.2f})")
        if cal.noul_threshold is not None and noul is not None and noul > cal.noul_threshold:
            reasons.append(f"insufficient-evidence p={noul:.2f} > {cal.noul_threshold:.2f}")
        fam = "human_review" if reasons else raw
        ov = None
        if use_override:
            fam, ov = safety_override(text, fam)
        return TriageResult(family=fam, raw_family=raw, confidence=round(conf, 4), consistency=round(cons, 3), abstained=bool(reasons),
                            abstain_reasons=reasons, override=ov, noul=noul, probs={f: round(float(v), 4) for f, v in zip(FAMILIES, pc)},
                            members=int(members.shape[0]), urgency=urgency)

    def triage_text(self, text: str, cal: Optional[Calibration] = None) -> Optional[TriageResult]:
        cal = cal or self.calibration
        raw = self.raw_members(text, cal.criteria, cal.orders, cal.text_variants, with_urgency=True)
        if raw is None:
            return None
        return self.triage_from_members(text, raw["members"], raw["noul"], cal, raw["urgency"])

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
        text = self._text(incident)
        tri = self.triage_text(text) if self.use_router else None
        if tri is not None:
            self.router_calls += 1
            dt_ms = (time.perf_counter() - t0) * 1000.0
            if tri.abstained:
                self.total_abstentions += 1
            fam = tri.family
            rationale = (f"Laya typed decision, {tri.members} order/paraphrase members: {tri.raw_family} (calibrated p={tri.confidence:.2f}, "
                         f"consistency {tri.consistency:.2f})")
            if tri.abstained:
                rationale += " [ABSTAINED: " + "; ".join(tri.abstain_reasons) + "; routed to human_review]"
            if tri.override:
                rationale += f" [SAFETY OVERRIDE: {tri.override}; routed to human_review]"
            return LayaDecision(incident_id=inc_id, task_family=fam, confidence=tri.confidence, urgency=tri.urgency or "needs_investigation",
                                insufficient_evidence=tri.abstained or fam == "human_review", abstained=tri.abstained or bool(tri.override),
                                latency_ms=round(dt_ms, 2), routing_rationale=rationale, engine="laya_router", checkpoint=self.CHECKPOINT,
                                raw_family=tri.raw_family, consistency=tri.consistency, abstain_reasons=list(tri.abstain_reasons),
                                safety_override=tri.override, calibrated=self.calibration.fitted)
        tf, conf, urg, in_ev, rationale = self._rule_classifier(summary)
        self.fallback_calls += 1
        dt_ms = (time.perf_counter() - t0) * 1000.0
        abstained = conf < 0.65 or in_ev
        raw_tf = tf
        if abstained:
            self.total_abstentions += 1
            if tf != "human_review":
                rationale += f" [ABSTAINED: confidence {conf:.2f} / insufficient-evidence flag; routed to human_review]"
                tf = "human_review"
        tf, ov = safety_override(text, tf)
        if ov:
            rationale += f" [SAFETY OVERRIDE: {ov}; routed to human_review]"
        return LayaDecision(incident_id=inc_id, task_family=tf, confidence=round(conf, 3), urgency=urg, insufficient_evidence=in_ev,
                            abstained=abstained or bool(ov), latency_ms=round(dt_ms, 2), routing_rationale=rationale, engine="rule_fallback", checkpoint=None,
                            raw_family=raw_tf, safety_override=ov)

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

