#!/usr/bin/env python3
"""Run ONE named soak scenario outside pytest and print / save the result. Usage (serialised with the other agents):
   scripts/soak/run_one.sh <scenario> [seed] [sim_hours]       e.g.  scripts/soak/run_one.sh everything 7 1.0
Scenarios: faults restarts outages dbfail leases concurrent spend hostile everything determinism."""
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "backend" / "tests" / "soak"), str(ROOT / "backend" / "src")]
os.environ.setdefault("LOOPKEEPER_LAYA_ROUTER", "0")

import logging  # noqa: E402

if not os.environ.get("SOAK_LOG"):
    logging.disable(logging.WARNING)
from scenarios import build  # noqa: E402
from soak_lib import run_soak, write_result  # noqa: E402


def main() -> int:
    name = sys.argv[1]
    if len(sys.argv) > 2:
        os.environ["SOAK_SEED"] = sys.argv[2]
    if len(sys.argv) > 3:
        os.environ["SOAK_SIM_HOURS"] = sys.argv[3]
    over = {}
    srv = None
    if name == "postgres":                                  # embedded Postgres (pgserver) in a temp dir: no network, never production
        import tempfile

        import pgserver
        srv = pgserver.get_server(tempfile.mkdtemp(prefix="soak_pg_"))
        over = {"storage": "postgres", "pg_url": srv.get_uri()}
    try:
        res = asyncio.run(run_soak(build(name, **over)))
    finally:
        if srv is not None:
            srv.cleanup()
    p = write_result(res)
    print(json.dumps({k: res[k] for k in ("scenario", "seed", "sim_hours", "incidents", "model", "db", "violation_count", "violations")}, indent=1, default=str)[:6000])
    print("metrics:", json.dumps(res["metrics"], default=str)[:1500])
    print("wrote", p)
    return 1 if res["violation_count"] else 0


if __name__ == "__main__":
    sys.exit(main())
