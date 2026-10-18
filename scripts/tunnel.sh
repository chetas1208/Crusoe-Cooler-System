#!/usr/bin/env bash
# Cloudflare quick tunnel -> local API, tuned for a high-frequency WebSocket stream.
#   QUIC (UDP) transport = lowest latency; falls back to HTTP/2 if UDP egress is blocked.
#   4 HA connections to the edge. The real URL comes from cloudflared's own metrics endpoint (/quicktunnel) and is written to
#   $STATE_DIR/tunnel_url; supervise.sh's monitor re-checks it every 10 s, so a changed URL is picked up too.
# Quick tunnels get a NEW random *.trycloudflare.com URL on every start (no account, no SLA).
# Env: API_PORT, TUNNEL_PROTOCOL, TUNNEL_METRICS_PORT, CLOUDFLARED_BIN, STATE_DIR (all set by supervise.sh).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STATE_DIR:-$ROOT/.state}"; mkdir -p "$STATE"
PORT="${API_PORT:-8787}"
PROTO="${TUNNEL_PROTOCOL:-quic}"
MPORT="${TUNNEL_METRICS_PORT:-20271}"
CF_BIN="${CLOUDFLARED_BIN:-cloudflared}"
LOG="$STATE/tunnel.log"
PY="$ROOT/backend/.venv/bin/python"; [ -x "$PY" ] || PY="$(command -v python3)"
echo "--- Tunnel started at $(date -u '+%Y-%m-%d %H:%M:%SZ') ---" >> "$LOG"
rm -f "$STATE/tunnel_url"
START_OFF="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
# cloudflared output goes through the rotating log sink (no lost lines, size cap, 7 days)
"$CF_BIN" tunnel \
  --url "http://127.0.0.1:${PORT}" \
  --protocol "$PROTO" \
  --ha-connections 4 \
  --edge-ip-version auto \
  --no-autoupdate \
  --metrics "127.0.0.1:${MPORT}" \
  --loglevel info > >("$PY" "$ROOT/scripts/logpipe.py" "$LOG") 2>&1 &
CF=$!
trap 'kill $CF 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 90); do
  URL="$(curl -s -m 2 "http://127.0.0.1:${MPORT}/quicktunnel" 2>/dev/null | grep -oE '[a-z0-9-]+\.trycloudflare\.com' | head -1 | sed 's|^|https://|')"
  [ -z "$URL" ] && URL="$(tail -c +$((START_OFF + 1)) "$LOG" 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)"
  [ -n "$URL" ] && { echo "$URL" > "$STATE/tunnel_url.tmp" && mv -f "$STATE/tunnel_url.tmp" "$STATE/tunnel_url"; break; }
  kill -0 $CF 2>/dev/null || exit 1
  sleep 1
done
wait $CF
