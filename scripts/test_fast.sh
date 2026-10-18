#!/usr/bin/env bash
# Fast backend suite: everything except tests marked `slow` (long real-plant agent loops), run in parallel with pytest-xdist.
# Serialised with the other agents' runs through the same FIFO lock as scripts/pytest_locked.sh.
# Usage: scripts/test_fast.sh [extra pytest args]     env: TEST_WORKERS=<n> (default min(12, cores))
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N="${TEST_WORKERS:-$(( $(nproc) < 12 ? $(nproc) : 12 ))}"
if [ "${LOOPKEEPER_LOCK_HELD:-0}" != "1" ]; then exec 9>/tmp/loopkeeper-pytest.lock; flock 9; fi   # LOOPKEEPER_LOCK_HELD=1: caller already holds the FIFO lock
cd "$ROOT/backend" && exec env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  "$HOME/.local/bin/uv" run --with pytest-xdist pytest -p no:cacheprovider -m "not slow" -n "$N" --dist loadgroup -q --durations=15 "$@"
