#!/usr/bin/env bash
# One-screen ops status: API / tunnel / model / DB / disk. Read-only. Prints no secrets.
#   scripts/ops_status.sh            (env: API_PORT, SUPERVISE_STATE for a spare instance; API_AUTH_TOKEN or .env for the detail endpoint)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${SUPERVISE_STATE:-$ROOT/.state}"
dotenv_get() { [ -f "$ROOT/.env" ] && grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
PORT="${API_PORT:-$(dotenv_get API_PORT)}"; PORT="${PORT:-8787}"
TOKEN="${API_AUTH_TOKEN:-$(dotenv_get API_AUTH_TOKEN)}"
BASE="http://127.0.0.1:$PORT/api/v1"
MPORT="${TUNNEL_METRICS_PORT:-20271}"
ready="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health/ready" 2>/dev/null)"; ready="${ready:-000}"
auth=(); [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
detail="$(curl -s -m 8 "${auth[@]}" "$BASE/health/detail" 2>/dev/null)"
host="$(curl -s -m 3 "http://127.0.0.1:$MPORT/quicktunnel" 2>/dev/null | grep -oE '[a-z0-9-]+\.trycloudflare\.com' | head -1)"
tcode=""; [ -n "$host" ] && tcode="$(curl -s -o /dev/null -w '%{http_code}' -m 8 "https://$host/api/v1/health/live" 2>/dev/null)"
DETAIL="$detail" READY="$ready" PORT="$PORT" THOST="$host" TCODE="${tcode:-}" STATE="$STATE" python3 - <<'PY'
import json, os, shutil
def line(k, v): print(f"{k:<8} {v}")
ready, port, host, tcode, state = os.environ["READY"], os.environ["PORT"], os.environ["THOST"], os.environ["TCODE"], os.environ["STATE"]
try: d = json.loads(os.environ["DETAIL"])
except Exception: d = None
if d is not None and "engine" not in d: d = None          # 401 / error body
proc = (d or {}).get("process", {}); eng = (d or {}).get("engine", {}); com = (d or {}).get("commit", {}); ob = (d or {}).get("outbox", {})
api = {"200": "READY", "503": "NOT READY"}.get(ready, "DOWN (no answer)" if ready == "000" else f"http {ready}")
extra = ""
if d: extra = f"  pid {proc.get('pid')} up {proc.get('uptime_s')}s rss {proc.get('rss_mb')}MB cpu {proc.get('cpu_percent')}% | tick lag {eng.get('tick_lag_s')}s, last commit {com.get('last_commit_age_s')}s ago, outbox {ob.get('depth')}"
line("API", f":{port} {api}{extra}")
if host: line("Tunnel", f"https://{host}  public check http={tcode or '?'}" + ("" if tcode == "200" else "  <-- not reachable"))
else: line("Tunnel", "DOWN (cloudflared metrics endpoint silent)")
if d:
    m = d.get("model", {}); g = m.get("gateway", {})
    line("Model", f"{m.get('provider')}/{m.get('model_id')} status={m.get('status')} breaker={m.get('breaker_state')} last_error={m.get('last_error_class')} calls={g.get('calls')} spend=${g.get('spend_usd')}")
    db = d.get("database", {}); p = db.get("pool", {})
    line("DB", f"{db.get('kind')} up={db.get('up')}" + (f" pool {p.get('pool_available')}/{p.get('pool_size')} avail, waiting={p.get('requests_waiting')}, errors={p.get('connections_errors')}" if p else ""))
    k = d.get("disk", {})
    line("Disk", f".state {k.get('state_mb')}MB ({k.get('files')} files, largest {k.get('largest_file')} {k.get('largest_file_mb')}MB), fs {k.get('fs_used_pct')}% used, {k.get('fs_free_gb')}GB free")
else:
    line("Model", "unknown (health/detail needs API_AUTH_TOKEN; none valid in env or .env)" if ready != "000" else "unknown (API down)")
    line("DB", "unknown")
    tot = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(state) for f in fs if os.path.isfile(os.path.join(r, f)) and not os.path.islink(os.path.join(r, f)))
    du = shutil.disk_usage(state)
    line("Disk", f".state {tot/1048576:.1f}MB, fs {du.used/du.total*100:.1f}% used, {du.free/1e9:.1f}GB free")
PY
