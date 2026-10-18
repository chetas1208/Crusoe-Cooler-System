#!/usr/bin/env bash
# Runs every soak scenario SEQUENTIALLY, one pytest-lock acquisition per scenario (never holds the lock across scenarios).
# Usage: scripts/soak/run_all.sh [seed] [sim_hours] [scenario ...]      logs -> artifacts/soak/logs/<scenario>_<seed>.log
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEED="${1:-11}"; HOURS="${2:-1.0}"; shift 2 2>/dev/null || true
SCENARIOS=("$@"); [ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(faults restarts outages dbfail leases concurrent spend hostile everything postgres)
mkdir -p "$ROOT/artifacts/soak/logs"
rc=0
for s in "${SCENARIOS[@]}"; do
  "$ROOT/scripts/soak/run_one.sh" "$s" "$SEED" "$HOURS" > "$ROOT/artifacts/soak/logs/${s}_${SEED}.log" 2>&1
  code=$?; [ $code -ne 0 ] && rc=1
  echo "$s seed=$SEED hours=$HOURS exit=$code -> artifacts/soak/logs/${s}_${SEED}.log"
done
exit $rc
