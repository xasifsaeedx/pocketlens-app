#!/usr/bin/env bash
# One command for the whole local stack — everything on one machine:
#
#   ./scripts/local-dev.sh
#
#   1. supabase start        local Postgres + Auth (Docker), migrations applied
#   2. sync-service :8000    pointed at the local stack, LAN-reachable (0.0.0.0)
#   3. web :5173             vite wired to the local stack
#
# Deployed configs are untouched: this script only injects env vars for the
# processes it starts.
set -euo pipefail
cd "$(dirname "$0")/.."

# Ensure this worktree's .env files + shared Fernet key exist (idempotent).
# Fixes "env on the wrong worktree" — everything symlinks to one shared dir.
./scripts/setup-local.sh

if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker isn't running — start Docker Desktop and wait for it to be ready, then re-run."
  exit 1
fi

echo "▸ supabase (Docker)…"
(cd finance-backend && supabase start >/dev/null 2>&1 || true)

# Wait for the DB container to be ready before reading status
echo "  waiting for supabase DB to be ready…"
for i in $(seq 1 30); do
  if (cd finance-backend && supabase status -o env >/dev/null 2>&1); then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "✗ supabase DB did not become ready in time. Run: cd finance-backend && supabase start --debug"
    exit 1
  fi
  sleep 2
done
eval "$(cd finance-backend && supabase status -o env | sed 's/^/SB_/')"

# Persistent local Fernet key, shared across ALL worktrees (setup-local.sh owns
# it). Same key everywhere → Plaid secrets stored in the shared local DB always
# decrypt, no matter which worktree started the sync-service.
CREDENTIALS_ENC_KEY="$(cat "${POCKETLENS_LOCAL_DIR:-$HOME/.pocketlens}/credentials-enc.key")"

cleanup() { kill 0 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "▸ sync-service on :8000…"
VENV="${POCKETLENS_LOCAL_DIR:-$HOME/.pocketlens}/venv"
(cd finance-backend/sync-service && \
  SUPABASE_URL="$SB_API_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SB_SERVICE_ROLE_KEY" \
  CREDENTIALS_ENC_KEY="$CREDENTIALS_ENC_KEY" \
  TRIGGER_SECRET=local-dev-secret \
  "$VENV/bin/uvicorn" api:app --host 0.0.0.0 --port 8000) &

echo "▸ web on :5173…"
(cd web && \
  VITE_SUPABASE_URL="$SB_API_URL" \
  VITE_SUPABASE_ANON_KEY="$SB_ANON_KEY" \
  VITE_BACKEND_URL=http://localhost:8000 \
  npm run dev) &

sleep 3
# Best-effort LAN IP for reaching the backend from other devices — cross-platform.
LAN_IP=$( { ipconfig getifaddr en0 2>/dev/null \
  || hostname -I 2>/dev/null | awk '{print $1}' \
  || ip route get 1 2>/dev/null | awk '{print $7; exit}'; } | head -n1)
LAN_IP=${LAN_IP:-<your-lan-ip>}
echo ""
echo "── local stack ─────────────────────────────────────────────"
echo "  web        http://localhost:5173"
echo "  backend    http://localhost:8000   (LAN: http://$LAN_IP:8000)"
echo "  supabase   $SB_API_URL   (Studio: http://localhost:54323)"
echo "  e2e        web/e2e/run-local.sh"
echo "  reset db   (cd finance-backend && supabase db reset)"
echo "────────────────────────────────────────────────────────────"
wait
