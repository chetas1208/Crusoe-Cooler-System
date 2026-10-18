#!/usr/bin/env bash
# Keeps the API and the Cloudflare tunnel alive. Safe to re-run: `start` is a silent no-op when everything runs (cron calls it every 2 min).
#   scripts/supervise.sh start   [api|tunnel|all] [--wait]   start missing supervisors (+ the monitor); --wait blocks until the API is ready
#   scripts/supervise.sh stop    [api|tunnel|all]
#   scripts/supervise.sh restart [api|tunnel|all]            `restart api` / `restart all` return only when /health/ready answers 200 (exit 1 on timeout)
#   scripts/supervise.sh status
#   scripts/supervise.sh url                                  ONE line: the live tunnel URL (exit 1 + stderr message if no tunnel is up)
#   scripts/supervise.sh cron [show|install|remove]           idempotent; only touches crontab lines tagged "# loopkeeper" that run supervise.sh
#
# Processes (all in .state/): api.sup.pid / tunnel.sup.pid / monitor.sup.pid = supervisor loops (each its own session+process group),
# api.pid = the API child, supervisor.log = every start / exit / restart decision with a timestamp.
#  * crash loops: a run shorter than STABLE_S (60) doubles the restart delay 2,4,8,16,32,60 s; a longer run resets it.
#  * monitor (one background loop, every WATCH_INTERVAL_S=10): restarts the API when /health/ready has failed for READY_FAIL_S (60) in a row
#    (not while a freshly started API is still booting: START_GRACE_S=180; at most one watchdog restart per 5 min, doubling up to 30 min),
#    keeps .state/tunnel_url equal to the tunnel's real URL, rotates/prunes logs.
#  * output of the API / tunnel goes through scripts/logpipe.py: size cap LOG_MAX_BYTES (50 MiB) + daily rotation, gzip, 7 days kept, no lost line.
# Test knobs (spare port / state dir, never :8787): SUPERVISE_STATE, API_PORT, SUPERVISE_DOTENV=0 (do not source .env), API_CMD, TUNNEL_CMD,
# TUNNEL_METRICS_PORT, CLOUDFLARED_BIN, CRONTAB_BIN, READY_FAIL_S, START_GRACE_S, WATCH_INTERVAL_S, STABLE_S, BACKOFF_MAX.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "${SUPERVISE_DOTENV:-1}" != 0 ] && [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
STATE="${SUPERVISE_STATE:-$ROOT/.state}"; mkdir -p "$STATE"
PORT="${API_PORT:-8787}"
METRICS_PORT="${TUNNEL_METRICS_PORT:-20271}"
export STATE_DIR="$STATE" LOOPKEEPER_STATE_DIR="$STATE" API_PORT="$PORT" TUNNEL_METRICS_PORT="$METRICS_PORT"
export LOG_MAX_BYTES="${LOG_MAX_BYTES:-52428800}" LOG_KEEP_DAYS="${LOG_KEEP_DAYS:-7}"
API_CMD="${API_CMD:-$ROOT/scripts/api.sh}"
TUNNEL_CMD="${TUNNEL_CMD:-$ROOT/scripts/tunnel.sh}"
READY_FAIL_S="${READY_FAIL_S:-60}"; START_GRACE_S="${START_GRACE_S:-180}"; WATCH_INTERVAL_S="${WATCH_INTERVAL_S:-10}"
STABLE_S="${STABLE_S:-60}"; BACKOFF_MAX="${BACKOFF_MAX:-60}"; STOP_WAIT_S="${STOP_WAIT_S:-40}"; RESTART_WAIT_S="${RESTART_WAIT_S:-300}"
READY_URL="http://127.0.0.1:$PORT/api/v1/health/ready"
SUPLOG="$STATE/supervisor.log"

# logs/ convenience symlinks only for the default state dir (a test state dir must not repoint them)
if [ "$STATE" = "$ROOT/.state" ]; then
  LOGS="$ROOT/logs"; mkdir -p "$LOGS"
  [ -e "$LOGS/tunnel.log" ] || ln -sf "$STATE/tunnel.log" "$LOGS/tunnel.log" 2>/dev/null || true
  [ -e "$LOGS/api.log" ] || ln -sf "$STATE/api.out" "$LOGS/api.log" 2>/dev/null || true
  [ -e "$LOGS/backend.log" ] || ln -sf "$STATE/api.out" "$LOGS/backend.log" 2>/dev/null || true
