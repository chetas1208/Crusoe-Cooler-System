#!/usr/bin/env python3
"""Render artifacts/soak/*.json into the run table of docs/engineering/V12_SOAK_REPORT.md (between the RUNS markers). Numbers only, copied from the JSON.
Usage: python3 scripts/soak/ledger.py            (rewrites the table in place)"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs" / "engineering" / "V12_SOAK_REPORT.md"
BEGIN, END = "<!-- RUNS:BEGIN -->", "<!-- RUNS:END -->"


def row(r: dict) -> str:
    m, inc = r["metrics"], r["incidents"]
    db, mod = r["db"], r["model"]
    viol = {}
    for v in r["violations"]:
        viol[v["invariant"]] = viol.get(v["invariant"], 0) + 1
    vs = ", ".join(f"{k} x{n}" for k, n in sorted(viol.items())) or "none"
    return (f"| {r['scenario']} | {r['seed']} | {r['storage']} | {r['sim_hours']} | {m.get('wall_s', '?')} | {m['faults_accepted']}/{m['faults_injected']} | {m['restarts']} | "
            f"{m['model_outage_windows']} / {mod['calls']} calls ({mod['503'] + mod['429'] + mod['timeout']} err, {mod['garbage']} garbage, {mod['slow']} slow) | "
            f"{m['db_windows']} / {db['failed']} fail, {db['ack_lost']} ack-lost | {m['leases_taken']} | {m['burst_cmds']} | {inc['total']} ({inc['by_status']}) | "
            f"{m.get('rss_mb_start', '?')}->{m.get('rss_mb_end', '?')} | {r['violation_count']} ({vs}) |")


def main() -> None:
    rows = []
    for p in sorted((ROOT / "artifacts" / "soak").glob("*.json")):
        try:
            rows.append((json.loads(p.read_text()), p))
        except Exception:                                                # noqa: BLE001
            continue
    hdr = ("| scenario | seed | store | sim h | wall s | faults acc/inj | restarts | model windows / calls | db windows / failures | leases | burst cmds | incidents | RSS MB | violations |\n"
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    table = hdr + "\n" + "\n".join(row(r) for r, _ in rows)
    txt = DOC.read_text()
    new = re.sub(re.escape(BEGIN) + ".*?" + re.escape(END), BEGIN + "\n" + table + "\n" + END, txt, flags=re.S)
    DOC.write_text(new)
    print(f"{len(rows)} runs rendered")


if __name__ == "__main__":
    main()
