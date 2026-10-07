#!/bin/bash
# Runs inside the gate container after setup.sh. Each check prints PASS or
# FAIL (or KNOWN, for a documented gap that does not fail the gate), and the
# script exits non-zero when any check failed.
#
#   checks.sh            every assertion
#   checks.sh 1 3 4      only those
set -uo pipefail
source /src/deploy/hosted/vm/gate/container/gate.env
LOG=/var/lib/cc-gate/checks.log
: >"$LOG"
FAILED=0
SUMMARY=()

section() { printf '\n== %s\n' "$*"; SECTION=$1; }
record() {
  local verdict=$1 name=$2 detail=${3:-}
  printf '%-5s [%s] %s%s\n' "$verdict" "$SECTION" "$name" "${detail:+ -- $detail}"
  SUMMARY+=("$verdict [$SECTION] $name")
  [ "$verdict" = FAIL ] && FAILED=$((FAILED + 1))
  return 0
}
pass() { record PASS "$@"; }
fail() { record FAIL "$@"; }
known() { record KNOWN "$@"; }
brief() { tr '\n' ' ' <<<"$1" | cut -c 1-240; }
# check NAME CMD...: PASS when the command succeeds.
check() {
  local name=$1 out; shift
  if out=$("$@" 2>&1); then pass "$name"; else fail "$name" "$(brief "$out")"; fi
  printf -- '--- %s\n%s\n' "$name" "$out" >>"$LOG"
}
# denied NAME CMD...: PASS when the command fails.
denied() {
  local name=$1 out; shift
  out=$("$@" 2>&1)
  case $? in
    0) fail "$name" "it succeeded: $(brief "$out")" ;;
    125) fail "$name" "the gate could not run it: $(brief "$out")" ;;
    *) pass "$name" "$(brief "$out" | cut -c 1-90)" ;;
  esac
  printf -- '--- %s\n%s\n' "$name" "$out" >>"$LOG"
}
in_agent() { timeout 30 bash "$GATE_DIR/in-agent.sh" "$@"; }
in_a1() { in_agent "$A1" "$@"; }
as_agent() { setpriv --reuid=switch-agent --regid=switch-agent --init-groups --no-new-privs -- "$@"; }
as_controller() { setpriv --reuid=switch-controller --regid=switch-controller --init-groups -- "$@"; }
stub_get() { curl -fsS "$STUB_ADMIN$1"; }
stub_post() { curl -fsS -X POST -H 'Content-Type: application/json' --data "$2" "$STUB_ADMIN$1"; }
until_true() {
  local tries=$1; shift
  for _ in $(seq "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
# until_eval N 'EXPRESSION': like until_true, but the expression (quoted, so
# its $(...) are not expanded at the call) is evaluated afresh on every try.
until_eval() {
  local tries=$1; shift
  for _ in $(seq "$tries"); do eval "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
unit() { echo "switch-agent@$1.service"; }
invocation() { systemctl show -p InvocationID --value "$(unit "$1")"; }
active() { [ "$(systemctl is-active "$(unit "$1")")" = active ]; }
health() { jq -r "$2" "/data/agents/$1/watcher/health.json" 2>/dev/null; }
connected() { active "$1" && [ "$(health "$1" .state)" = connected ] && [ "$(health "$1" .invocation)" = "$(invocation "$1")" ]; }
# The unit's main process is the root unshare wrapper; its child is the
# agent's init (PID 1 of the agent's PID namespace), and the init's child is
# the agent host.
agent_init_pid() { pgrep -P "$(systemctl show -p MainPID --value "$(unit "$1")")" | head -1; }
agent_host_pid() { pgrep -P "$(agent_init_pid "$1")" | head -1; }
# a1_sees_process REGEX [PID]: agent 1's /proc lists a process (PID, or any)
# whose command line matches REGEX. Exits 125 if the gate cannot look.
a1_sees_process() {
  local listing
  listing=$(in_a1 sh -c 'for d in /proc/${1:-[0-9]*}; do [ -r "$d/cmdline" ] && printf "%s %s\n" "${d#/proc/}" "$(tr "\0" " " <"$d/cmdline")"; done; exit 0' _ "${2:-}") || return 125
  [ -n "$listing" ] || return 125
  printf '%s\n' "$listing" | cut -d' ' -f2- | grep -Eq -- "$1"
}
# stays_active TRIES SECONDS AGENT: within TRIES seconds the unit is active for
# SECONDS in a row without restarting.
stays_active() {
  local tries=$1 hold=$2 agent=$3 run=0 pid last=""
  for _ in $(seq "$tries"); do
    pid=$(systemctl show -p MainPID --value "$(unit "$agent")")
    if active "$agent" && [ "$pid" != 0 ] && [ "$pid" = "$last" ]; then
      run=$((run + 1)); [ "$run" -ge "$hold" ] && return 0
    else
      run=0
    fi
    last=$pid
    sleep 1
  done
  return 1
}
both_connected() { connected "$A1" && connected "$A2"; }
provider_revision() { in_agent "$1" cat "/run/credentials/$(unit "$1")/provider" | jq -r .revision; }
latest_report() { stub_get /state | jq -c --arg a "$1" '.status_reports[-1].agents[] | select(.agent_id == $a)'; }
status_count() { stub_get /state | jq .status_count; }
wait_reports() {
  local target; target=$(($(status_count) + $1))
  until_eval 30 '[ "$(status_count)" -ge "$target" ]'
}
controller_pid() { systemctl show -p MainPID --value switch-controller.service; }
journal_since() { journalctl -u "$1" --since "@$2" -o cat --no-pager; }

ROOM=00000000-0000-4000-8000-0000000000b1
# Hands an agent one addressed room message, as Core would: the room first,
# then the event. A body containing GATE_HOLD keeps the fake provider's turn
# open, so the agent reports itself busy until hold_release.
hold_busy() {
  local agent=$1 seq; seq=$(date +%s%3N)
  stub_post /frame "$(jq -nc --arg a "$agent" --arg r "$ROOM" '{event: "agent.rooms", data: {agent_id: $a, rooms: [$r]}}')" >/dev/null
  stub_post /frame "$(jq -nc --arg a "$agent" --arg r "$ROOM" --argjson s "$seq" '{event: "agent.event", data: {
      agent_id: $a, seq: $s, event: {type: "message", room_id: $r, sequence: $s, missed: {count: 0, reason: null},
        payload: {addressed: true, sender: "@gate-user:switch-gate.test", sender_name: "Gate User", sender_kind: "user",
          message_id: ("$gate-" + ($s | tostring)), body: "GATE_HOLD stay busy", timestamp: $s, thread_id: null}}}}')" >/dev/null
  until_eval 60 '[ "$(health "$agent" .busy)" = true ]'
}
hold_release() {
  local agent=$1 cgroup pid
  cgroup=$(systemctl show -p ControlGroup --value "$(unit "$agent")")
  for pid in $(pgrep -f /opt/switch/claude/bin/claude); do
    grep -q "$cgroup" "/proc/$pid/cgroup" 2>/dev/null && kill -USR1 "$pid"
  done
  return 0
}

preflight() {
  section pre
  check "both agent units are active and connected" until_true 90 both_connected
  check "in-agent runs as switch-agent" test "$(in_agent "$A1" id -un)" = switch-agent
  check "in-agent sees the agent's own files" in_agent "$A1" cat "/data/agents/$A1/home/notes.txt"
}

# ── 1 ──────────────────────────────────────────────────────────────────────
assert_1() {
  section 1 "the agent user is confined"
  local path cpid p2
  for path in /run/switch-controller /run/switch-controller/agents /data/.switch-controller /run/switch-machine \
    /run/credentials/switch-controller.service; do
    denied "agent unit cannot list $path" in_a1 ls "$path"
    denied "switch-agent outside a unit cannot list $path" as_agent ls "$path"
  done
  for path in "/run/switch-controller/agents/$A1.provider.json" "/run/switch-controller/agents/$A1.credentials.json" \
    /data/.switch-controller/controller.db /run/switch-machine/controller-credential /run/switch-machine/controller.json \
    /run/credentials/switch-controller.service/controller; do
    denied "agent unit cannot read $path" in_a1 cat "$path"
    denied "switch-agent outside a unit cannot read $path" as_agent cat "$path"
  done
  cpid=$(controller_pid)
  denied "agent unit cannot see the controller's process (ProtectProc)" in_a1 test -e "/proc/$cpid/status"
  denied "agent unit cannot read the controller's environment" in_a1 cat "/proc/$cpid/environ"

  local token=(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
  check "root reaches IMDS" "${token[@]}"
  denied "agent unit cannot reach IMDS (IPAddressDeny)" in_a1 "${token[@]}"
  denied "switch-agent outside a unit cannot reach IMDS (nftables)" as_agent "${token[@]}"

  cat >/etc/systemd/system/cc-gate-probe.service <<'EOF'
[Unit]
Description=cc-gate probe unit (nothing should be able to start it but root)
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
EOF
  systemctl daemon-reload
  denied "agent unit cannot systemctl start a unit" in_a1 systemctl --no-ask-password start cc-gate-probe.service
  denied "agent unit cannot systemctl stop another agent" in_a1 systemctl --no-ask-password stop "$(unit "$A2")"
  denied "agent unit cannot systemctl restart itself" in_a1 systemctl --no-ask-password restart "$(unit "$A1")"
  denied "switch-agent outside a unit cannot systemctl start a unit" as_agent systemctl --no-ask-password start cc-gate-probe.service
  check "the probe unit never started" test "$(systemctl is-active cc-gate-probe.service)" = inactive
  check "agent 2 is still running" active "$A2"

  check "agent unit reads its own notes" in_a1 cat "/data/agents/$A1/home/notes.txt"
  denied "agent unit cannot list another agent's root" in_a1 ls "/data/agents/$A2"
  denied "agent unit cannot read another agent's notes" in_a1 cat "/data/agents/$A2/home/notes.txt"
  denied "agent unit cannot list another agent's worktree" in_a1 ls "/data/worktrees/$A2"
  denied "agent unit cannot write the shared repository mirror" in_a1 touch /data/repos/acme/widgets.git/hooks/planted
  denied "switch-agent outside a unit cannot read another agent's notes" as_agent cat "/data/agents/$A2/home/notes.txt"
  # Both agents run as the one switch-agent uid, so ProtectProc=invisible
  # (which hides other users' processes) does not separate them; each agent's
  # PID namespace does, and with it /proc/<pid>/root into the other's mounts.
  p2=$(agent_host_pid "$A2")
  check "agent 1's PID 1 is its own init" a1_sees_process '^/usr/bin/python3 -I -S /usr/local/libexec/switch-agent-init ' 1
  check "agent 1 sees its own agent host" a1_sees_process "shared-host-daemon.mjs --unit /data/agents/$A1/watcher"
  denied "agent 1 sees no process of agent 2" a1_sees_process "$A2"
  denied "agent 1 sees no process outside its unit" a1_sees_process 'switch-controller|systemd|unshare'
  denied "agent unit cannot read another agent's notes through /proc/<pid>/root" \
    in_a1 sh -c 'cat "$1" >/dev/null' _ "/proc/$p2/root/data/agents/$A2/home/notes.txt"
  denied "agent unit cannot read another agent's relay credential through /proc/<pid>/root" \
    in_a1 sh -c 'cat "$1" >/dev/null' _ "/proc/$p2/root/run/credentials/$(unit "$A2")/agent"
  check "the agent host runs as switch-agent with no capabilities" \
    sh -c "grep -qx 'CapEff:	0000000000000000' /proc/$p2/status && test \"\$(stat -c %U /proc/$p2)\" = switch-agent"
}

# ── 2 ──────────────────────────────────────────────────────────────────────
assert_2() {
  section 2 "the controller may manage agent units only"
  local probe=gate-polkit
  # A throwaway instance of the real template, its agent-specific parts reset
  # so it runs without an agent behind it.
  install -d "/etc/systemd/system/switch-agent@$probe.service.d"
  cat >"/etc/systemd/system/switch-agent@$probe.service.d/cc-gate.conf" <<'EOF'
[Unit]
AssertPathIsMountPoint=
[Service]
LoadCredential=
EnvironmentFile=
ExecStartPre=
ExecStart=
ExecStart=/bin/sleep infinity
TemporaryFileSystem=
BindPaths=
BindReadOnlyPaths=
WorkingDirectory=/
Restart=no
EOF
  systemctl daemon-reload
  local sc=(systemctl --no-ask-password)
  check "controller can start switch-agent@$probe" as_controller "${sc[@]}" start "switch-agent@$probe.service"
  check "  ... and it is running" test "$(systemctl is-active "switch-agent@$probe.service")" = active
  check "controller can restart switch-agent@$probe" as_controller "${sc[@]}" restart "switch-agent@$probe.service"
  check "controller can stop switch-agent@$probe" as_controller "${sc[@]}" stop "switch-agent@$probe.service"
  check "  ... and it is stopped" test "$(systemctl is-active "switch-agent@$probe.service")" = inactive
  denied "controller cannot start ssh.service" as_controller "${sc[@]}" start ssh.service
  denied "controller cannot start another unit" as_controller "${sc[@]}" start cc-gate-probe.service
  denied "controller cannot stop the stub Core" as_controller "${sc[@]}" stop cc-gate-core.service
  denied "controller cannot StartUnit switch-agent@../x.service (D-Bus)" as_controller \
    busctl call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager StartUnit ss 'switch-agent@../x.service' replace
  denied "controller cannot StartUnit switch-agent@foo.bar.service (D-Bus)" as_controller \
    busctl call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager StartUnit ss 'switch-agent@foo.bar.service' replace
  denied "controller cannot kill an agent unit" as_controller "${sc[@]}" kill "$(unit "$A1")"
  denied "controller cannot set properties on an agent unit" as_controller "${sc[@]}" set-property --runtime "$(unit "$A1")" MemoryMax=1G
  denied "controller cannot mask an agent unit" as_controller "${sc[@]}" mask --runtime "$(unit "$A1")"
  check "the probe unit never started" test "$(systemctl is-active cc-gate-probe.service)" = inactive
  check "the stub Core is still running" systemctl is-active cc-gate-core.service
  rm -rf "/etc/systemd/system/switch-agent@$probe.service.d"
  systemctl daemon-reload
}

# ── 3 ──────────────────────────────────────────────────────────────────────
assert_3() {
  section 3 "a hostile link in an agent's directory is not followed"
  local root="/data/agents/$A1" watcher="/data/agents/$A1/watcher" since canary
  check "agent root and watcher are setgid and sticky (3770)" \
    test "$(stat -c %a "$root") $(stat -c %a "$watcher")" = "3770 3770"
  denied "agent cannot rename its watcher/ aside" in_a1 mv "$watcher" "$root/watcher.moved"
  denied "agent cannot replace template.json with a link" \
    in_a1 sh -c "ln -s /run/switch-machine/controller.json $watcher/.planted && mv -fT $watcher/.planted $watcher/template.json"
  rm -f "$watcher/.planted"
  denied "agent cannot delete config.json" in_a1 rm -f "$watcher/config.json"

  # A link planted where the controller writes (as if the sticky bit were
  # not there) is replaced, not written through.
  canary=/data/.switch-controller/cc-gate-canary
  echo untouched >"$canary"; chown switch-controller: "$canary"
  rm -f "$watcher/template.json"; ln -s "$canary" "$watcher/template.json"
  local assignment; assignment=$(stub_get /state | jq -c '.assignment | .revision += 1 | .agents[0].revision += 1')
  stub_post /assignment "{\"assignment\": $assignment}" >/dev/null
  check "controller relaunches agent 1 for the new revision" until_true 60 test -f "$watcher/template.json" -a ! -L "$watcher/template.json"
  check "  ... replacing the planted template.json link, not writing through it" test "$(cat "$canary")" = untouched
  rm -f "$canary"
  check "agent 1 is connected again" until_true 90 connected "$A1"

  # A link the agent plants in a file it owns, aimed at a controller secret.
  since=$(date +%s)
  in_a1 sh -c "rm -f $watcher/health.json; ln -s /run/switch-machine/controller.json $watcher/health.json"
  wait_reports 2
  check "controller refuses the agent's health.json link" \
    sh -c "journalctl -u switch-controller --since @$since -o cat | grep -q 'health.json is a symbolic link; it is not followed'"
  denied "no status report carries the controller's config" sh -c "curl -fsS $STUB_ADMIN/state | grep -q -e grantTokens -e controller-credential"
  check "controller is still running" systemctl is-active switch-controller.service
  rm -f "$watcher/health.json"

  # watcher/supervisor/ is the agent's directory too. Link it at one outside
  # the agent's root and stop the agent: the controller must refuse the link
  # rather than report the outside failure.json as the agent's.
  install -d -o switch-controller -g switch-controller -m 0700 /data/.switch-controller/cc-gate-outside
  echo '{"message": "CC-GATE-OUTSIDE-FAILURE"}' >/data/.switch-controller/cc-gate-outside/failure.json
  chown switch-controller: /data/.switch-controller/cc-gate-outside/failure.json
  in_a1 sh -c "rm -rf $watcher/supervisor && ln -s /data/.switch-controller/cc-gate-outside $watcher/supervisor"
  since=$(date +%s)
  systemctl stop "$(unit "$A1")"
  check "systemctl stop leaves agent 1 inactive, not failed" test "$(systemctl is-active "$(unit "$A1")")" = inactive
  denied "  ... with no process of it left" pgrep -f "/data/agents/$A1/watcher"
  wait_reports 3
  denied "controller does not follow a linked watcher/supervisor/ directory" sh -c "curl -fsS $STUB_ADMIN/state | grep -q CC-GATE-OUTSIDE-FAILURE"
  check "  ... and says why" \
    sh -c "journalctl -u switch-controller --since @$since -o cat | grep -q 'supervisor is a symbolic link; it is not followed'"
  rm -f "$watcher/supervisor"
  rm -rf /data/.switch-controller/cc-gate-outside
  systemctl start "$(unit "$A1")"
  check "agent 1 is connected again" until_true 120 connected "$A1"
}

# ── 4 ──────────────────────────────────────────────────────────────────────
assert_4() {
  section 4 "a sealed login reaches the agent, and only this machine's"
  local revision since a1 a2 env
  revision=$(stub_get /state | jq '.envelopes.claude')
  check "agent 1's unit loads the provider login (revision $revision)" test "$(provider_revision "$A1")" = "$revision"
  check "agent 2's unit loads the provider login (revision $revision)" test "$(provider_revision "$A2")" = "$revision"
  env=$(tr '\0' '\n' <"/proc/$(agent_host_pid "$A1")/environ")
  check "agent 1's host has the login in its environment" grep -qx "ANTHROPIC_API_KEY=gate-placeholder-key-rev$revision" <<<"$env"

  since=$(date +%s)
  stub_post /seal "{\"provider\": \"claude\", \"revision\": $((revision + 1)), \"credential\": \"gate-placeholder-wrong-context\",
    \"controller_id\": \"00000000-0000-4000-8000-0000000000c2\", \"notify\": true}" >/dev/null
  check "a login sealed for another controller is refused" until_true 30 \
    sh -c "journalctl -u switch-controller --since @$since -o cat | grep -q 'sealed for another context'"
  check "  ... and the agents keep revision $revision" test "$(provider_revision "$A1")" = "$revision"

  since=$(date +%s)
  stub_post /seal "{\"provider\": \"claude\", \"revision\": $((revision + 2)), \"credential\": \"gate-placeholder-relabelled\",
    \"controller_id\": \"00000000-0000-4000-8000-0000000000c2\", \"relabel_controller_id\": \"$CONTROLLER_ID\", \"notify\": true}" >/dev/null
  check "a login sealed for another controller but labelled as this one's does not open" until_true 30 \
    sh -c "journalctl -u switch-controller --since @$since -o cat | grep 'login failed' | grep -vq 'another context'"
  check "  ... and the agents keep revision $revision" test "$(provider_revision "$A2")" = "$revision"
  journal_since switch-controller "$since" >>"$LOG"

  local next=$((revision + 3))
  check "agent 1 is busy (a held turn)" hold_busy "$A1"
  a1=$(invocation "$A1"); a2=$(invocation "$A2")
  since=$(date +%s)
  stub_post /seal "{\"provider\": \"claude\", \"revision\": $next, \"credential\": \"gate-placeholder-key-rev$next\", \"notify\": true}" >/dev/null
  check "idle agent 2 restarts for the new login" until_eval 100 '[ "$(invocation "$A2")" != "$a2" ]'
  check "  ... and loads revision $next" until_eval 30 '[ "$(provider_revision "$A2")" = "$next" ]'
  check "busy agent 1 has not restarted" test "$(invocation "$A1")" = "$a1"
  check "  ... and is still busy" test "$(health "$A1" .busy)" = true
  hold_release "$A1"
  check "agent 1 goes idle once its turn ends" until_eval 30 '[ "$(health "$A1" .busy)" = false ]'
  check "idle agent 1 then restarts for the new login" until_eval 100 '[ "$(invocation "$A1")" != "$a1" ]'
  check "  ... and loads revision $next" until_eval 30 '[ "$(provider_revision "$A1")" = "$next" ]'
  check "both agents are connected again" until_true 90 both_connected
}

# ── 6 ──────────────────────────────────────────────────────────────────────
assert_6() {
  section 6 "relay parity: a control message reaches the agent's control server and back"
  local agent reply
  for agent in "$A1" "$A2"; do
    reply=$(stub_post /control "{\"agent_id\": \"$agent\", \"message\": {\"health\": true}, \"timeout_s\": 20}")
    echo "$reply" >>"$LOG"
    check "health reply from agent ${agent: -2}" test "$(jq -r '.reply.ok' <<<"$reply")" = true
    check "  ... matches its health.json" test "$(jq -r .reply.result.state <<<"$reply")" = "$(health "$agent" .state)"
    reply=$(stub_post /control "{\"agent_id\": \"$agent\", \"message\": {\"list\": true}, \"timeout_s\": 20}")
    check "session list from agent ${agent: -2} is its own" \
      test "$(jq -r '.reply.result.page.data' <<<"$reply" | base64 -d | jq -r --arg a "$agent" 'all(.[]; .agentId == $a)')" = true
  done
  reply=$(stub_post /control "{\"agent_id\": \"$A1\", \"message\": {\"bogus\": 1}, \"timeout_s\": 20}")
  check "an unreadable message comes back refused" test "$(jq -r .reply.error.code <<<"$reply")" = refused_message
}

# ── 7 ──────────────────────────────────────────────────────────────────────
assert_7() {
  section 7 "an agent OOM does not take the controller down"
  local cpid since restarts
  cpid=$(controller_pid)
  restarts=$(systemctl show -p NRestarts --value "$(unit "$A2")")
  since=$(date +%s)
  systemctl set-property --runtime "$(unit "$A2")" MemoryMax=160M MemorySwapMax=0
  check "the kernel enforces agent 2's memory limit" \
    sh -c "cat \"\$(find /sys/fs/cgroup -path '*$(systemctl show -p ControlGroup --value "$(unit "$A2")")/memory.max' | head -1)\" | grep -qx 167772160"
  in_agent "$A2" python3 -c 'chunks = []
while True:
    chunks.append(bytearray(16 * 1024 * 1024))' >/dev/null 2>&1
  check "the kernel OOM-killed in agent 2's unit" until_true 30 \
    sh -c "journalctl -u $(unit "$A2") --since @$since -o cat | grep -q -e 'oom-kill' -e 'OOM killer'"
  check "controller kept its process" test "$(controller_pid)" = "$cpid"
  check "controller is still active" systemctl is-active switch-controller.service
  check "agent 1 is still running" active "$A1"
  systemctl set-property --runtime "$(unit "$A2")" MemoryMax=75% MemorySwapMax=infinity
  check "systemd restarts agent 2" until_eval 60 '[ "$(systemctl show -p NRestarts --value "$(unit "$A2")")" -gt "$restarts" ]'
  check "agent 2 is connected again" until_true 120 connected "$A2"
  check "the controller reports the OOM kill" until_eval 30 '[ "$(latest_report "$A2" | jq ".oom_kills // 0")" -ge 1 ]'
  journal_since "$(unit "$A2")" "$since" | tail -20 >>"$LOG"
}

# ── 5 ──────────────────────────────────────────────────────────────────────
fingerprint() {
  local agent
  for agent in "$A1" "$A2"; do
    echo "branch $agent $(git -c safe.directory='*' --git-dir=/data/repos/acme/widgets.git rev-parse "switch/$agent")"
    sha256sum "/data/agents/$agent/home/notes.txt" "/data/worktrees/$agent/acme/widgets/WORK.md" \
      "/data/worktrees/$agent/acme/widgets/README.md"
  done
}
owner_mode() { stat -c '%U:%G %a' "$1"; }

assert_5() {
  section 5 "per-user-v1 -> controller keeps the data"
  check "the controller boot kept every file and branch" diff /var/lib/cc-gate/fixture-before.txt <(fingerprint)
  check "the controller layout marker is in place" test -e /data/.switch-hosted/controller-v1
  check "agents and worktrees are the controller's" \
    test "$(owner_mode /data/agents) $(owner_mode /data/worktrees)" = "switch-controller:switch-controller 750 switch-controller:switch-controller 750"
}

preflight
if [ "$#" -eq 0 ]; then set -- 1 2 3 4 5 6 7; fi
for n in "$@"; do "assert_$n"; done

printf '\n== summary\n'
printf '%s\n' "${SUMMARY[@]}" | awk '{print $1}' | sort | uniq -c
printf '%s\n' "${SUMMARY[@]}" | grep -E '^(FAIL|KNOWN)' || true
echo "details: $LOG"
[ "$FAILED" -eq 0 ]
