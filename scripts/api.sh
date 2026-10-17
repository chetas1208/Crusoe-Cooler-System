#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.state"; mkdir -p "$STATE"
LOG="$STATE/api.out"
echo "--- API server started at $(date -u '+%Y-%m-%d %H:%M:%SZ') ---" >> "$LOG"
exec "$ROOT/backend/.venv/bin/python" -m loopkeeper.api
