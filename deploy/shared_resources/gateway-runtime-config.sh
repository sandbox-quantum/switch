#!/bin/sh
# Writes the gateway's runtime configuration from the environment.
#
# The gateway is a static bundle served by nginx, and the image is published
# prebuilt — so per-deployment values cannot be baked in at build time. This
# runs from nginx's /docker-entrypoint.d before the server starts and emits the
# config.js that index.html loads ahead of the app.
set -eu

CONFIG_PATH="/usr/share/nginx/html/config.js"

# Escape for embedding in a double-quoted JS string literal.
js_string() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

MUI_KEY="$(js_string "${MUI_X_LICENSE_KEY:-}")"

cat > "$CONFIG_PATH" <<EOF
window.__SWITCH_GATEWAY_CONFIG__ = {
  muiXLicenseKey: "${MUI_KEY}",
};
EOF

if [ -z "${MUI_X_LICENSE_KEY:-}" ]; then
  echo "gateway: MUI_X_LICENSE_KEY is not set — data grids will render with the MUI X watermark." >&2
fi
