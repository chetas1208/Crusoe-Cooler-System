#!/usr/bin/env bash
# LOOPKEEPER demo pre-flight. READ-ONLY by default: GETs, plus two side-effect-free POSTs
# (scenario readiness check, Laya classify -- the latter only bumps an in-memory query counter -- and an invalid-shape
# fault command that is rejected by validation before it reaches the engine).
#
#   scripts/demo/preflight.sh                 # checks only
#   scripts/demo/preflight.sh --spare         # additionally create ONE idempotent spare run and prove a fault command
#                                             # sent to it is refused (adds one run to the Runs list; never touches run_live)
#
# Env: API_BASE (default http://127.0.0.1:8787/api/v1)  API_AUTH_TOKEN (optional bearer)
#      PUBLIC_WEB_URL (default https://your-app.vercel.app)  TUNNEL_URL (default: .state/tunnel_url)
# Exit code: number of FAIL lines (0 = go). WARN lines are judgement calls, see docs/submission/DEMO_SCRIPT.md.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API="${API_BASE:-http://127.0.0.1:8787/api/v1}"
WEB="${PUBLIC_WEB_URL:-https://your-app.vercel.app}"
TUNNEL="${TUNNEL_URL:-$(cat "$ROOT/.state/tunnel_url" 2>/dev/null || true)}"
SPARE=0; [ "${1:-}" = "--spare" ] && SPARE=1
AUTH=(); [ -n "${API_AUTH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${API_AUTH_TOKEN}")
FAILS=0; WARNS=0
ok()   { printf '  [ OK ] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; WARNS=$((WARNS+1)); }
fail() { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS+1)); }
get()  { curl -s -m "${3:-8}" "${AUTH[@]}" "$API$1" -w '\n%{http_code}' 2>/dev/null; }   # -> body \n code
post() { curl -s -m "${3:-15}" "${AUTH[@]}" -H 'content-type: application/json' -X POST -d "$2" "$API$1" -w '\n%{http_code}' 2>/dev/null; }
code() { printf '%s' "$1" | tail -n1; }
body() { printf '%s' "$1" | sed '$d'; }
jq_()  { python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    for k in sys.argv[1].split('.'):
        d=d[int(k)] if isinstance(d,list) else d.get(k)
    print('' if d is None else d)
except Exception:
    print('')" "$1"; }

echo "LOOPKEEPER preflight  $(date -u +%FT%TZ)  API=$API"

echo "1. API + engine"
R=$(get /health/ready)
if [ "$(code "$R")" = "200" ]; then
  B=$(body "$R")
  [ "$(printf '%s' "$B" | jq_ status)" = "ready" ] && ok "API ready" || fail "API status = $(printf '%s' "$B" | jq_ status)"
  [ "$(printf '%s' "$B" | jq_ backend)" = "live" ] && ok "backend = live (not the mock simulator)" || fail "backend = $(printf '%s' "$B" | jq_ backend) (mock/standalone would be a dishonest demo)"
  S=$(printf '%s' "$B" | jq_ health.solver.status); [ "$S" = "converged" ] && ok "solver converged (residual $(printf '%s' "$B" | jq_ health.solver.residual))" || fail "solver status '$S'"
  HS=$(printf '%s' "$B" | jq_ health.status); [ "$HS" = "nominal" ] && ok "plant health nominal" || warn "plant health '$HS' (open incident or recovering): the first live incident may not start clean"
  UP=$(printf '%s' "$B" | jq_ health.uptime_s); ok "engine uptime ${UP}s"
else
  fail "GET /health/ready -> HTTP $(code "$R") (is the API up? scripts/supervise.sh)"; B="{}"
fi

echo "2. Database (Neon) + checkpointer"
DB=$(printf '%s' "$B" | jq_ health.database); [ "$DB" = "ok" ] && ok "database = ok" || fail "database = '$DB'"
CP=$(printf '%s' "$B" | jq_ health.intelligence.checkpointer); [ "$CP" = "postgres" ] && ok "LangGraph checkpointer = postgres (restart_safe=$(printf '%s' "$B" | jq_ health.intelligence.restart_safe))" || fail "checkpointer = '$CP' (in-memory means no Neon evidence)"

echo "3. Model (Crusoe Nemotron)"
M=$(get /models/status)
if [ "$(code "$M")" = "200" ]; then
  MB=$(body "$M")
  [ "$(printf '%s' "$MB" | jq_ status)" = "live" ] && ok "model status live: $(printf '%s' "$MB" | jq_ model_id) (last latency $(printf '%s' "$MB" | jq_ last_latency_ms) ms)" || fail "model status '$(printf '%s' "$MB" | jq_ status)'"
  [ "$(printf '%s' "$MB" | jq_ fallback_active)" = "False" ] && ok "fallback_active = false" || fail "deterministic fallback is active: do not claim a model decided anything"
  [ "$(printf '%s' "$MB" | jq_ scenario_text.available)" = "True" ] && ok "free-text scenario interpretation available" || warn "scenario_text.available=false ($(printf '%s' "$MB" | jq_ scenario_text.reason)); the Segment-1 prompt uses POST /scenario-requests, which does not need it, but note it"
else fail "GET /models/status -> HTTP $(code "$M")"; fi
echo "   deep tier (Super-120B) is configured via MODEL_NAME_DEEP; confirm: grep MODEL_NAME_DEEP .env  (value not printed here)"
if grep -qE '^MODEL_NAME_DEEP=.+' "$ROOT/.env" 2>/dev/null; then ok "MODEL_NAME_DEEP is set in .env"; else warn "MODEL_NAME_DEEP not set in .env: the deep tier would fall back to the fast model"; fi

echo "4. Laya (advisory triage)"
L=$(get /intelligence/laya/status)
if [ "$(code "$L")" = "200" ]; then
  LB=$(body "$L"); [ "$(printf '%s' "$LB" | jq_ engine)" = "laya_router" ] && ok "Laya engine = laya_router (sdk $(printf '%s' "$LB" | jq_ sdk_commit | cut -c1-7))" || fail "Laya engine = '$(printf '%s' "$LB" | jq_ engine)' (rule fallback is NOT Laya)"
  C=$(post /intelligence/laya/classify '{"summary":"cooling near the back racks seems to be dying and a pipe is probably blocked"}')
  [ "$(code "$C")" = "200" ] && ok "Laya classify: family=$(body "$C" | jq_ task_family) conf=$(body "$C" | jq_ confidence) abstained=$(body "$C" | jq_ abstained) ($(body "$C" | jq_ latency_ms) ms)" || fail "Laya classify -> HTTP $(code "$C")"
else fail "GET /intelligence/laya/status -> HTTP $(code "$L")"; fi

echo "5. V10/V11 routes (a stale server will 404 here: restart it so the new code is live)"
R1=$(get /runs/run_live/communications); [ "$(code "$R1")" = "200" ] && ok "communications route" || fail "communications route -> HTTP $(code "$R1")"
R2=$(get /runs/run_live/contracts);      [ "$(code "$R2")" = "200" ] && ok "Definition-of-Done route" || fail "DOD route -> HTTP $(code "$R2") (404 = backend started before the V11 code; restart it)"
R3=$(post /scenarios/CR-01/validate '{}'); [ "$(body "$R3" | jq_ ready)" = "True" ] && ok "scenario readiness CR-01 ready (read-only)" || warn "CR-01 readiness not 'ready'"
R4=$(get /runs); NRUN=$(body "$R4" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?"); ok "runs listed: $NRUN"
INC=$(get /incidents); OPEN=$(body "$INC" | python3 -c "import sys,json;print(sum(1 for i in json.load(sys.stdin) if i.get('status') not in ('resolved','dismissed','escalated')))" 2>/dev/null || echo "?")
[ "$OPEN" = "0" ] && ok "no open incidents on the live run" || warn "open incidents on the live run: $OPEN (a second incident may queue behind it)"
TOPO=$(get /topology 15)
for t in strainer_02 p_hs_b valve_b1; do body "$TOPO" | grep -q "\"$t\"" && ok "demo target $t exists in topology" || warn "demo target $t NOT in topology"; done
body "$TOPO" | grep -q '"p_17"' || warn "'Foul P-17' in the UI test menu targets p_17, which is not in the v6 topology: use the curl injection in DEMO_SCRIPT.md instead"

echo "6. Public reachability (tunnel + Vercel)"
if [ -n "$TUNNEL" ]; then
  T=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$TUNNEL/api/v1/health/live"); [ "$T" = "200" ] && ok "tunnel up: $TUNNEL" || fail "tunnel $TUNNEL -> HTTP $T (restart scripts/tunnel.sh; the URL changes: update the Vercel API URL / the demo link)"
else warn "no tunnel URL (.state/tunnel_url missing). Fine if you demo on localhost only"; fi
if [ -f "$ROOT/apps/web/dist/index.html" ]; then ok "apps/web/dist/index.html exists (backend/tunnel can serve the console same-origin)"; else warn "apps/web/dist/index.html missing: the tunnel root serves JSON, not the console (run: pnpm --filter @loopkeeper/web build, or demo via Vercel / pnpm dev:live on :5173)"; fi
V=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/); [ "$V" = "200" ] && ok "vite dev server answers on :5173" || warn "nothing on :5173 (fine if you demo via Vercel or the built dist)"
W=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$WEB/"); [ "$W" = "200" ] && ok "web reachable: $WEB" || warn "web $WEB -> HTTP $W"

echo "7. Incident-injection command path (never mutates run_live)"
# Shape probe: a test.inject_fault with NO args.kind is rejected by validation BEFORE it reaches the engine,
# so it proves the command is enabled and routed without injecting anything.
CID="preflight-shape-$(date +%s)"
A=$(post /runs/run_live/commands "{\"command_id\":\"$CID\",\"kind\":\"test.inject_fault\",\"args\":{}}")
RS=$(body "$A" | jq_ reason)
case "$(code "$A"):$RS" in
  422:*"args.kind"*) ok "test.inject_fault is enabled and routed (shape probe rejected as expected: $RS)";;
  200:*"disabled"*)  fail "test commands are disabled on this deployment (LOOPKEEPER_ENABLE_TEST_COMMANDS): the live incident cannot be injected";;
  *) warn "unexpected answer to the shape probe: HTTP $(code "$A") $RS";;