else
  LOGS=""
fi

PYBIN="$ROOT/backend/.venv/bin/python"; [ -x "$PYBIN" ] || PYBIN="$(command -v python3)"
now() { date +%s; }
ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
slog() { echo "$(ts) $*" >> "$SUPLOG"; }
tty_out() { [ -t 1 ]; }

# ---------------------------------------------------------------- process helpers
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
# a supervisor is "alive" when its pidfile names a live process that is its own process-group leader (guards against pid reuse)
sup_alive() {
  local f="$STATE/$1.sup.pid" p
  [ -f "$f" ] || return 1
  p="$(cat "$f" 2>/dev/null)"; pid_alive "$p" || return 1
  [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')" = "$p" ]
}
listener_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
api_pid() {
  local p; p="$(cat "$STATE/api.pid" 2>/dev/null)"
  if pid_alive "$p"; then echo "$p"; return; fi
  listener_pid "$PORT"
}
etimes() { ps -o etimes= -p "$1" 2>/dev/null | tr -d ' '; }
http_code() { curl -s -o /dev/null -w '%{http_code}' -m "${2:-5}" "$1" 2>/dev/null || true; }
ready_code() { local c; c="$(http_code "$READY_URL" 5)"; echo "${c:-000}"; }
locked() { ( flock -w 90 9 || { echo "supervise: lock busy" >&2; exit 99; }; "$@" ) 9>"$STATE/.lock"; }

kill_tree_wait() { # pid_or_-pgid, wait_s : TERM, wait, KILL
  local target="$1" w="${2:-$STOP_WAIT_S}" i=0 probe="${1#-}"
  kill -TERM -- "$target" 2>/dev/null || return 0
  while pid_alive "$probe" && [ $i -lt $((w * 5)) ]; do sleep 0.2; i=$((i + 1)); done
  pid_alive "$probe" && kill -KILL -- "$target" 2>/dev/null
  return 0
}

# ---------------------------------------------------------------- supervisor loop (runs as: supervise.sh _loop api|tunnel)
run_loop() {
  local name="$1" cmd fails=0 delay t0 dt rc pid
  case "$name" in api) cmd="$API_CMD" ;; tunnel) cmd="$TUNNEL_CMD" ;; *) exit 1 ;; esac
  local out="$STATE/$name.out"; [ "$name" = tunnel ] && out="$STATE/tunnel.log"
  echo $$ > "$STATE/$name.sup.pid"
  trap 'slog "$name supervisor: terminated"; exit 0' TERM INT
  while true; do
    t0="$(now)"
    ( echo "--- $name started at $(ts) ---"; exec "$cmd" ) > >("$PYBIN" "$ROOT/scripts/logpipe.py" "$out") 2>&1 &
    pid=$!
    [ "$name" = api ] && echo "$pid" > "$STATE/api.pid"
    slog "$name started pid=$pid"
    wait "$pid"; rc=$?
    dt=$(( $(now) - t0 ))
    if [ "$dt" -lt "$STABLE_S" ]; then fails=$((fails + 1)); else fails=0; fi
    if [ "$fails" -eq 0 ]; then delay=2; else delay=$(( 2 ** (fails > 6 ? 6 : fails) )); [ "$delay" -gt "$BACKOFF_MAX" ] && delay="$BACKOFF_MAX"; fi
    echo "$delay" > "$STATE/$name.backoff_s"
    slog "$name exited rc=$rc after ${dt}s (quick_failures=$fails); restart in ${delay}s"
    sleep "$delay"
  done
}

