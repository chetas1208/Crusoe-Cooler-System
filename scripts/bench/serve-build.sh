#!/usr/bin/env bash
# Build the web app (production, embedded TS mock) into a throwaway dir and serve it with vite preview.
# usage: scripts/bench/serve-build.sh <outDir> <port>     (VITE_API_URL is forced empty -> embedded simulator)
set -euo pipefail
OUT=${1:?outDir}; PORT=${2:-5184}
cd "$(dirname "$0")/../../apps/web"
VITE_API_URL= npx vite build --outDir "$OUT" --emptyOutDir 2>&1 | tail -12
exec npx vite preview --outDir "$OUT" --host 127.0.0.1 --port "$PORT" --strictPort
