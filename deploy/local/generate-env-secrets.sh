#!/usr/bin/env bash
# Fill a copy of .env.example with fresh random secrets, in place.
#
#   deploy/local/generate-env-secrets.sh <env-file> <secret-keys-label>
#
# The one place that knows which keys are secrets: `just init-env` uses it for a
# developer's .env, and the end-to-end harness for each throwaway stack's env
# file. A secret added to .env.example goes in this list.
set -euo pipefail
file="$1"
label="$2"
command -v openssl >/dev/null 2>&1 || { echo "openssl is required to generate secrets." >&2; exit 1; }
for key in DB_PASSWORD DB_OWNER_PASSWORD \
           AGENT_REGISTRATION_TOKEN GATEWAY_ADMIN_PASSWORD; do
  grep -q "^${key}=" "$file" || { echo "$file has no ${key}= line to fill." >&2; exit 1; }
  sed -i.bak "s|^${key}=.*|${key}=$(openssl rand -hex 24)|" "$file"
done
grep -q "^SECRET_KEYS=" "$file" || { echo "$file has no SECRET_KEYS= line to fill." >&2; exit 1; }
sed -i.bak "s|^SECRET_KEYS=.*|SECRET_KEYS=${label}:$(openssl rand -hex 32)|" "$file"
rm -f "$file.bak"