esac
if [ "$SPARE" = 1 ]; then
  # Only the ACTIVE live run has an engine worker; stored runs and forks are read-only. A spare run therefore proves isolation:
  # a fault command sent to it must be refused (409 read_only) and cannot touch run_live.
  S1=$(post /runs '{"scenario_id":"CR-01","seed":12000,"idempotency_key":"preflight-spare-v1"}' 120)
  SID=$(body "$S1" | jq_ run_id)
  if [ -n "$SID" ]; then
    ok "spare run: $SID (idempotent key: re-running re-uses it; adds ONE run to the Runs list)"
    A2=$(post "/runs/$SID/commands" "{\"command_id\":\"preflight-spare-$(date +%s)\",\"kind\":\"test.inject_fault\",\"args\":{\"kind\":\"strainer_blockage\",\"target\":\"strainer_02\"}}")
    [ "$(code "$A2")" = "409" ] && ok "fault command on the spare run refused as read-only (isolation holds: nothing can leak into run_live)" || warn "spare run answered HTTP $(code "$A2") to a fault command (expected 409 read_only)"
  else fail "could not create the spare run (HTTP $(code "$S1")): $(body "$S1" | head -c 200)"; fi
else
  warn "spare-run isolation check skipped (--spare). Real injection is a deliberate operator step in DEMO_SCRIPT.md, never done by this script"
fi

echo
echo "RESULT: $FAILS fail, $WARNS warn  ->  $([ $FAILS -eq 0 ] && echo GO || echo NO-GO)"
exit $FAILS
