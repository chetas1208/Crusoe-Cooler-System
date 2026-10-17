#!/usr/bin/env bash
# Cloudflare quick tunnel -> local API, tuned for a high-frequency WebSocket stream.
#   QUIC (UDP) transport = lowest latency; falls back to HTTP/2 if UDP egress is blocked.
#   4 HA connections to the edge; tunnel URL written to .state/tunnel_url for the supervisor/README.
# Quick tunnels get a NEW random *.trycloudflare.com URL on every start (no account, no SLA).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.state"; mkdir -p "$STATE"
PORT="${API_PORT:-8787}"
PROTO="${TUNNEL_PROTOCOL:-quic}"
LOG="$STATE/tunnel.log"
echo "--- Tunnel started at $(date -u '+%Y-%m-%d %H:%M:%SZ') ---" >> "$LOG"
rm -f "$STATE/tunnel_url"
nohup cloudflared tunnel \
  --url "http://127.0.0.1:${PORT}" \
  --protocol "$PROTO" \
  --ha-connections 4 \
  --edge-ip-version auto \
  --no-autoupdate \
  --metrics 127.0.0.1:20271 \
  --loglevel info >> "$LOG" 2>&1 &
CF=$!
trap 'kill $CF 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | tail -1)"
  [ -n "$URL" ] && { echo "$URL" > "$STATE/tunnel_url"; break; }
  kill -0 $CF 2>/dev/null || exit 1
  sleep 1
done
wait $CF
