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
keys=(DB_PASSWORD DB_OWNER_PASSWORD AGENT_REGISTRATION_TOKEN GATEWAY_ADMIN_PASSWORD
      CONTROLLER_TOKEN_SECRET MATTERMOST_ADMIN_PASSWORD MATTERMOST_USER_PASSWORD)
command -v openssl >/dev/null 2>&1 || { echo "openssl is required to generate secrets." >&2; exit 1; }

for key in "${keys[@]}" SECRET_KEYS; do
  grep -q "^${key}=" "$file" || { echo "$file has no ${key}= line to fill." >&2; exit 1; }
done

work="$(mktemp -d "$(dirname "$file")/.switch-secrets.XXXXXX")"
trap 'rm -rf "$work"' EXIT
draft="$work/env"
cp -p "$file" "$draft"

for key in "${keys[@]}"; do
  value="$(openssl rand -hex 24)" || { echo "Could not generate $key." >&2; exit 1; }
  sed -i.bak "s|^${key}=.*|${key}=${value}|" "$draft"
done
value="$(openssl rand -hex 32)" || { echo "Could not generate SECRET_KEYS." >&2; exit 1; }
sed -i.bak "s|^SECRET_KEYS=.*|SECRET_KEYS=${label}:${value}|" "$draft"
mv "$draft" "$file"
