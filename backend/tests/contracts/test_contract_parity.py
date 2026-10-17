"""Pydantic models <-> packages/core/src/contracts.ts parity.

contracts.golden.json is produced from the real TypeScript AST by scripts/extract_contract.mjs. These tests compare
names, optionality, literal enums, primitive/ref kinds and nested inline objects; `test_golden_is_fresh` fails if
contracts.ts changed without regenerating the golden (when node is available).
"""
import json
import re
import shutil
import subprocess
import types
import typing
from pathlib import Path

import pytest
from pydantic import BaseModel, TypeAdapter

from loopkeeper.api import models as M
from loopkeeper.api import models_control as MC
from loopkeeper.api import models_runs as MR

ROOT = Path(__file__).resolve().parents[3]
GOLDEN = json.loads((Path(__file__).parent / "contracts.golden.json").read_text())
IFACES, ALIASES = GOLDEN["interfaces"], GOLDEN["aliases"]
FIX = Path(__file__).resolve().parents[1] / "fixtures"

# TS fields whose TS type is intentionally looser/different on the Python side (documented, reviewed).
OVERRIDES = {
    ("WorldDiffPayload", "assets"): "Partial<AssetState> patches kept as dicts",
    ("ReplayPage", "events"): "StreamEvent[] validated per-type in test_events_validate_against_models",
    ("EventBase", "payload"): "generic",
    ("ReplayWindow", "events"): "RecordedEvent[] (= StreamEvent[]) validated per-type in test_events_validate_against_models",
    ("ScenarioValidateRequest", "spec"): "unknown on the wire; validated against ScenarioSpec by the route",
    ("ApiProblem", "detail"): "unknown",
    ("EventBase", "type"): "generic (T); the union members are checked in test_event_envelope_and_payloads",
}


# ── normalisation ─────────────────────────────────────────────────────────
def split_top(s: str, sep: str) -> list[str]:
    out, depth, cur, q = [], 0, "", None
    for ch in s:
        if q:
            cur += ch
            q = None if ch == q else q
            continue
        if ch in "'\"":
            q = ch
        elif ch in "<[({":
            depth += 1
        elif ch in ">])}":
            depth -= 1
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [p.strip() for p in out if p.strip()]


def norm(t: str) -> str:
    t = t.strip()
    t = re.sub(r"Exclude<(\w+), never>", r"\1", t)  # ScenarioFaultKind = Exclude<FaultKind, never>
    parts = split_top(t, "|")
    if len(parts) > 1:
        items = sorted({norm(p) for p in parts if p != "null"})
        return " | ".join(items) if len(items) > 1 else items[0]
    if t.startswith("(") and t.endswith(")"):
        return norm(t[1:-1])
    if t.endswith("[]"):
        inner = norm(t[:-2])
        return f"({inner})[]" if "|" in inner else f"{inner}[]"
    m = re.fullmatch(r"(\w+)<(.*)>", t)
    if m:
        name, args = m.groups()
        if name == "Array":
            inner = norm(args)
            return f"({inner})[]" if "|" in inner else f"{inner}[]"
        return f"{name}<{', '.join(norm(a) for a in split_top(args, ','))}>"
    if t.startswith("[") and t.endswith("]"):
        return "[" + ", ".join(norm(a) for a in split_top(t[1:-1], ",")) + "]"
    return {"EntityId": "string", "unknown": "any"}.get(t, t)


def expand(t: str) -> str:
    """Replace literal-union aliases (e.g. LoopId, FaultKind | 'unknown') by their literal members."""
    parts = split_top(t, "|") if "|" in t else [t]
    out: set[str] = set()
    for p in parts:
        a = ALIASES.get(p)
        a = norm(a) if a is not None else None
        if a is not None and all(re.fullmatch(r"'[^']*'|\w+", x) for x in split_top(a, "|")) and p not in ("EventType",):
            out |= set(split_top(norm(expand(norm(a))), "|"))
        else:
            out.add(p)
    if "string" in out:  # `ControlReason | string` is just string
        out = {"string"}
    return " | ".join(sorted(out))


