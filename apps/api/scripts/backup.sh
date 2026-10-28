#!/usr/bin/env bash
# Takes a backup of the database to a file you can keep somewhere else, encrypted when BACKUP_PASSPHRASE is set.
#   DATABASE_URL=postgres://… BACKUP_PASSPHRASE=… scripts/backup.sh [output-directory]
# Use the database's DIRECT (or session-pooler, port 5432) connection string, never the transaction pooler (port 6543).
# Needs pg_dump at least as new as the server. Prints the path of the finished file.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required (the database to back up)}"
out="${1:-.}"
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out/mudatex-$stamp.dump"

# Custom format: compressed, and restorable table by table. Ownership and grants belong to the hosting provider, not to the data.
# Only our own schema: the provider's own schemas (accounts, storage, …) are covered by the provider's backups.
pg_dump --format=custom --no-owner --no-privileges --schema=public --file="$file" "$DATABASE_URL"
pg_restore --list "$file" >/dev/null   # the file must at least be readable

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 --output "$file.gpg" "$file"
  rm -f "$file"
  file="$file.gpg"
else
  echo "warning: BACKUP_PASSPHRASE is not set, so this file is NOT encrypted. It holds customer data." >&2
fi
( cd "$out" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
echo "$file"
