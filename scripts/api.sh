#!/usr/bin/env bash
# The API process only (stdout/stderr are captured and rotated by supervise.sh -> logpipe.py; run it by hand to see logs on the terminal).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export LOOPKEEPER_STATE_DIR="${LOOPKEEPER_STATE_DIR:-${STATE_DIR:-$ROOT/.state}}"
exec "$ROOT/backend/.venv/bin/python" -m loopkeeper.api
