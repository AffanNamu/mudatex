#!/bin/sh
# Runs when the container starts. One setting, API_URL, drives both the app (config.js) and the browser's
# content-security policy, so they cannot disagree.
set -eu

: "${API_URL:?Set API_URL to the public address of the Mudatex API, for example https://api.example.com}"
case "$API_URL" in
  http://*|https://*) ;;
  *) echo "API_URL must start with http:// or https://" >&2; exit 1 ;;
esac
# Only characters that are safe inside a JavaScript string and an nginx header.
if printf '%s' "$API_URL" | grep -Eq "[^A-Za-z0-9:/._~%@-]"; then
  echo "API_URL contains characters that are not allowed" >&2; exit 1
fi

API_ORIGIN=$(printf '%s' "$API_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
export API_ORIGIN

printf 'window.__MUDATEX__ = { apiUrl: "%s" };\n' "$API_URL" > /usr/share/nginx/html/config.js
envsubst '${API_ORIGIN}' < /etc/nginx/templates-mudatex/nginx.conf.template > /etc/nginx/conf.d/default.conf