def py_sig(ann) -> str:
    origin = typing.get_origin(ann)
    args = typing.get_args(ann)
    if ann is str:
        return "string"
    if ann in (int, float):
        return "number"
    if ann is bool:
        return "boolean"
    if ann is typing.Any:
        return "any"
    if origin is typing.Literal:
        def lit(a):
            if isinstance(a, bool):
                return "true" if a else "false"
            return str(a) if isinstance(a, int) else f"'{a}'"
        return " | ".join(sorted(lit(a) for a in args))
    if origin in (typing.Union, types.UnionType):
        items: set[str] = set()
        for a in args:
            if a is type(None):
                continue
            items |= set(split_top(py_sig(a), "|"))
        return " | ".join(sorted(items))
    if origin in (list,):
        inner = py_sig(args[0])
        return f"({inner})[]" if "|" in inner else f"{inner}[]"
    if origin is tuple:
        if args == (float, float, float):
            return "Vec3"
        return "[" + ", ".join(py_sig(a) for a in args) + "]"
    if origin is dict:
        return f"Record<{py_sig(args[0])}, {py_sig(args[1])}>"
    if isinstance(ann, type) and issubclass(ann, BaseModel):
        return ann.__name__
    raise AssertionError(f"unmapped annotation {ann!r}")


def unwrap_model(ann):
    origin, args = typing.get_origin(ann), typing.get_args(ann)
    if origin in (typing.Union, types.UnionType):
        ann = next(a for a in args if a is not type(None))
        return unwrap_model(ann)
    if origin is list:
        return unwrap_model(args[0])
    return ann if isinstance(ann, type) and issubclass(ann, BaseModel) else None


def compare_fields(label: str, ts_fields: dict, model: type[BaseModel], skip_types: bool = False) -> None:
    py = {(f.alias or n): f for n, f in model.model_fields.items()}
    # fields declared on the Wire base / discriminator subclasses are fine; contract fields must all exist
    missing = set(ts_fields) - set(py)
    assert not missing, f"{label}: python model lacks {sorted(missing)}"
    extra = set(py) - set(ts_fields)
    assert not extra, f"{label}: python model has non-contract fields {sorted(extra)}"
    for name, ts in ts_fields.items():
        f = py[name]
        where = f"{label}.{name}"
        assert (not f.is_required()) == ts["optional"], f"{where}: optionality differs (ts optional={ts['optional']})"
        if (label.split('.')[0], name) in OVERRIDES or skip_types:
            continue
        if "members" in ts:
            sub = unwrap_model(f.annotation)
            assert sub is not None, f"{where}: ts inline object but python is not a model"
            compare_fields(where, ts["members"], sub)
            continue
        a, b = expand(norm(ts["type"])), expand(py_sig(f.annotation))
        assert a == b, f"{where}: ts `{a}` != python `{b}`"


# ── tests ────────────────────────────────────────────────────────────────
ALL_MODELS = {**M.CONTRACT_MODELS, **MC.CONTROL_CONTRACT_MODELS, **MR.RUNS_CONTRACT_MODELS}


@pytest.mark.parametrize("name", sorted(ALL_MODELS))
def test_model_matches_contract(name):
    assert name in IFACES, f"{name} is not an interface in contracts.ts / contracts.control.ts / runs/types.ts"
    compare_fields(name, IFACES[name]["fields"], ALL_MODELS[name])


def test_every_contract_interface_has_a_model():
    ignore = {"EventBase"}  # generic envelope, compared separately below
    missing = set(IFACES) - ignore - set(ALL_MODELS)
    assert not missing, f"no python model for {sorted(missing)}"


def test_control_status_codes_match():
    assert GOLDEN["http_status_for_code"] == MC.HTTP_STATUS_FOR_CODE


def test_response_unions_covered():
    # LeaseResponse = LeaseGrant | ControlRefusal etc.: both halves are modelled
    for alias, parts in (("LeaseResponse", {"LeaseGrant", "ControlRefusal"}), ("DriveResponse", {"DriveAck", "ControlRefusal"}),
                         ("ReleaseResponse", {"ReleaseAck", "ControlRefusal"})):
        assert set(split_top(ALIASES[alias].lstrip("| "), "|")) == parts
    assert "expires_in_ms" in ALIASES["HeartbeatResponse"] and "expires_in_ms" in MC.HeartbeatAck.model_fields


