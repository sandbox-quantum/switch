#!/bin/sh
# PROPOSED, not applied. pid 1 in the squid container (per-box allow-lists).
# Starts squid, reloads it when its mounted per-box files or password hashes change, and passes a stop on to it.
#   - A change is reloaded only if `squid -k parse` passes; otherwise one ERROR line, and squid keeps its config.
#   - SIGHUP reloads without dropping open tunnels. Nothing outside this container is ever touched.
#   - SIGTERM or SIGINT is passed on to squid, and this exits with squid's own status.
#   - Once a day it sends squid SIGUSR1, which rotates its logs; squid.conf's `logfile_rotate 3` keeps three old
#     ones. The access log names the box for every host, so it stays short-lived and on the proxy only.
# Settings (environment, for the tests; the defaults are the real paths):
#   SQUID_CONF (default /etc/squid/conf.d/squid.conf), SQUID_WATCH (space-separated folders, default
#   "/etc/squid/boxes /etc/squid/passwd"), SQUID_RELOAD_EVERY (seconds, default 30), SQUID_ROTATE_EVERY (seconds,
#   default 86400).
set -u
CONF=${SQUID_CONF:-/etc/squid/conf.d/squid.conf}
WATCH=${SQUID_WATCH:-/etc/squid/boxes /etc/squid/passwd}
EVERY=${SQUID_RELOAD_EVERY:-30}
ROTATE_EVERY=${SQUID_ROTATE_EVERY:-86400}

squid -N -f "$CONF" &
SQUID=$!
stop() { kill -TERM "$SQUID" 2>/dev/null; wait "$SQUID"; exit $?; }
trap stop TERM INT

# What's mounted, as one checksum. A ConfigMap or Secret mounted as a whole folder shows its files through
# symlinks, which `cat` follows; the hidden ..data folder isn't matched by *.
stamp() { for d in $WATCH; do cat "$d"/* 2>/dev/null; done | cksum; }

last=$(stamp)
waited=0
while kill -0 "$SQUID" 2>/dev/null; do
  sleep "$EVERY" &
  wait $!
  waited=$(awk -v w="$waited" -v e="$EVERY" 'BEGIN { print w + e }')
  if awk -v w="$waited" -v r="$ROTATE_EVERY" 'BEGIN { exit !(w >= r) }'; then
    kill -USR1 "$SQUID" && echo "squid-reload: logs rotated"
    waited=0
  fi
  now=$(stamp)
  [ "$now" = "$last" ] && continue
  last=$now
  if squid -k parse -f "$CONF" >/dev/null 2>&1; then
    kill -HUP "$SQUID" && echo "squid-reload: files changed and parse; reloaded"
  else
    echo "squid-reload: ERROR new files do not parse; squid keeps its current config" >&2
  fi
done
wait "$SQUID"
exit $?
