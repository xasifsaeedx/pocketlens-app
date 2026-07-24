#!/usr/bin/env bash
# Make THIS worktree ready to run the local stack — idempotent, safe to re-run.
#
#   ./scripts/setup-local.sh
#
# Fixes the "env is on the wrong worktree" problem. Every local secret / env
# file lives in ONE shared directory (default ~/.pocketlens) and each worktree
# gets a *symlink* to it. Edit the file once and every worktree — current and
# future — sees the change. Nothing here is committed (.env* is gitignored, and
# a symlink can't be staged anyway).
#
# Shared files:
#   web.env               → web/.env                          (Vite: Supabase + backend URLs)
#   sync-service.env      → finance-backend/sync-service/.env (Supabase + Plaid/house creds)
#   credentials-enc.key   → the Fernet key that encrypts Plaid secrets in the
#                           LOCAL Supabase DB. Must be identical across worktrees
#                           or previously-linked banks stop decrypting.
#
# Override the shared dir with POCKETLENS_LOCAL_DIR if you want it elsewhere.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SHARED="${POCKETLENS_LOCAL_DIR:-$HOME/.pocketlens}"
mkdir -p "$SHARED"

# ── Preflight: fail loud + actionable, not 60s later with a cryptic error ─────
need() { command -v "$1" >/dev/null 2>&1; }
MISSING=0
say_missing() { echo "✗ $1"; MISSING=1; }

need docker    || say_missing "Docker not found — install Docker: https://docs.docker.com/get-docker/"
need supabase  || say_missing "Supabase CLI not found — install: https://supabase.com/docs/guides/local-development/cli/getting-started"
need node      || say_missing "Node not found (need 20+) — https://nodejs.org/ or your package manager (brew/apt/dnf/choco)"
need python3   || say_missing "python3 not found (need 3.11+) — https://www.python.org/downloads/ or your package manager"
# (Docker only needs to be *running* for local-dev.sh's supabase start — checked there.)
if [ "$MISSING" -ne 0 ]; then
  echo ""
  echo "Install the tools listed above with your platform's package manager (brew on macOS,"
  echo "apt/dnf on Linux, choco/scoop on Windows), then re-run."
  exit 1
fi

# seed_and_link <canonical-name> <path-in-worktree> <template-if-seeding>
# 1. Ensure the canonical file exists in $SHARED — adopt an existing real file
#    from this worktree if there is one (preserves your current values),
#    otherwise seed from the committed template.
# 2. Replace the worktree path with a symlink to the canonical file.
seed_and_link() {
  local canon="$SHARED/$1" wt="$ROOT/$2" template="$ROOT/$3"
  if [ ! -e "$canon" ]; then
    if [ -f "$wt" ] && [ ! -L "$wt" ]; then
      mv "$wt" "$canon"                       # adopt this worktree's real file
      echo "  adopted $2 → $canon"
    elif [ -f "$template" ]; then
      cp "$template" "$canon"                 # first-time seed from example
      echo "  seeded  $canon (from $3 — fill in real values)"
    else
      : > "$canon"
    fi
  fi
  if [ ! -L "$wt" ] || [ "$(readlink "$wt")" != "$canon" ]; then
    rm -f "$wt"
    ln -s "$canon" "$wt"
    echo "  linked  $2 → $canon"
  fi
}

echo "▸ linking env files to $SHARED …"
seed_and_link web.env          web/.env                          web/.env.example
seed_and_link sync-service.env finance-backend/sync-service/.env finance-backend/sync-service/.env.example

# Persistent local Fernet key, shared across worktrees. Adopt a legacy
# per-worktree .env.localstack key if one exists so already-stored Plaid
# secrets in the local DB keep decrypting; otherwise generate once.
KEY="$SHARED/credentials-enc.key"
LEGACY="$ROOT/finance-backend/sync-service/.env.localstack"
if [ ! -f "$KEY" ]; then
  if [ -f "$LEGACY" ]; then
    grep '^CREDENTIALS_ENC_KEY=' "$LEGACY" | head -1 | cut -d= -f2- > "$KEY"
    echo "  adopted Fernet key from legacy .env.localstack"
  else
    python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())' > "$KEY"
    echo "  generated Fernet key → $KEY"
  fi
fi
# Legacy per-worktree key is now dead weight — point it at the shared one so any
# stale tooling that still sources it gets the right value.
if [ -f "$LEGACY" ] && [ ! -L "$LEGACY" ]; then
  printf 'CREDENTIALS_ENC_KEY=%s\n' "$(cat "$KEY")" > "$LEGACY"
fi

# ── Shared Python venv for the sync-service ──────────────────────────────────
# One venv for all worktrees (requirements are identical; its abs path is stable
# at $SHARED/venv so it's safe to reuse). No global-python pollution, no
# per-worktree reinstall. Rebuild after a requirements bump: POCKETLENS_REINSTALL=1.
VENV="$SHARED/venv"
REQ="$ROOT/finance-backend/sync-service/requirements-dev.txt"
if [ ! -x "$VENV/bin/uvicorn" ] || [ "${POCKETLENS_REINSTALL:-}" = "1" ]; then
  echo "▸ python venv → $VENV (installing deps, first run is slow)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$REQ"
  echo "  deps installed"
fi

# ── Web deps (per-worktree; node_modules isn't safely shareable) ─────────────
if [ ! -d "$ROOT/web/node_modules" ]; then
  echo "▸ web deps → web/node_modules (npm ci)…"
  (cd "$ROOT/web" && npm ci --no-audit --no-fund)
fi

echo "✓ local env ready (shared: $SHARED)"