def test_event_envelope_and_payloads():
    base = IFACES["EventBase"]["fields"]
    envelope = {k: v for k, v in base.items()}
    compare_fields("EventBase", envelope, M.EventBase)
    members = re.findall(r"EventBase<'([^']+)', ([^>]+?)>(?: \||$)", ALIASES["StreamEvent"] + " |")
    assert {t for t, _ in members} == set(M.EVENT_CLASSES), (members,)
    assert {t for t, _ in members} == set(M.EVENT_CLASSES), "StreamEvent union members differ from python event classes"
    for typ, payload in members:
        cls = M.EVENT_CLASSES[typ]
        pf = cls.model_fields["payload"].annotation
        if payload.startswith("{"):
            ts_members = {m.group(1): m.group(2) for m in re.finditer(r"(\w+): ([^;}]+)", payload)}
            assert set(ts_members) == set(pf.model_fields) - set(), f"{typ} payload members"
        else:
            assert pf.__name__ == payload, f"{typ}: payload {pf.__name__} != {payload}"


def test_event_type_alias_matches():
    ts = set(re.findall(r"'([^']+)'", ALIASES["EventType"]))
    assert ts == set(typing.get_args(M.EventType))
    assert not (set(typing.get_args(M.ExtendedEventType)) & ts)


@pytest.mark.parametrize("alias", ["ControlAuthority", "ControllerState", "ControlReason", "ControlErrorCode", "ToolAction",
                                   "ControlEventKind", "RunKind", "RunState", "RunMode", "ApiProblemCode", "IssueSeverity",
                                   "LoopId", "PipeRole", "AssetType", "SimStatus", "Severity", "AssetStatus", "RobotClass",
                                   "RobotMode", "IncidentStage", "IncidentStatus", "FaultKind", "AgentRole",
                                   "AgentTaskStatus", "CommandKind"])
def test_enum_aliases_match(alias):
    mod = next(m for m in (M, MC, MR) if hasattr(m, alias))
    assert expand(norm(ALIASES[alias])) == py_sig(getattr(mod, alias)), alias


def test_reading_units_and_constants_match():
    ts = {k: v["unit"] for k, v in GOLDEN["reading_meta"].items()}
    assert ts == M.READING_UNITS
    assert GOLDEN["arrays"]["SEVERITY_ORDER"] == M.SEVERITY_ORDER
    assert GOLDEN["arrays"]["STAGES"] == M.STAGES


def test_command_request_forbids_unknown_fields():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        M.CommandRequest(command_id="a", kind="pause", is_admin=True)


def test_fixtures_from_ts_engine_validate_and_roundtrip():
    """Real payloads produced by the TS reference engine validate AND survive Python round-trip unchanged."""
    topo = json.loads((FIX / "topology.json").read_text())
    world = json.loads((FIX / "world.json").read_text())
    for model, payload in ((M.Topology, topo), (M.WorldSnapshot, world)):
        out = model.model_validate(payload).model_dump(mode="json", exclude_unset=True, by_alias=True)
        assert out == payload


def test_events_validate_against_models():
    ta = TypeAdapter(M.StreamEvent)
    events = json.loads((FIX / "events.json").read_text())
    seen = set()
    for e in events:
        out = ta.validate_python(e).model_dump(mode="json", exclude_unset=True, by_alias=True)
        assert out == e
        seen.add(e["type"])
    assert {"agent.task", "agent.tool", "incident.opened", "verification.result", "mission.transition"} <= seen


@pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "node_modules" / "typescript").exists(), reason="node/typescript not available")
def test_golden_is_fresh():
    out = subprocess.run(["node", str(ROOT / "backend" / "scripts" / "extract_contract.mjs")], capture_output=True, text=True, check=True, cwd=ROOT)
    assert json.loads(out.stdout) == GOLDEN, "contracts.ts changed: run `node backend/scripts/extract_contract.mjs --write`, then fix the models"
