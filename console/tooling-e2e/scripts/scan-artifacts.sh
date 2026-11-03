#!/usr/bin/env bash
# Fail if any file under a directory contains one of the secrets a run used.
#
#   printf '%s\n' "$TOKEN" "$PASSWORD" | scan-artifacts.sh <dir>
#
# Reads the secret values on stdin, one per line, and lists every file that
# holds one, by name only: the point is to keep the values out of an uploaded
# artifact, so the report must not print them either. Exact values are what a
# run's own logs leak, and a pattern scanner cannot know them; run a generic
# scanner (gitleaks) as well for anything else.
#
# Values shorter than 8 characters are ignored: no generated secret is that
# short, and a short one would match ordinary text.
set -euo pipefail

DIR="${1:?usage: scan-artifacts.sh <dir> (secret values on stdin)}"
[ -d "$DIR" ] || { echo "scan-artifacts: $DIR is not a directory" >&2; exit 2; }

PATTERNS="$(mktemp)"
trap 'rm -f "$PATTERNS"' EXIT
chmod 600 "$PATTERNS"
while IFS= read -r value || [ -n "$value" ]; do
  [ "${#value}" -ge 8 ] && printf '%s\n' "$value" >>"$PATTERNS"
done

if [ ! -s "$PATTERNS" ]; then
  echo "scan-artifacts: no secret values were given to scan for" >&2
  exit 2
fi

# grep exits 1 for no match, but 2 for a read error even when it also matched,
# so only 1 passes: a file the scan could not read is not a file known clean.
set +e
LEAKS="$(grep -rlF -f "$PATTERNS" -- "$DIR")"
status=$?
set -e
case "$status" in
  0)
    echo "scan-artifacts: these files contain a secret value from this run; nothing will be uploaded:" >&2
    sed 's/^/  /' <<<"$LEAKS" >&2
    exit 1 ;;
  1) ;;
  *)
    echo "scan-artifacts: grep failed (exit $status) under $DIR; refusing to pass the scan" >&2
    exit 2 ;;
esac
echo "scan-artifacts: $(grep -c '' "$PATTERNS") secret values, none found under $DIR."
