"""SharedBrain: the only API to cross-run memory.

Rules (all enforced here, so the in-memory and Postgres stores behave the same):
  * a write is a PROPOSAL (status PROPOSED, never read back) with mandatory provenance (run id, evidence ids, proposer);
  * only settle() with an INDEPENDENT verification (status 'verified', a verification id, a verifier different from the proposer, from a run the
    item names) promotes it to VERIFIED + visibility 'shared'; a FAILED verification never promotes a lesson (it is REJECTED, kept for audit);
    an UNKNOWN verification changes nothing;
  * contradictory claims are never overwritten: the new content is a new revision, both sides become CONFLICTED and a memory_conflicts row is
    opened; resolve_conflict() needs an independent verified outcome;
  * sensor-derived / invalidated facts expire (TTL); expired rows are never read;
  * read_relevant() returns only VERIFIED, unexpired, in-scope items of the reader's facility, within a token budget, never anything proposed by
    another run and never anything touched by an excluded (held-out) run.
Memory is advice about what to try; it never widens what the deterministic policy allows.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from typing import Any, Callable, Iterable

from .schema import LIVE
from .store import BrainStore

Json = dict[str, Any]

DEFAULT_TTL_S = {"sensor": 1800.0, "transient": 600.0}      # fact_kind -> ttl; others do not expire unless ttl_s is given
PROPOSAL_TTL_S = 7 * 86400.0                                # an unverified proposal that never gets settled expires
MAX_TEXT, MAX_STEPS, MAX_IDS = 400, 8, 24
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class MemoryRefusal(ValueError):
    """A write that breaks the memory contract (no provenance, bad scope, ...). `code` is stable for tests / audit."""

    def __init__(self, code: str, msg: str = "") -> None:
        super().__init__(f"{code}: {msg}" if msg else code)
        self.code = code


def _h(*parts: Any) -> str:
    return hashlib.sha256("\x1f".join(json.dumps(p, sort_keys=True, separators=(",", ":"), default=str) if not isinstance(p, str) else p for p in parts).encode()).hexdigest()


def tokens_of(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))               # coarse, deterministic, model-agnostic


def _clean(s: Any, n: int = MAX_TEXT) -> str:
    return _CTRL.sub(" ", str(s or "")).strip()[:n]


def _ids(xs: Iterable[Any] | None) -> list[str]:
    out: list[str] = []
    for x in xs or []:
        x = _clean(x, 80)
        if x and x not in out:
            out.append(x)
    return out[:MAX_IDS]


def _merge(a: list, b: list, cap: int = 48) -> list:
    out = list(a or [])
    for x in b or []:
        if x not in out:
            out.append(x)
    return out[-cap:]


def independent(item: Json, ver: Json) -> tuple[bool, str]:
    """Is `ver` an admissible promotion for `item`? (verified, identified, from a verifier that is not the proposer, about a run the item names)."""
    if str(ver.get("status")) != "verified":
        return False, "verification_not_verified"
    if not ver.get("verification_id") or not ver.get("verifier"):
        return False, "verification_not_identified"
    if str(ver["verifier"]) == str(item.get("proposed_by") or ""):
        return False, "verifier_is_proposer"
    runs = {item.get("run_id"), *(item.get("source_run_ids") or [])}
    if ver.get("run_id") not in runs:
        return False, "verification_from_unrelated_run"
    return True, ""


class SharedBrain:
    enabled = True

    def __init__(self, store: BrainStore, *, clock: Callable[[], float] = time.time) -> None:
        self.store, self.clock = store, clock
        self.stats: Json = {"reads": 0, "items_returned": 0, "proposed": 0, "promoted": 0, "rejected": 0, "conflicts": 0, "expired": 0, "tokens_served": 0}
        self._sl = threading.Lock()

    def _bump(self, k: str, n: int = 1) -> None:
        with self._sl:
            self.stats[k] = self.stats.get(k, 0) + n

    # ───────────────────────── propose ─────────────────────────
    def propose_fact(self, *, run_id: str, facility_id: str, subject_key: str, statement: str, evidence_ids: Iterable[str], proposed_by: str,
                     value: Json | None = None, incident_id: str | None = None, source_run_ids: Iterable[str] | None = None, fact_kind: str = "observation",
                     fault_kind: str | None = None, asset_type: str | None = None, asset_id: str | None = None, topology_revision: str | None = None,
                     preconditions: Json | None = None, confidence: float = 0.5, ttl_s: float | None = None, event_refs: list | None = None) -> Json:
        ev = _ids(evidence_ids)
        if not (run_id and facility_id and subject_key and statement and proposed_by):
            raise MemoryRefusal("missing_provenance", "run_id, facility_id, subject_key, statement and proposed_by are required")
        if not ev:
            raise MemoryRefusal("no_evidence", "a memory proposal must cite evidence ids")
        now = self.clock()
        val = value if value is not None else {"statement": _clean(statement)}
        vh = _h("v", val)
        fid = "fct_" + _h(facility_id, subject_key)[:16]
        ttl = ttl_s if ttl_s is not None else DEFAULT_TTL_S.get(fact_kind)
        row = dict(fact_id=fid, revision=1, facility_id=facility_id, run_id=run_id, incident_id=incident_id, subject_key=_clean(subject_key, 160),
                   fact_kind=fact_kind, fault_kind=fault_kind, asset_type=asset_type, asset_id=asset_id, topology_revision=topology_revision,
                   statement=_clean(statement), value=val, value_hash=vh, evidence_ids=ev, source_run_ids=_ids([run_id, *(source_run_ids or [])]),
                   event_refs=list(event_refs or [])[:MAX_IDS], preconditions=preconditions or {}, confidence=min(1.0, max(0.0, float(confidence))),
                   status="PROPOSED", status_reason="ttl:explicit" if ttl else "", visibility="run", proposed_by=proposed_by, verified_by=None,
                   verification_ref=None, conflict_id=None, created_ts=now, updated_ts=now, expires_ts=(now + ttl) if ttl else now + PROPOSAL_TTL_S)
        with self.store.locked(f"fact:{fid}"):
            revs = self.store.select("fact", eq={"fact_id": fid})
            for r in revs:                                               # idempotent re-proposal by the same run/incident
                if r["status"] == "PROPOSED" and r["run_id"] == run_id and r["incident_id"] == incident_id and r["value_hash"] == vh:
                    return {**r, "deduped": True}
            for r in revs:                                               # same-run newer observation supersedes the older unverified one (sensor reads change)
                if r["status"] == "PROPOSED" and r["run_id"] == run_id and r["value_hash"] != vh:
                    self._set("fact", r, status="EXPIRED", status_reason="superseded by a newer observation in the same run")
            row["revision"] = max([r["revision"] for r in revs] + [0]) + 1
            rival = [r for r in revs if r["status"] in ("VERIFIED", "CONFLICTED") and r["value_hash"] != vh]
            if rival:                                                    # new conflicting evidence: keep BOTH revisions, never overwrite
                row["status"], row["status_reason"] = "CONFLICTED", "contradicts a verified/conflicted revision"
                cid = self._open_conflict("fact", facility_id, row["subject_key"], fid, run_id, [*rival, row], now)
                row["conflict_id"] = cid
                for r in rival:
                    self._set("fact", r, status="CONFLICTED", status_reason="contradicted by a new revision", conflict_id=cid)
            self.store.insert("fact", row)
        self._bump("proposed")
        return row

    def propose_lesson(self, *, run_id: str, facility_id: str, fault_kind: str, steps: list[Json], evidence_ids: Iterable[str], proposed_by: str,
                       asset_type: str | None = None, preconditions: Json | None = None, expected_outcome: str = "", title: str = "",
                       incident_id: str | None = None, source_run_ids: Iterable[str] | None = None, topology_revision: str | None = None,
                       confidence: float = 0.5, ttl_s: float | None = None, event_refs: list | None = None) -> Json:
        ev = _ids(evidence_ids)
        if not (run_id and facility_id and fault_kind and proposed_by):
            raise MemoryRefusal("missing_provenance", "run_id, facility_id, fault_kind and proposed_by are required")
        if not ev:
            raise MemoryRefusal("no_evidence", "a memory proposal must cite evidence ids")
        if not steps or len(steps) > MAX_STEPS:
            raise MemoryRefusal("bad_steps", f"1..{MAX_STEPS} steps required")
        steps = [{str(k)[:32]: (_clean(v, 80) if isinstance(v, str) else v) for k, v in dict(s).items()} for s in steps]
        pre = preconditions or {}
        sh = _h("s", steps)
        lid = "lsn_" + _h(facility_id, fault_kind, asset_type or "", sh, pre)[:16]
        now = self.clock()
        row = dict(lesson_id=lid, revision=1, facility_id=facility_id, run_id=run_id, incident_id=incident_id, fault_kind=fault_kind, asset_type=asset_type,
                   topology_revision=topology_revision, subject_key=f"{fault_kind}|{asset_type or '*'}|{_h(pre)[:8]}",
                   title=_clean(title or f"{fault_kind}: " + " > ".join(str(s.get("action", "?")) for s in steps), 160), steps=steps, steps_hash=sh,
                   expected_outcome=_clean(expected_outcome), preconditions=pre, evidence_ids=ev, source_run_ids=_ids([run_id, *(source_run_ids or [])]),
                   event_refs=list(event_refs or [])[:MAX_IDS], confidence=min(1.0, max(0.0, float(confidence))), success_count=0, failure_count=0,
                   status="PROPOSED", status_reason="", visibility="run", proposed_by=proposed_by, verified_by=None, verification_ref=None,
                   conflict_id=None, created_ts=now, updated_ts=now, expires_ts=(now + ttl_s) if ttl_s else now + PROPOSAL_TTL_S)
        with self.store.locked(f"lesson:{lid}"):
            revs = self.store.select("lesson", eq={"lesson_id": lid})
            for r in revs:
                if r["status"] == "PROPOSED" and r["run_id"] == run_id and r["incident_id"] == incident_id:
                    return {**r, "deduped": True}
            row["revision"] = max([r["revision"] for r in revs] + [0]) + 1
            self.store.insert("lesson", row)
        self._bump("proposed")
        return row

    # ───────────────────────── settle (promotion) ─────────────────────────
    def settle(self, *, run_id: str, incident_id: str | None, verification: Json, items: Iterable[Json] | None = None) -> Json:
        """Apply ONE verification outcome to the proposals of (run, incident). `items` limits it to specific rows ({'kind','id','revision'} or the rows
        returned by propose_*); default = every unsettled proposal of that run/incident."""
        ver = {**verification, "run_id": verification.get("run_id") or run_id}
        res: Json = {"promoted": [], "merged": [], "rejected": [], "conflicted": [], "kept": [], "refused": []}
        for kind, row in self._candidates(run_id, incident_id, items):
            key = {"fact": "fact_id", "lesson": "lesson_id"}[kind]
            with self.store.locked(f"{kind}:{row[key]}"):
                cur = self.store.get(kind, {key: row[key], "revision": row["revision"]})
                if cur is None or cur["verification_ref"] is not None or cur["status"] not in ("PROPOSED", "CONFLICTED"):
                    continue
                st = str(ver.get("status"))
                ref = {k: ver.get(k) for k in ("verification_id", "verifier", "status", "run_id", "incident_id", "checks", "contract_hash", "tick") if k in ver}
                tag = {"kind": kind, "id": cur[key], "revision": cur["revision"]}
                if st == "verified":
                    ok, why = independent(cur, ver)
                    if not ok:
                        res["refused"].append({**tag, "reason": why})
                        continue
                    out = self._promote(kind, cur, ver, ref)
                    res[out].append(tag)
                elif st == "rejected":
                    out = self._fail(kind, cur, ver, ref)
                    res[out].append(tag)
                else:                                                    # unknown: nothing is learned, nothing is promoted
                    res["kept"].append(tag)
        return res

    def _candidates(self, run_id: str, incident_id: str | None, items: Iterable[Json] | None):
        if items is not None:
            for it in items:
                kind = it.get("kind") or ("fact" if "fact_id" in it else "lesson")
                rid = it.get("id") or it.get("fact_id") or it.get("lesson_id")
                key = {"fact": "fact_id", "lesson": "lesson_id"}[kind]
                r = self.store.get(kind, {key: rid, "revision": it["revision"]})
                if r and r["run_id"] == run_id:
                    yield kind, r
            return
        for kind in ("fact", "lesson"):
            for st in ("PROPOSED", "CONFLICTED"):
                for r in self.store.select(kind, eq={"run_id": run_id, "incident_id": incident_id}, status_in=(st,)):
                    yield kind, r

    def _promote(self, kind: str, cur: Json, ver: Json, ref: Json) -> str:
        now = self.clock()
        idk = "fact_id" if kind == "fact" else "lesson_id"
        hashk = "value_hash" if kind == "fact" else "steps_hash"
        same = [r for r in self.store.select(kind, eq={idk: cur[idk]}) if r["revision"] != cur["revision"] and r[hashk] == cur[hashk] and r["status"] == "VERIFIED"]
        if same:                                                         # an independently verified twin exists: corroborate it, archive the duplicate
            tw = same[0]
            ch: Json = dict(evidence_ids=_merge(tw["evidence_ids"], cur["evidence_ids"]), source_run_ids=_merge(tw["source_run_ids"], cur["source_run_ids"]),
                            event_refs=_merge(tw["event_refs"], cur["event_refs"]), confidence=tw["confidence"] + (1 - tw["confidence"]) * 0.3, updated_ts=now)
            if kind == "lesson":
                ch["success_count"] = tw["success_count"] + 1
            self.store.update(kind, {idk: tw[idk], "revision": tw["revision"]}, ch)
            self._set(kind, cur, status="ARCHIVED", status_reason=f"merged into r{tw['revision']} (corroboration)", verification_ref=ref, verified_by=ver["verifier"])
            self._bump("promoted")
            return "merged"
        rivals = [r for r in self.store.select(kind, eq={idk: cur[idk]}) if r["revision"] != cur["revision"] and r["status"] in ("VERIFIED", "CONFLICTED") and r[hashk] != cur[hashk]] \
            if kind == "fact" else []
        conf = max(cur["confidence"], 0.7)
        if rivals:                                                       # two independently verified, contradictory claims
            cid = next((r["conflict_id"] for r in rivals if r["conflict_id"]), None) or self._open_conflict(kind, cur["facility_id"], cur["subject_key"], cur[idk], cur["run_id"], [*rivals, cur], now)
            for r in rivals:
                self._set(kind, r, status="CONFLICTED", status_reason="contradicted by a verified revision", conflict_id=cid)
            self._set(kind, cur, status="CONFLICTED", status_reason="verified but contradicts another verified revision", conflict_id=cid, verification_ref=ref,
                      verified_by=ver["verifier"], confidence=conf)
            return "conflicted"
        keep_ttl = kind == "fact" and cur["status_reason"] == "ttl:explicit"          # a proposal's default 7-day expiry ends on promotion; an explicit TTL (sensor facts) stays
        ch = dict(status="VERIFIED", status_reason="independent verification", visibility="shared", verification_ref=ref, verified_by=ver["verifier"], confidence=conf, updated_ts=now,
                  expires_ts=cur["expires_ts"] if keep_ttl else None)
        if kind == "lesson":
            ch["success_count"] = cur["success_count"] + 1
        self.store.update(kind, {idk: cur[idk], "revision": cur["revision"]}, ch)
        self._bump("promoted")
        return "promoted"

    def _fail(self, kind: str, cur: Json, ver: Json, ref: Json) -> str:
        idk = "fact_id" if kind == "fact" else "lesson_id"
        if kind == "fact":
            if cur["status"] == "CONFLICTED" and cur["verification_ref"] is None:       # a contradicting claim whose own verification failed: reject it, restore the other side
                self._set("fact", cur, status="REJECTED", status_reason="contradicting claim failed verification", verification_ref=ref, verified_by=ver["verifier"])
                self._bump("rejected")
                self._after_reject(cur)
                return "rejected"
            return "kept"                                                # an unverified observation stays unverified (it expires); it is not declared false
        prior = [r for r in self.store.select("lesson", eq={"lesson_id": cur["lesson_id"]}) if r["revision"] != cur["revision"] and r["status"] in ("VERIFIED", "CONFLICTED")]
        now = self.clock()
        if prior:                                                        # a lesson that worked now fails under the same preconditions: keep both, flag
            cid = next((r["conflict_id"] for r in prior if r["conflict_id"]), None) or self._open_conflict("lesson", cur["facility_id"], cur["subject_key"], cur[idk], cur["run_id"], [*prior, cur], now)
            for r in prior:
                self._set("lesson", r, status="CONFLICTED", status_reason="an independent verification failed for the same plan", conflict_id=cid)
            self._set("lesson", cur, status="CONFLICTED", status_reason="failed verification of a previously verified plan", conflict_id=cid, verification_ref=ref,
                      verified_by=ver["verifier"], failure_count=cur["failure_count"] + 1)
            return "conflicted"
        self._set("lesson", cur, status="REJECTED", status_reason="failed verification: never promoted", verification_ref=ref, verified_by=ver["verifier"],
                  failure_count=cur["failure_count"] + 1)
        self._bump("rejected")
        self._after_reject(cur)
        return "rejected"

    def _after_reject(self, cur: Json) -> None:
        """If a rejected revision leaves exactly one verified side of an open conflict, that side is VERIFIED again and the conflict is resolved."""
        if cur.get("conflict_id") is None or "fact_id" not in cur:
            return
        left = [r for r in self.store.select("fact", eq={"fact_id": cur["fact_id"]}, status_in=("CONFLICTED",))]
        if len({r["value_hash"] for r in left}) == 1 and all(r["verified_by"] for r in left):
            for r in left:
                self._set("fact", r, status="VERIFIED", status_reason="conflict dissolved: the contradicting claim failed verification", visibility="shared")
            self.store.update("conflict", {"conflict_id": cur["conflict_id"]}, {"status": "RESOLVED", "resolved_ts": self.clock(), "resolved_by": "memory.auto",
                                                                              "resolution": {"reason": "contradicting claim rejected by a failed verification"}})

    # ───────────────────────── conflicts ─────────────────────────
    def _open_conflict(self, kind: str, facility_id: str, subject: str, item_id: str, run_id: str | None, sides: list[Json], now: float) -> str:
        cid = "cfl_" + _h(facility_id, kind, subject, item_id)[:14]
        items = [{"id": item_id, "revision": s["revision"], "run_id": s["run_id"], "hash": s.get("value_hash") or s.get("steps_hash")} for s in sides]
        ex = self.store.get("conflict", {"conflict_id": cid})
        if ex is None:
            self.store.insert("conflict", dict(conflict_id=cid, facility_id=facility_id, item_kind=kind, subject_key=subject, items=items, status="OPEN",
                                               detected_run_id=run_id, detected_ts=now, resolved_ts=None, resolved_by=None, resolution=None))
            self._bump("conflicts")
        else:
            seen = {(i["id"], i["revision"]) for i in ex["items"]}
            self.store.update("conflict", {"conflict_id": cid}, {"items": ex["items"] + [i for i in items if (i["id"], i["revision"]) not in seen], "status": "OPEN",
                                                                  "resolved_ts": None, "resolved_by": None, "resolution": None})
        return cid

    def open_conflicts(self, facility_id: str) -> list[Json]:
        return self.store.select("conflict", eq={"facility_id": facility_id, "status": "OPEN"}, order_by="detected_ts")

    def resolve_conflict(self, conflict_id: str, *, winner_revision: int, verification: Json, resolved_by: str, reason: str = "") -> Json:
        """Only an independent VERIFIED outcome may pick a winner; losers become REJECTED (kept). The conflict row is kept as RESOLVED."""
        c = self.store.get("conflict", {"conflict_id": conflict_id})
        if c is None or c["status"] != "OPEN":
            raise MemoryRefusal("no_open_conflict", conflict_id)
        kind = c["item_kind"]
        idk = "fact_id" if kind == "fact" else "lesson_id"
        item_id = c["items"][0]["id"]
        rows = [r for r in self.store.select(kind, eq={idk: item_id}) if r["status"] == "CONFLICTED"]
        win = next((r for r in rows if r["revision"] == winner_revision), None)
        if win is None:
            raise MemoryRefusal("winner_not_in_conflict", str(winner_revision))
        ok, why = independent(win, {**verification, "run_id": verification.get("run_id") or win["run_id"]})
        if not ok:
            raise MemoryRefusal(why)
        now = self.clock()
        for r in rows:
            if r["revision"] == winner_revision:
                self._set(kind, r, status="VERIFIED", status_reason=f"conflict resolved: {reason}"[:200], visibility="shared", verified_by=verification["verifier"], confidence=max(r["confidence"], 0.7))
            else:
                self._set(kind, r, status="REJECTED", status_reason=f"lost conflict {conflict_id}")
        res = {"winner": winner_revision, "verification_id": verification["verification_id"], "reason": reason[:200]}
        self.store.update("conflict", {"conflict_id": conflict_id}, {"status": "RESOLVED", "resolved_ts": now, "resolved_by": resolved_by, "resolution": res})
        return res

    # ───────────────────────── read ─────────────────────────
    def read_relevant(self, *, run_id: str, facility_id: str, fault_kind: str | None = None, asset_type: str | None = None, asset_id: str | None = None,
                      topology_revision: str | None = None, limit: int = 6, token_budget: int = 500, exclude_runs: Iterable[str] = (),
                      include_disputed: bool = True) -> Json:
        """Compact, verified-only memory for one planning decision. Never returns proposals, rejected/expired rows, other facilities, other topology
        layouts, or anything whose provenance touches `exclude_runs`. `tokens` never exceeds `token_budget`."""
        now = self.clock()
        excl = set(exclude_runs or ())

        def visible(r: Json) -> bool:
            if r["facility_id"] != facility_id or (r["visibility"] != "shared" and r["run_id"] != run_id):
                return False
            if excl & {r["run_id"], *(r.get("source_run_ids") or [])}:
                return False
            if topology_revision and r.get("topology_revision") and r["topology_revision"] != topology_revision:
                return False
            if fault_kind and r.get("fault_kind") and r["fault_kind"] != fault_kind:
                return False
            if asset_type and r.get("asset_type") and r["asset_type"] != asset_type:
                return False
            return True

        def score(r: Json) -> float:
            s = r["confidence"] * (1 + 0.15 * min(r.get("success_count", 0), 5))
            s += 0.3 if (asset_id and r.get("asset_id") == asset_id) else 0.0
            s += 0.1 if (asset_type and r.get("asset_type") == asset_type) else 0.0
            return s + 1e-9 * r["updated_ts"]

        facts = sorted((r for r in self.store.select("fact", eq={"facility_id": facility_id}, status_in=("VERIFIED",), live_at=now, order_by="confidence", limit=500) if visible(r)), key=score, reverse=True)
        lessons = sorted((r for r in self.store.select("lesson", eq={"facility_id": facility_id}, status_in=("VERIFIED",), live_at=now, order_by="confidence", limit=500) if visible(r)), key=score, reverse=True)
        used, out_f, out_l, truncated = 12, [], [], False
        # lessons first (they are the actionable memory), then facts; interleave by rank until the budget or the limit is hit
        pool = [("L", r) for r in lessons] + [("F", r) for r in facts]
        pool.sort(key=lambda t: (t[0] != "L", -score(t[1])))
        for tag, r in pool:
            if len(out_f) + len(out_l) >= limit:
                truncated = True
                break
            item = self._render(tag, r)
            t = tokens_of(item["text"])
            if used + t > token_budget:
                truncated = True
                continue
            used += t
            (out_l if tag == "L" else out_f).append(item)
        disputed: list[Json] = []
        if include_disputed:
            for kind in ("fact", "lesson"):
                for r in self.store.select(kind, eq={"facility_id": facility_id}, status_in=("CONFLICTED",), live_at=now, limit=50):
                    if visible(r) and r["subject_key"] not in {d["subject"] for d in disputed}:
                        d = {"subject": r["subject_key"], "note": "contradictory verified evidence - do not rely on it"}
                        t = tokens_of(json.dumps(d))
                        if len(disputed) < 3 and used + t <= token_budget:
                            used += t
                            disputed.append(d)
        self._bump("reads")
        self._bump("items_returned", len(out_f) + len(out_l))
        self._bump("tokens_served", used)
        block = "\n".join([*(i["text"] for i in out_l), *(i["text"] for i in out_f), *(f"! {d['subject']}: {d['note']}" for d in disputed)])
        return {"facts": out_f, "lessons": out_l, "disputed": disputed, "tokens": used if (out_f or out_l or disputed) else 0, "token_budget": token_budget,
                "truncated": truncated, "text": block, "digest": _h(block)[:12]}

    @staticmethod
    def _render(tag: str, r: Json) -> Json:
        if tag == "L":
            steps = " > ".join(f"{s.get('action', '?')}" + (f"@{s['target_role']}" if s.get("target_role") else "") for s in r["steps"])
            txt = f"[lesson {r['lesson_id']} r{r['revision']} c{r['confidence']:.2f} ok{r['success_count']}/fail{r['failure_count']}] {r['fault_kind']}/{r.get('asset_type') or '*'}: {steps}" \
                  + (f" -> {r['expected_outcome']}" if r["expected_outcome"] else "") + (f" if {json.dumps(r['preconditions'], sort_keys=True)}" if r["preconditions"] else "")
            return {"id": r["lesson_id"], "revision": r["revision"], "confidence": r["confidence"], "text": txt, "evidence_ids": r["evidence_ids"][:6], "run_ids": r["source_run_ids"][:4]}
        txt = f"[fact {r['fact_id']} r{r['revision']} c{r['confidence']:.2f}] {r['statement']}"
        return {"id": r["fact_id"], "revision": r["revision"], "confidence": r["confidence"], "text": txt, "evidence_ids": r["evidence_ids"][:6], "run_ids": r["source_run_ids"][:4]}

    # ───────────────────────── lifecycle ─────────────────────────
    def expire_sweep(self) -> int:
        now, n = self.clock(), 0
        for kind in ("fact", "lesson"):
            for r in self.store.select(kind, status_in=LIVE):
                if r["expires_ts"] is not None and r["expires_ts"] <= now:
                    self._set(kind, r, status="EXPIRED", status_reason="ttl")
                    n += 1
        if n:
            self._bump("expired", n)
        return n

    def invalidate(self, kind: str, item_id: str, revision: int, reason: str) -> bool:
        """A fact found to be wrong/stale (e.g. its sensor was recalibrated): stops being read immediately; the row is kept."""
        idk = "fact_id" if kind == "fact" else "lesson_id"
        r = self.store.get(kind, {idk: item_id, "revision": revision})
        if r is None or r["status"] in ("EXPIRED", "ARCHIVED", "REJECTED"):
            return False
        self._set(kind, r, status="EXPIRED", status_reason=f"invalidated: {_clean(reason, 120)}", expires_ts=self.clock())
        return True

    def compact(self, facility_id: str, *, older_than_s: float, delete: bool = False) -> Json:
        """Summarise terminal rows (REJECTED/EXPIRED/ARCHIVED-merged) older than the cutoff into ONE ARCHIVED summary row per subject that keeps links to
        the immutable events (event_refs) and the evidence/run ids; optionally prune the originals. Verified / live rows are never touched."""
        now, cutoff = self.clock(), self.clock() - older_than_s
        made, removed = 0, 0
        for kind, idk, sub in (("fact", "fact_id", "subject_key"), ("lesson", "lesson_id", "subject_key")):
            groups: dict[str, list[Json]] = {}
            for r in self.store.select(kind, eq={"facility_id": facility_id}, status_in=("REJECTED", "EXPIRED")):
                if r["updated_ts"] <= cutoff and not r[idk].startswith("sum_"):
                    groups.setdefault(r[sub], []).append(r)
            for subj, rows in groups.items():
                sid = "sum_" + _h(facility_id, kind, subj)[:14]
                with self.store.locked(f"{kind}:{sid}"):
                    prev = self.store.select(kind, eq={idk: sid})
                    rev = max([p["revision"] for p in prev] + [0]) + 1
                    by: Json = {}
                    for r in rows:
                        by[r["status"]] = by.get(r["status"], 0) + 1
                    refs = _merge([], [x for r in rows for x in r["event_refs"]], 50)
                    evs = _merge([], [x for r in rows for x in r["evidence_ids"]], 50)
                    runs = _merge([], [x for r in rows for x in r["source_run_ids"]], 50)
                    common = dict(facility_id=facility_id, run_id=rows[0]["run_id"], incident_id=None, topology_revision=None, evidence_ids=evs, source_run_ids=runs, event_refs=refs,
                                  confidence=0.0, status="ARCHIVED", status_reason=f"summary of {len(rows)} terminal revisions", visibility="run", proposed_by="memory.compact",
                                  verified_by=None, verification_ref=None, conflict_id=None, created_ts=now, updated_ts=now, expires_ts=None, subject_key=subj, preconditions={})
                    summ = {"counts": by, "n": len(rows), "items": [{"id": r[idk], "revision": r["revision"], "status": r["status"], "run_id": r["run_id"]} for r in rows[:50]],
                            "window": [min(r["created_ts"] for r in rows), max(r["updated_ts"] for r in rows)]}
                    if kind == "fact":
                        row = dict(common, fact_id=sid, revision=rev, fact_kind="summary", fault_kind=rows[0].get("fault_kind"), asset_type=rows[0].get("asset_type"), asset_id=None,
                                   statement=f"{len(rows)} terminal revisions of {subj} summarised", value=summ, value_hash=_h("sum", summ))
                    else:
                        row = dict(common, lesson_id=sid, revision=rev, fault_kind=rows[0]["fault_kind"], asset_type=rows[0].get("asset_type"), title=f"{len(rows)} terminal lessons summarised",
                                   steps=[], steps_hash=_h("sum", summ), expected_outcome=json.dumps(summ)[:400], success_count=0, failure_count=0)
                    self.store.insert(kind, row)
                    made += 1
                    if delete:
                        for r in rows:
                            removed += int(self.store.delete(kind, {idk: r[idk], "revision": r["revision"]}))
        return {"summaries": made, "pruned": removed}

    # ───────────────────────── playbooks (stretch) ─────────────────────────
    def propose_playbook(self, *, facility_id: str, fault_kind: str, doc: Json, lesson_refs: list[str], playbook_id: str | None = None) -> Json:
        pid = playbook_id or "pbk_" + _h(facility_id, fault_kind)[:12]
        now = self.clock()
        with self.store.locked(f"playbook:{pid}"):
            vs = self.store.select("playbook", eq={"playbook_id": pid})
            ver = max([v["version"] for v in vs] + [0]) + 1
            acc = [v for v in vs if v["status"] == "ACCEPTED"]
            row = dict(playbook_id=pid, version=ver, parent_version=max((v["version"] for v in acc), default=None), facility_id=facility_id, fault_kind=fault_kind, doc=doc,
                       lesson_refs=_ids(lesson_refs), status="CANDIDATE", evaluation=None, created_ts=now, updated_ts=now)
            self.store.insert("playbook", row)
        return row

    def decide_playbook(self, playbook_id: str, version: int, evaluation: Json, *, min_heldout: int = 10) -> Json:
        """Accept only on held-out evidence: >= min_heldout seeds, a real gain in verified completion, no rise in false-success. Otherwise reject
        honestly - the evaluation record is stored either way."""
        r = self.store.get("playbook", {"playbook_id": playbook_id, "version": version})
        if r is None or r["status"] != "CANDIDATE":
            raise MemoryRefusal("not_a_candidate", f"{playbook_id} v{version}")
        reasons = []
        if int(evaluation.get("heldout_n", 0)) < min_heldout:
            reasons.append(f"held-out n={evaluation.get('heldout_n', 0)} < {min_heldout}")
        if not (float(evaluation.get("delta_verified_completion", 0)) > 0):
            reasons.append("no gain in verified completion")
        if float(evaluation.get("false_success_on", 0)) > float(evaluation.get("false_success_off", 0)):
            reasons.append("false-success increased")
        status = "ACCEPTED" if not reasons else "REJECTED"
        ev = {**evaluation, "decision": status, "reasons": reasons}
        self.store.update("playbook", {"playbook_id": playbook_id, "version": version}, {"status": status, "evaluation": ev, "updated_ts": self.clock()})
        return {"status": status, "reasons": reasons}

    # ───────────────────────── helpers ─────────────────────────
    def _set(self, kind: str, row: Json, **ch: Any) -> None:
        idk = "fact_id" if kind == "fact" else "lesson_id"
        ch.setdefault("updated_ts", self.clock())
        self.store.update(kind, {idk: row[idk], "revision": row["revision"]}, ch)
        row.update(ch)
