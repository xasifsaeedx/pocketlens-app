#!/usr/bin/env bash
# Migration-version linter — kill the collision class.
#
# Supabase keys `schema_migrations` by version (the 14-digit UTC timestamp
# prefix) ONLY. Two branches minting the same version is a known failure mode:
# a fresh-DB apply fails loudly, but a prod `db push` SILENTLY
# SKIPS the loser — its migration just never applies. This guard fails on any
# duplicate version prefix so the collision is caught in review.
#
# Uniqueness is the hard requirement and the only failure condition. Non-
# monotonic ordering is deliberately NOT checked — there is an intentionally
# back-dated migration, and it is harmless.
#
# Usage:  finance-backend/scripts/check_migration_versions.sh
# Exit:   0 = all versions unique · 1 = a duplicate version was found.
set -eu

# Resolve the migrations dir relative to this script, so it works from any cwd.
script_dir=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
migrations_dir="$script_dir/../supabase/migrations"

if [ ! -d "$migrations_dir" ]; then
  echo "error: migrations dir not found: $migrations_dir" >&2
  exit 2
fi

# Collect the 14-digit version prefix of every *.sql migration.
# Filenames look like: 20260704012616_activity_log.sql
versions=""
count=0
for f in "$migrations_dir"/*.sql; do
  [ -e "$f" ] || continue  # no matches → glob stays literal; skip it
  base=$(basename "$f")
  version=$(printf '%s\n' "$base" | grep -oE '^[0-9]{14}' || true)
  if [ -z "$version" ]; then
    echo "warning: '$base' has no 14-digit version prefix — skipping" >&2
    continue
  fi
  versions="$versions$version $base
"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "error: no versioned migrations found in $migrations_dir" >&2
  exit 2
fi

# Duplicate versions → hard failure. Group by version, report every collision.
dupes=$(printf '%s' "$versions" | awk '{ print $1 }' | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "FAIL: duplicate migration version(s) found:" >&2
  for v in $dupes; do
    echo "  version $v is used by:" >&2
    printf '%s' "$versions" | awk -v v="$v" '$1 == v { print "    " $2 }' >&2
  done
  echo "Rename one with a real timestamp: (cd finance-backend && supabase migration new <name>)." >&2
  exit 1
fi

echo "OK: $count migrations, all versions unique."
