#!/usr/bin/env bash
# Proves a backup file can be restored: restores it into an EMPTY scratch database and checks that the copy is whole.
#   SCRATCH_DATABASE_URL=postgres://…/scratch BACKUP_PASSPHRASE=… scripts/restore-check.sh mudatex-….dump[.gpg]
# The scratch database is wiped first. NEVER point it at the live database. Run after `npm run build` (in apps/api).
set -euo pipefail
: "${SCRATCH_DATABASE_URL:?SCRATCH_DATABASE_URL is required (an empty database that may be wiped)}"
file="${1:?usage: restore-check.sh <backup file>}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }

if [ -f "$file.sha256" ]; then ( cd "$(dirname "$file")" && sha256sum --check --quiet "$(basename "$file").sha256" ); fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dump="$file"
if [[ "$file" == *.gpg ]]; then
  : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required to open an encrypted backup}"
  dump="$work/restored.dump"
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt --output "$dump" "$file"
fi

# btree_gist is the one extension the schema needs (migration 0005); it is not part of a schema-only dump.
psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'SET client_min_messages = warning; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS btree_gist;'
# The dump may carry the creation of the public schema, which the line above has just done.
pg_restore --list "$dump" | grep -vE '; [0-9]+ [0-9]+ SCHEMA - public ' > "$work/list" || true
pg_restore --use-list="$work/list" --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_DATABASE_URL" "$dump"
DATABASE_URL="$SCRATCH_DATABASE_URL" node "$(dirname "$0")/../dist/verify-cli.js"
echo "restore check passed: $file"
