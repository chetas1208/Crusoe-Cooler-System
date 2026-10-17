"""Per-model capability probe (real, tiny requests): tools, response_format json_object / json_schema, structured_outputs, seed determinism,
reasoning controls. `python -m loopkeeper.inference.probe [model ...]` -> artifacts/v11/capability_probe.json + catalog snapshot."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

from .catalog import now_iso
from .config import GatewayConfig
from .gateway import ModelGateway

Json = dict[str, Any]
ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / "artifacts" / "v11"
SCHEMA = {"type": "object", "properties": {"action": {"type": "string", "enum": ["isolate", "brush", "replace"]}, "asset": {"type": "string"}}, "required": ["action", "asset"], "additionalProperties": False}
MSG = [{"role": "system", "content": "Reply with JSON only."}, {"role": "user", "content": 'Choose action "isolate" for asset "valve_a2" and answer as {"action":..., "asset":...}.'}]
TOOLS = [{"type": "function", "function": {"name": "isolate_valve", "description": "Isolate a valve", "parameters": {"type": "object", "properties": {"valve_id": {"type": "string"}}, "required": ["valve_id"]}}}]


async def _post(gw: ModelGateway, body: Json) -> tuple[int, Json, float]:
    t0 = time.perf_counter()
    r = await gw._client().post("/chat/completions", json=body)
    try:
        d = r.json()
    except Exception:  # noqa: BLE001
        d = {}
    return r.status_code, d, time.perf_counter() - t0


def _msg(d: Json) -> Json:
    try:
        return d["choices"][0]["message"]
    except Exception:  # noqa: BLE001
        return {}


def _ok_json(text: str | None) -> bool:
    try:
        o = json.loads(text or "")
        return isinstance(o, dict) and o.get("action") == "isolate"
    except Exception:  # noqa: BLE001
        return False


async def probe_model(gw: ModelGateway, model: str) -> Json:
    base: Json = {"model": model, "messages": MSG, "max_tokens": 120, "temperature": 0.0, "chat_template_kwargs": {"enable_thinking": False}}
    res: Json = {"model": model, "tests": {}}
    tests = res["tests"]
    tokens = 0

    async def run(name: str, body: Json, check) -> Json:
        nonlocal tokens
        try:
            st, d, lat = await _post(gw, body)
        except Exception as e:  # noqa: BLE001
            tests[name] = {"ok": False, "error": type(e).__name__}
            return {}
        u = d.get("usage") or {}
        tokens += (u.get("prompt_tokens") or 0) + (u.get("completion_tokens") or 0)
        m = _msg(d)
        tests[name] = {"http": st, "ok": bool(st == 200 and check(m, d)), "latency_s": round(lat, 2), "tokens_out": u.get("completion_tokens")}
        if st != 200:
            tests[name]["error"] = str((d.get("error") or {}).get("message") if isinstance(d.get("error"), dict) else d.get("error") or d)[:160]
        return m

    await run("plain_thinking_off", base, lambda m, d: _ok_json(m.get("content")))
    await run("response_format_json_object", {**base, "response_format": {"type": "json_object"}}, lambda m, d: _ok_json(m.get("content")))
    await run("response_format_json_schema", {**base, "response_format": {"type": "json_schema", "json_schema": {"name": "act", "schema": SCHEMA, "strict": True}}}, lambda m, d: _ok_json(m.get("content")))
    await run("structured_outputs_json", {**base, "structured_outputs": {"json": SCHEMA}}, lambda m, d: _ok_json(m.get("content")))
    tb = {**base, "messages": [{"role": "user", "content": "Isolate valve valve_a2 using the tool."}], "tools": TOOLS, "tool_choice": "auto", "max_tokens": 200}
    await run("tools", tb, lambda m, d: bool(m.get("tool_calls")) and "valve_a2" in json.dumps(m["tool_calls"]))
    # seed determinism at temperature > 0
    outs = []
    for _ in range(2):
        m = await run("seed_probe", {**base, "temperature": 0.9, "seed": 1234, "max_tokens": 40, "messages": [{"role": "user", "content": "Write one short sentence about pumps."}]}, lambda m, d: bool(m.get("content")))
        outs.append(m.get("content"))
    tests["seed_determinism"] = {"ok": bool(outs[0]) and outs[0] == outs[1], "note": "same seed, temperature 0.9, two calls compared"}
    # reasoning controls
    m_off = await run("thinking_off_content", {**base, "max_tokens": 80}, lambda m, d: bool(m.get("content")))
    m_on = await run("thinking_on_small_budget", {**base, "chat_template_kwargs": {"enable_thinking": True}, "max_tokens": 120}, lambda m, d: True)
    tests["thinking_on_small_budget"].update({"content_empty": not (m_on.get("content") or "").strip(), "has_reasoning_field": any(k in m_on for k in ("reasoning_content", "reasoning"))})
    tests["thinking_off_content"]["has_reasoning_field"] = any(bool(m_off.get(k)) for k in ("reasoning_content", "reasoning"))
    res["caps"] = {
        "tools": tests["tools"]["ok"], "json_object": tests["response_format_json_object"]["ok"], "json_schema": tests["response_format_json_schema"]["ok"],
        "structured_outputs": tests["structured_outputs_json"]["ok"], "seed": tests["seed_determinism"]["ok"],
        "thinking_toggle": tests["thinking_off_content"]["ok"] and not tests["thinking_off_content"]["has_reasoning_field"],
        "thinking_on_empty_at_small_budget": tests["thinking_on_small_budget"].get("content_empty")}
    res["probe_tokens"] = tokens
    return res


async def main(models: list[str]) -> Json:
    cfg = GatewayConfig.from_env()
    if not cfg.configured:
        raise SystemExit("CRUSOE_API_KEY not set")
    gw = ModelGateway(cfg, run_id="probe", catalog_path=OUT / "model_catalog.json")
    cat = await gw.start()
    models = models or sorted(set(cfg.models.values()))
    out: Json = {"probed_at": now_iso(), "base_host": cat.base_host, "catalog_date": cat.fetched_at, "models": {}}
    spend = 0.0
    for m in models:
        r = await probe_model(gw, m)
        info = cat.get(m)
        r["catalog"] = {"context_length": info.context_length, "supported_parameters": info.supported_parameters, "price_in_per_mtok": info.price_in_per_mtok, "price_out_per_mtok": info.price_out_per_mtok} if info else None
        if info and info.price_in_per_mtok is not None:
            r["probe_cost_usd_est"] = round(r["probe_tokens"] * max(info.price_in_per_mtok, info.price_out_per_mtok or 0) / 1e6, 6)   # upper bound
            spend += r["probe_cost_usd_est"]
        out["models"][m] = r
    out["probe_spend_usd_upper_bound"] = round(spend, 5)
    await gw.aclose()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "capability_probe.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    return out


if __name__ == "__main__":
    # .env is loaded by the caller (set -a; . ../.env) or by loopkeeper.intelligence.crusoe.load_dotenv_file
    res = asyncio.run(main(sys.argv[1:]))
    print(json.dumps({m: {"caps": r["caps"], "latency_s": {k: v.get("latency_s") for k, v in r["tests"].items() if isinstance(v, dict)}} for m, r in res["models"].items()}, indent=1))
