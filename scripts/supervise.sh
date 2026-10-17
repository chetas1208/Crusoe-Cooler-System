#!/usr/bin/env bash
# Keeps the API and the tunnel alive (restart on exit, back-off on crash loops). Safe to re-run: no-op if running.
#   scripts/supervise.sh start [api|tunnel|all]
#   scripts/supervise.sh stop [api|tunnel|all]
#   scripts/supervise.sh restart [api|tunnel|all]
#   scripts/supervise.sh status
#   scripts/supervise.sh url
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f "$ROOT/.env" ] && { set -a; . "$ROOT/.env"; set +a; }
STATE="$ROOT/.state"; mkdir -p "$STATE"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"

# Ensure convenient symlinks in logs/
[ -e "$LOGS/tunnel.log" ] || ln -sf "$STATE/tunnel.log" "$LOGS/tunnel.log" 2>/dev/null || true
[ -e "$LOGS/api.log" ] || ln -sf "$STATE/api.out" "$LOGS/api.log" 2>/dev/null || true
[ -e "$LOGS/backend.log" ] || ln -sf "$STATE/api.out" "$LOGS/backend.log" 2>/dev/null || true

loop() { # name, command...
  local name="$1"; shift; local fails=0
  while true; do
    local t0=$(date +%s)
    "$@" >> "$STATE/$name.out" 2>&1
    local dt=$(( $(date +%s) - t0 ))
    [ $dt -lt 20 ] && fails=$((fails+1)) || fails=0
    sleep $(( fails > 5 ? 30 : 2 ))
  done
}

alive() { [ -f "$STATE/$1.sup.pid" ] && kill -0 "$(cat "$STATE/$1.sup.pid")" 2>/dev/null; }

start_api() {
  if ! alive api; then
    nohup setsid bash -c "echo \$\$ > '$STATE/api.sup.pid'; $(declare -f loop); STATE='$STATE'; loop api '$ROOT/scripts/api.sh'" </dev/null >/dev/null 2>&1 &
    sleep 0.5
    echo "api supervisor started (logs in logs/api.log)"
  else
    echo "api supervisor already running"
  fi
}

start_tunnel() {
  if ! alive tunnel; then
    nohup setsid bash -c "echo \$\$ > '$STATE/tunnel.sup.pid'; $(declare -f loop); STATE='$STATE'; loop tunnel '$ROOT/scripts/tunnel.sh'" </dev/null >/dev/null 2>&1 &
    sleep 0.5
    echo "tunnel supervisor started (logs in logs/tunnel.log)"
  else
    echo "tunnel supervisor already running"
  fi
}

stop_api() {
  if [ -f "$STATE/api.sup.pid" ]; then
    kill -- -"$(cat "$STATE/api.sup.pid")" 2>/dev/null || kill "$(cat "$STATE/api.sup.pid")" 2>/dev/null || true
    rm -f "$STATE/api.sup.pid"
  fi
  pkill -f "loopkeeper.api" 2>/dev/null || true
  pkill -f "scripts/api.sh" 2>/dev/null || true
  echo "api server stopped"
}

stop_tunnel() {
  if [ -f "$STATE/tunnel.sup.pid" ]; then
    kill -- -"$(cat "$STATE/tunnel.sup.pid")" 2>/dev/null || kill "$(cat "$STATE/tunnel.sup.pid")" 2>/dev/null || true
    rm -f "$STATE/tunnel.sup.pid"
  fi
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  echo "tunnel stopped"
}

ACTION="${1:-status}"
TARGET="${2:-all}"

case "$ACTION" in
  start)
    case "$TARGET" in
      api) start_api ;;
      tunnel) start_tunnel ;;
      all|"") start_api; start_tunnel ;;
      *) echo "Usage: $0 start [api|tunnel|all]" >&2; exit 1 ;;
    esac
    ;;
  stop)
    case "$TARGET" in
      api) stop_api ;;
      tunnel) stop_tunnel ;;
      all|"") stop_api; stop_tunnel ;;
      *) echo "Usage: $0 stop [api|tunnel|all]" >&2; exit 1 ;;
    esac
    ;;
  restart)
    case "$TARGET" in
      api) stop_api; sleep 1; start_api ;;
      tunnel) stop_tunnel; sleep 1; start_tunnel ;;
      all|"") stop_api; stop_tunnel; sleep 1; start_api; start_tunnel ;;
      *) echo "Usage: $0 restart [api|tunnel|all]" >&2; exit 1 ;;
    esac
    ;;
  url)
    cat "$STATE/tunnel_url" 2>/dev/null || { echo "no tunnel yet" >&2; exit 1; }
    ;;
  status)
    echo "=== LOOPKEEPER SERVICES STATUS ==="
    if curl -fsS -m 3 "http://127.0.0.1:${API_PORT:-8787}/api/v1/health/live" >/dev/null 2>&1; then
      echo "  API:    RUNNING (http://127.0.0.1:${API_PORT:-8787}) [PID: $(pgrep -f 'loopkeeper.api' | tr '\n' ' ')]"
    else
      echo "  API:    STOPPED"
    fi
    if pgrep -f 'cloudflared tunnel --url' >/dev/null 2>&1 && [ -f "$STATE/tunnel_url" ]; then
      echo "  Tunnel: RUNNING ($(cat "$STATE/tunnel_url")) [PID: $(pgrep -f 'cloudflared tunnel --url' | tr '\n' ' ')]"
    else
      echo "  Tunnel: STOPPED"
    fi
    echo "  Logs:   $LOGS/api.log, $LOGS/tunnel.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|url} [api|tunnel|all]" >&2
    exit 1
    ;;
esac