# ---------------------------------------------------------------- monitor (runs as: supervise.sh _monitor)
tunnel_url_live() { # authoritative: cloudflared's own metrics endpoint
  curl -s -m 3 "http://127.0.0.1:$METRICS_PORT/quicktunnel" 2>/dev/null | grep -oE '[a-z0-9-]+\.trycloudflare\.com' | head -1 | sed 's|^|https://|'
}
tunnel_sync() { # keep .state/tunnel_url == the real URL; history on every change
  local live cur
  live="$(tunnel_url_live)"
  if [ -z "$live" ]; then return 0; fi
  cur="$(cat "$STATE/tunnel_url" 2>/dev/null)"
  if [ "$live" != "$cur" ]; then
    echo "$live" > "$STATE/tunnel_url.tmp" && mv -f "$STATE/tunnel_url.tmp" "$STATE/tunnel_url"
    echo "$(ts) $live" >> "$STATE/tunnel_url.history"
    slog "tunnel url changed: ${cur:-none} -> $live"
  fi
}

copytruncate_big() { # files nobody rotates (cron.log, supervisor.log, legacy writers): copy, gzip, truncate. Only files NOT owned by a logpipe.
  local f
  for f in "$@"; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -ge "$LOG_MAX_BYTES" ] || continue
    pgrep -f "logpipe.py $f\$" >/dev/null 2>&1 && continue
    local dst; dst="$f.$(date -u +%Y%m%d-%H%M%S)"
    if cp -- "$f" "$dst" && : > "$f"; then gzip -f "$dst" 2>/dev/null; slog "rotated (copytruncate) $f"; fi
  done
}
janitor() {
  shopt -s nullglob
  copytruncate_big "$STATE"/*.out "$STATE"/*.log ${LOGS:+"$LOGS"/*}
  find "$STATE" ${LOGS:+"$LOGS"} -maxdepth 1 -type f -name '*.log.2*' -mtime +"$LOG_KEEP_DAYS" -delete 2>/dev/null
  find "$STATE" ${LOGS:+"$LOGS"} -maxdepth 1 -type f -name '*.out.2*' -mtime +"$LOG_KEEP_DAYS" -delete 2>/dev/null
  shopt -u nullglob
}

run_monitor() {
  echo $$ > "$STATE/monitor.sup.pid"
  trap 'exit 0' TERM INT
  local fail_since="" restarts=0 last_restart=0 ok_since="" last_jan=0 p code body gap age t
  while true; do
    tunnel_sync
    t="$(now)"
    if [ $((t - last_jan)) -ge 300 ]; then janitor; last_jan="$t"; fi
    if sup_alive api && p="$(api_pid)" && [ -n "$p" ]; then
      body="$(curl -s -m 5 -w '\n%{http_code}' "$READY_URL" 2>/dev/null || true)"
      code="${body##*$'\n'}"; [ -z "$code" ] && code=000
      if [ "$code" = 200 ]; then
        fail_since=""; [ -z "$ok_since" ] && ok_since="$t"
        [ $((t - ok_since)) -ge 60 ] && restarts=0
      else
        ok_since=""; age="$(etimes "$p")"; age="${age:-0}"
        if [ "$code" = 000 ] && [ "$age" -lt "$START_GRACE_S" ]; then
          fail_since=""                                     # still booting (recover from the DB can take a while)
        else
          [ -z "$fail_since" ] && fail_since="$t"
          gap=$(( 300 * (2 ** (restarts > 3 ? 3 : restarts)) )); [ "$gap" -gt 1800 ] && gap=1800
          if [ $((t - fail_since)) -ge "$READY_FAIL_S" ] && [ $((t - last_restart)) -ge "$gap" ]; then
            slog "watchdog: /health/ready failing for $((t - fail_since))s (http=$code body=$(echo "${body%$'\n'*}" | tr -d '\n' | cut -c1-160)); restarting api pid=$p"
            kill_tree_wait "$p" 30
            restarts=$((restarts + 1)); last_restart="$(now)"; fail_since=""
          fi
        fi
      fi
    else
      fail_since=""; ok_since=""
    fi
    sleep "$WATCH_INTERVAL_S"
  done
}

# ---------------------------------------------------------------- actions
start_sup() { # name
  local name="$1"
  if sup_alive "$name"; then tty_out && echo "$name supervisor already running"; return 0; fi
  if [ "$name" = api ]; then
    local lp; lp="$(listener_pid "$PORT")"
    if [ -n "$lp" ]; then echo "api: port $PORT already served by unsupervised pid $lp; not starting a second engine" >&2; return 1; fi
  fi
  rm -f "$STATE/$name.sup.pid"
  nohup setsid "$SELF" _loop "$name" </dev/null >/dev/null 2>&1 9>&- &
  local i=0; while ! sup_alive "$name" && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  echo "$name supervisor started"
}
start_monitor() {
  sup_alive monitor && return 0
  rm -f "$STATE/monitor.sup.pid"
  nohup setsid "$SELF" _monitor </dev/null >/dev/null 2>&1 9>&- &
  local i=0; while ! sup_alive monitor && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
}
stop_sup() { # name
  local name="$1" p child=""; local f="$STATE/$name.sup.pid"
  [ "$name" = api ] && child="$(api_pid)"
  if [ -f "$f" ]; then
    p="$(cat "$f" 2>/dev/null)"
    if sup_alive "$name"; then kill_tree_wait "-$p" "$STOP_WAIT_S"; else pid_alive "$p" && kill "$p" 2>/dev/null; fi
    rm -f "$f"
  fi
  if [ -n "$child" ] && pid_alive "$child"; then kill_tree_wait "$child" "$STOP_WAIT_S"; fi   # unsupervised leftover / legacy supervisor without api.pid
  [ "$name" = api ] && rm -f "$STATE/api.pid"
  echo "$name stopped"
}
stop_monitor() {
  sup_alive monitor && kill_tree_wait "-$(cat "$STATE/monitor.sup.pid")" 5
  rm -f "$STATE/monitor.sup.pid"
}

wait_ready() { # timeout_s
  local t0 i=0 c; t0="$(now)"
  while [ $(( $(now) - t0 )) -lt "${1:-$RESTART_WAIT_S}" ]; do
    c="$(ready_code)"
    if [ "$c" = 200 ]; then echo "api ready after $(( $(now) - t0 ))s (pid $(api_pid), port $PORT)"; return 0; fi
    i=$((i + 1)); if [ $i -gt 5 ] && ! sup_alive api; then echo "api supervisor is not running" >&2; return 1; fi
    sleep 1
  done
  echo "api NOT ready after ${1:-$RESTART_WAIT_S}s (last /health/ready http=$(ready_code); see $STATE/api.out and $SUPLOG)" >&2
  return 1
}

do_url() {
  local u
  u="$(tunnel_url_live)"
  if [ -z "$u" ]; then
    # metrics endpoint silent: either no tunnel at all or cloudflared still starting
    if sup_alive tunnel && [ -s "$STATE/tunnel_url" ] && pid_alive "$(pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" | head -1)"; then u="$(cat "$STATE/tunnel_url")"; fi
  fi
  if [ -z "$u" ]; then echo "no tunnel URL: tunnel is not running (scripts/supervise.sh start tunnel)" >&2; return 1; fi
  tunnel_sync
  echo "$u"
}

do_status() {
  local p c u
  echo "=== LOOPKEEPER SERVICES STATUS (state=$STATE port=$PORT) ==="
  p="$(api_pid)"; c="$(ready_code)"
  if [ "$c" = 200 ]; then echo "  API:     READY (pid ${p:-?}, up $(etimes "${p:-0}")s) supervisor=$(sup_alive api && echo yes || echo NO)"
  elif [ -n "$p" ]; then echo "  API:     UP BUT NOT READY (http=$c, pid $p) supervisor=$(sup_alive api && echo yes || echo NO)"
  else echo "  API:     STOPPED supervisor=$(sup_alive api && echo yes || echo no)"; fi
  [ -f "$STATE/api.backoff_s" ] && echo "           last restart delay: $(cat "$STATE/api.backoff_s")s"
  u="$(tunnel_url_live)"
  if [ -n "$u" ]; then echo "  Tunnel:  UP $u supervisor=$(sup_alive tunnel && echo yes || echo NO)"; else echo "  Tunnel:  DOWN supervisor=$(sup_alive tunnel && echo yes || echo no)"; fi
  echo "  Monitor: $(sup_alive monitor && echo running || echo STOPPED)"
  echo "  Logs:    $STATE/api.out  $STATE/tunnel.log  $SUPLOG"
}

CRON_REBOOT="@reboot sleep 40 && $SELF start >> $ROOT/.state/cron.log 2>&1 # loopkeeper"
CRON_EVERY="*/2 * * * * $SELF start >> $ROOT/.state/cron.log 2>&1 # loopkeeper"
do_cron() {
  local cb="${CRONTAB_BIN:-crontab}" cur new line done_block=0 mode="${1:-show}"
  cur="$($cb -l 2>/dev/null || true)"
  case "$mode" in
    show) echo "$cur" | grep -E 'supervise\.sh.*# loopkeeper' || echo "(no loopkeeper supervise entries)"; return 0 ;;
    install|remove) ;;
    *) echo "Usage: $0 cron [show|install|remove]" >&2; return 1 ;;
  esac
  new=""
  while IFS= read -r line; do
    if [[ "$line" == *"supervise.sh"* && "$line" == *"# loopkeeper"* ]]; then       # ours: replace in place (first hit), drop duplicates
      if [ "$mode" = install ] && [ $done_block = 0 ]; then new+="$CRON_REBOOT"$'\n'"$CRON_EVERY"$'\n'; done_block=1; fi
    else
      new+="$line"$'\n'
    fi
  done <<< "$cur"
  [ "$mode" = install ] && [ $done_block = 0 ] && new+="$CRON_REBOOT"$'\n'"$CRON_EVERY"$'\n'
  [ -z "$cur" ] && new="${new#$'\n'}"
  if [ "$new" = "$cur"$'\n' ] || [ "$new" = "$cur" ]; then echo "cron: loopkeeper entries already up to date (crontab unchanged)"; return 0; fi
  printf '%s' "$new" | $cb - && echo "cron: loopkeeper entries $([ "$mode" = install ] && echo installed || echo removed) (other lines untouched)"
}

