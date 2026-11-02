#!/bin/bash
# Stand-in tests for squid-reload.sh: a fake `squid` on PATH records what it was asked to do.
# Run: bash test-squid-reload.sh   (needs only sh, bash and coreutils; no squid, no cluster)
set -u
HERE=$(cd "$(dirname "$0")" && pwd); pass=0; fail=0
ok() { pass=$((pass+1)); echo "PASS $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1"; }
setup() {
  T=$(mktemp -d); mkdir -p "$T/bin" "$T/boxes" "$T/passwd"; echo "a" > "$T/boxes/ada.conf"; echo "box-ada:x" > "$T/passwd/passwd"
  # fake squid: `squid -N ...` runs until signalled; `squid -k parse` passes unless $T/bad exists
  cat > "$T/bin/squid" <<FAKE
#!/bin/bash
if [ "\$1" = "-k" ]; then echo parse >> "$T/log"; [ -e "$T/bad" ] && exit 1; exit 0; fi
echo start >> "$T/log"
trap 'echo hup >> "$T/log"' HUP
trap 'echo usr1 >> "$T/log"' USR1
trap 'echo term >> "$T/log"; exit 7' TERM
while :; do sleep 0.1; done
FAKE
  chmod +x "$T/bin/squid"
  PATH="$T/bin:$PATH" SQUID_CONF="$T/squid.conf" SQUID_WATCH="$T/boxes $T/passwd" SQUID_RELOAD_EVERY=0.3 SQUID_ROTATE_EVERY=${ROTATE:-1000} \
    sh "$HERE/squid-reload.sh" > "$T/out" 2>&1 &
  W=$!; sleep 0.5
}
count() { grep -c "^$1\$" "$T/log" 2>/dev/null || true; }

setup
[ "$(count start)" = 1 ] && ok "starts squid once" || bad "starts squid once"
sleep 0.8; [ "$(count hup)" = 0 ] && [ "$(count parse)" = 0 ] && ok "no change, no reload" || bad "no change, no reload"
echo "b" >> "$T/boxes/ada.conf"; sleep 1
[ "$(count parse)" = 1 ] && [ "$(count hup)" = 1 ] && ok "a changed box file is parsed then reloaded" || bad "changed box file: $(cat "$T/log")"
echo "box-bo:y" >> "$T/passwd/passwd"; sleep 1
[ "$(count hup)" = 2 ] && ok "a changed password file is reloaded" || bad "changed password file"
touch "$T/bad"; echo "c" >> "$T/boxes/ada.conf"; sleep 1
[ "$(count hup)" = 2 ] && grep -q "ERROR new files do not parse" "$T/out" && ok "a file that won't parse is never loaded" || bad "bad parse: $(cat "$T/out")"
sleep 1; [ "$(count parse)" = 3 ] && ok "a bad file is reported once, not every pass" || bad "bad file reported $(count parse) parses"
kill -TERM "$W"; wait "$W"; rc=$?
[ "$(count term)" = 1 ] && [ "$rc" = 7 ] && ok "a stop is passed on and squid's status returned" || bad "stop: rc=$rc log=$(cat "$T/log")"
rm -rf "$T"

setup
pkill -TERM -f "$T/bin/squid -N" ; wait "$W"; rc=$?
[ "$rc" = 7 ] && ok "if squid dies, the watcher exits with its status (so the pod restarts)" || bad "squid died: rc=$rc"
rm -rf "$T"

ROTATE=0.9 setup
sleep 2.2; n=$(count usr1)
[ "$n" -ge 1 ] && [ "$n" -le 3 ] && [ "$(count hup)" = 0 ] && ok "logs rotate on schedule, without a reload" || bad "rotate: $n usr1, log=$(cat "$T/log")"
kill -TERM "$W"; wait "$W"; rm -rf "$T"
echo "# $pass passed, $fail failed"; [ "$fail" = 0 ]
