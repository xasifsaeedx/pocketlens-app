#!/usr/bin/env bash
# Local-stack e2e: signup + data isolation + onboarding wizard.
#
# Needs three things running (starts none of them itself, but tells you what's missing):
#   1. supabase start                    (from finance-backend/ — local Postgres+Auth, migrations applied)
#   2. sync-service on :8000 pointed at the LOCAL stack:
#        cd finance-backend && eval "$(supabase status -o env | sed 's/^/export SB_/')" && cd sync-service && \
#        SUPABASE_URL=$SB_API_URL SUPABASE_SERVICE_ROLE_KEY=$SB_SERVICE_ROLE_KEY \
#        CREDENTIALS_ENC_KEY=$(cat "${POCKETLENS_LOCAL_DIR:-$HOME/.pocketlens}/credentials-enc.key") \
#        uvicorn api:app --port 8000
#      (Easier: just run ./scripts/local-dev.sh, which starts 1–3 for you.)
#   3. vite on :5173 pointed at the LOCAL stack:
#        cd web && VITE_SUPABASE_URL=$SB_API_URL VITE_SUPABASE_ANON_KEY=$SB_ANON_KEY \
#        VITE_BACKEND_URL=http://localhost:8000 npm run dev
set -euo pipefail
cd "$(dirname "$0")/.."          # web/
REPO_ROOT="$(cd .. && pwd)"

eval "$(cd "$REPO_ROOT/finance-backend" && supabase status -o env 2>/dev/null | sed 's/^/export SB_/')" \
  || { echo "supabase local stack not running — cd finance-backend && supabase start"; exit 1; }

curl -sf http://localhost:8000/health >/dev/null \
  || { echo "sync-service not on :8000 — see comment in this script"; exit 1; }
curl -sf http://localhost:5173 >/dev/null \
  || { echo "vite not on :5173 — see comment in this script"; exit 1; }

export E2E_SUPABASE_URL="$SB_API_URL"
export E2E_ANON_KEY="$SB_ANON_KEY"
export E2E_SERVICE_ROLE_KEY="$SB_SERVICE_ROLE_KEY"
export E2E_BACKEND_URL="http://localhost:8000"

npx playwright test signup isolation wizard "$@"
