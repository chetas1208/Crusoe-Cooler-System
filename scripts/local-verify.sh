#!/usr/bin/env bash
set -euo pipefail

echo "================================================================="
echo "  LOOPKEEPER — Comprehensive Verification Script"
echo "  Crusoe Managed Inference & Neon PostgreSQL Physical AI Twin"
echo "================================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_PY="$PROJECT_ROOT/backend/.venv/bin/python"
VENV_PYTEST="$PROJECT_ROOT/backend/.venv/bin/pytest"

if [ ! -f "$VENV_PYTEST" ]; then
    echo "ERROR: Virtual environment pytest not found at $VENV_PYTEST"
    exit 1
fi

echo "[1/4] Probing Neon PostgreSQL Database Endpoints..."
$VENV_PY -c "
import os, sys, psycopg
from dotenv import load_dotenv
load_dotenv('$PROJECT_ROOT/.env')
url = os.getenv('DATABASE_URL')
if not url:
    print('DATABASE_URL missing')
    sys.exit(1)
conn = psycopg.connect(url)
cur = conn.cursor()
cur.execute('SELECT version()')
v = cur.fetchone()[0]
print(f'  ✓ Neon Pooled Endpoint Connected: {v}')
cur.close()
conn.close()

url_unpooled = os.getenv('DATABASE_URL_UNPOOLED')
if url_unpooled:
    conn2 = psycopg.connect(url_unpooled)
    cur2 = conn2.cursor()
    cur2.execute('SELECT count(*) FROM information_schema.tables WHERE table_schema = \'public\'')
    cnt = cur2.fetchone()[0]
    print(f'  ✓ Neon Direct Endpoint Connected ({cnt} public tables verified)')
    cur2.close()
    conn2.close()
"

echo ""
echo "[2/4] Probing Crusoe Managed Inference & Fallback Diagnostic..."
$VENV_PY -c "
import os, urllib.request, json
from dotenv import load_dotenv
load_dotenv('$PROJECT_ROOT/.env')
key = os.getenv('CRUSOE_API_KEY')
base = os.getenv('MODEL_BASE_URL', 'https://api.inference.crusoecloud.com/v1')
req = urllib.request.Request(f'{base}/models', headers={'Authorization': f'Bearer {key}'})
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())
        print(f'  ✓ Crusoe Cloud Catalog Available ({len(data.get(\"data\", []))} models)')
except Exception as e:
    print(f'  ! Crusoe Catalog Notice: {e}')
"

echo ""
echo "[3/4] Running Comprehensive Backend Test Suite..."
cd "$PROJECT_ROOT/backend"
$VENV_PYTEST tests -v --tb=short

echo ""
echo "[4/4] Verification Succeeded!"
echo "  All contract, physics, orchestration, and integration tests passed."
echo "================================================================="
