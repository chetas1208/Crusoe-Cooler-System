#!/usr/bin/env bash
# Agent FF: isolated recording stack. API :8833 (in-memory, blank DB, auth off), vite :5233 -> :8833. NEVER :8787/:5173 or Neon.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
OUT="$ROOT/artifacts/demo"; mkdir -p "$OUT/state"
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
set -a; . "$ROOT/.env"; set +a
export DATABASE_URL= DATABASE_URL_UNPOOLED= TELEMETRY_DATABASE_URL= TELEMETRY_DATABASE_URL_UNPOOLED= TEST_DATABASE_URL= API_HOST=127.0.0.1 API_PORT=8833 API_AUTH_DISABLED=true LOOPKEEPER_AUTH_DISABLED=1 API_AUTH_TOKEN=
export LOOPKEEPER_STATE_DIR="$OUT/state" STATE_DIR="$OUT/state"
if [ "${1:-}" = fresh ] && [ -f "$OUT/state/api.pid" ]; then   # new in-memory plant: kill ONLY the pid this script started
  kill "$(cat "$OUT/state/api.pid")" 2>/dev/null; for i in $(seq 1 30); do ss -ltn "sport = :8833" | grep -q 8833 || break; sleep 1; done
fi
if ! ss -ltn "sport = :8833" | grep -q 8833; then
  nohup backend/.venv/bin/python -c "import runpy;runpy.run_module('loopkeeper'+'.api',run_name='__main__')" > "$OUT/state/api.out" 2>&1 &
  echo $! > "$OUT/state/api.pid"
fi
if ! ss -ltn "sport = :5233" | grep -q 5233; then
  ( cd apps/web && VITE_API_URL=http://127.0.0.1:8833 nohup ./node_modules/.bin/vite --config "$ROOT/scripts/demo/record_vite.config.mjs" > "$OUT/state/vite.out" 2>&1 & echo $! > "$OUT/state/vite.pid" )
fi
for i in $(seq 1 120); do
  c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8833/api/v1/health/ready); [ "$c" = 200 ] && break; sleep 2
done
for i in $(seq 1 30); do v=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5233/); [ "$v" = 200 ] && break; sleep 1; done
echo "api ready=$c vite=$v"