ACTION="${1:-status}"; TARGET="${2:-all}"; FLAG="${3:-}"
[ "$TARGET" = "--wait" ] && { TARGET=all; FLAG="--wait"; }
case "$ACTION" in
  _loop) run_loop "$TARGET" ;;
  _monitor) run_monitor ;;
  start)
    case "$TARGET" in
      api) locked start_sup api; locked start_monitor ;;
      tunnel) locked start_sup tunnel; locked start_monitor ;;
      all|"") locked start_sup api; locked start_sup tunnel; locked start_monitor ;;
      *) echo "Usage: $0 start [api|tunnel|all] [--wait]" >&2; exit 1 ;;
    esac
    [ "$FLAG" = "--wait" ] && case "$TARGET" in api|all|"") wait_ready "$RESTART_WAIT_S" || exit 1 ;; esac
    ;;
  stop)
    case "$TARGET" in
      api) locked stop_sup api ;;
      tunnel) locked stop_sup tunnel ;;
      all|"") locked stop_monitor; locked stop_sup api; locked stop_sup tunnel ;;
      *) echo "Usage: $0 stop [api|tunnel|all]" >&2; exit 1 ;;
    esac
    ;;
  restart)
    case "$TARGET" in
      api) locked stop_sup api; sleep 1; locked start_sup api; locked start_monitor; wait_ready "$RESTART_WAIT_S" || exit 1 ;;
      tunnel) locked stop_sup tunnel; sleep 1; locked start_sup tunnel; locked start_monitor ;;
      all|"") locked stop_monitor; locked stop_sup api; locked stop_sup tunnel; sleep 1; locked start_sup api; locked start_sup tunnel; locked start_monitor
              wait_ready "$RESTART_WAIT_S" || exit 1 ;;
      *) echo "Usage: $0 restart [api|tunnel|all]" >&2; exit 1 ;;
    esac
    ;;
  url) do_url || exit 1 ;;
  status) do_status ;;
  cron) do_cron "${2:-show}" ;;
  *) echo "Usage: $0 {start|stop|restart|status|url|cron} [api|tunnel|all]" >&2; exit 1 ;;
esac
