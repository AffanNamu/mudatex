#!/bin/sh
# Runs when the container starts. API_URL (and, for real sign-in, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY) drive both
# the app (config.js) and the browser's content-security policy, so the two cannot disagree.
set -eu

: "${API_URL:?Set API_URL to the public address of the Mudatex API, for example https://api.example.com}"
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-}"

# Only characters that are safe inside a JavaScript string and an nginx header.
safe() { printf '%s' "$2" | grep -Eq "^[A-Za-z0-9:/._~%@-]+$" || { echo "$1 contains characters that are not allowed" >&2; exit 1; }; }
url() {
  case "$2" in http://*|https://*) ;; *) echo "$1 must start with http:// or https://" >&2; exit 1 ;; esac
  safe "$1" "$2"
}
origin() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#'; }

url API_URL "$API_URL"
if [ -n "$SUPABASE_URL" ] || [ -n "$SUPABASE_PUBLISHABLE_KEY" ]; then
  [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_PUBLISHABLE_KEY" ] || { echo "Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, or neither" >&2; exit 1; }
  case "$SUPABASE_URL" in https://*) ;; *) echo "SUPABASE_URL must start with https://" >&2; exit 1 ;; esac
  url SUPABASE_URL "$SUPABASE_URL"
  safe SUPABASE_PUBLISHABLE_KEY "$SUPABASE_PUBLISHABLE_KEY"
  case "$SUPABASE_PUBLISHABLE_KEY" in sb_secret_*|*service_role*) echo "That looks like a secret key. Use the publishable (anon) key only." >&2; exit 1 ;; esac
fi

API_ORIGIN=$(origin "$API_URL")
if [ -n "$SUPABASE_URL" ]; then CONNECT_ORIGINS="$API_ORIGIN $(origin "$SUPABASE_URL")"; else CONNECT_ORIGINS="$API_ORIGIN"; fi
export CONNECT_ORIGINS

printf 'window.__MUDATEX__ = { apiUrl: "%s", supabaseUrl: "%s", supabaseKey: "%s" };\n' "$API_URL" "$SUPABASE_URL" "$SUPABASE_PUBLISHABLE_KEY" > /usr/share/nginx/html/config.js
envsubst '${CONNECT_ORIGINS}' < /etc/nginx/templates-mudatex/nginx.conf.template > /etc/nginx/conf.d/default.conf
