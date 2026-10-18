#!/usr/bin/env bash
# Fast backend suite: everything except tests marked `slow` (long real-plant agent loops), run in parallel with pytest-xdist.
# Takes a slot of the same shared lock as scripts/pytest_locked.sh (scripts/test_lock.sh).
# Usage: scripts/test_fast.sh [extra pytest args]     env: TEST_WORKERS=<n> (default min(12, cores))
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N="${TEST_WORKERS:-$(( $(nproc) < 12 ? $(nproc) : 12 ))}"
. "$ROOT/scripts/test_lock.sh"
cd "$ROOT/backend" && exec env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  "$HOME/.local/bin/uv" run --with pytest-xdist pytest -p no:cacheprovider -m "not slow" -n "$N" --dist loadgroup -q --durations=15 "$@"
