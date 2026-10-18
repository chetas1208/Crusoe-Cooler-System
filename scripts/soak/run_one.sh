#!/usr/bin/env bash
# Serialised via the shared pytest lock (one heavy backend job at a time). Usage: scripts/soak/run_one.sh <scenario> [seed] [sim_hours]
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec 9>/tmp/loopkeeper-pytest.lock
flock 9
cd "$ROOT/backend" && exec "$HOME/.local/bin/uv" run python "$ROOT/scripts/soak/run_one.py" "$@"
