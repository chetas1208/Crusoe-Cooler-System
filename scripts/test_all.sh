#!/usr/bin/env bash
# Whole backend suite (fast + slow) in parallel with pytest-xdist. Lead-only per docs/engineering/V12_COORDINATION.md.
# Usage: scripts/test_all.sh [extra pytest args]     env: TEST_WORKERS=<n> (default min(16, cores)); TEST_SERIAL=1 -> no xdist
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N="${TEST_WORKERS:-$(( $(nproc) < 16 ? $(nproc) : 16 ))}"
. "$ROOT/scripts/test_lock.sh"
cd "$ROOT/backend"
if [ "${TEST_SERIAL:-0}" = "1" ]; then exec "$HOME/.local/bin/uv" run pytest -p no:cacheprovider -q --durations=25 "$@"; fi
exec env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  "$HOME/.local/bin/uv" run --with pytest-xdist pytest -p no:cacheprovider -n "$N" --dist loadgroup -q --durations=25 "$@"
