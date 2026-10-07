#!/bin/bash
# usage: in-agent.sh <agent-id> <command...>
# Runs a command as the agent itself would: as switch-agent, inside the agent
# unit's cgroup (so its IPAddressDeny applies), and in the mount and PID
# namespaces of the agent's init (so its TemporaryFileSystem, BindPaths,
# InaccessiblePaths, its own /proc and its PID namespace apply). The unit's
# main process is the root unshare wrapper; the init is its only child.
set -euo pipefail
agent=$1; shift
unit="switch-agent@$agent.service"
pid=$(systemctl show -p MainPID --value "$unit")
[ "$pid" -gt 0 ] || { echo "$unit is not running" >&2; exit 125; }
init=$(pgrep -P "$pid" | head -1)
[ -n "$init" ] || { echo "$unit has no agent init" >&2; exit 125; }
group=$(systemctl show -p ControlGroup --value "$unit")
procs=$(find /sys/fs/cgroup -path "*$group/cgroup.procs" 2>/dev/null | head -1)
[ -n "$procs" ] || { echo "no cgroup for $unit" >&2; exit 125; }
exec sh -c 'echo $$ >"$1"; shift; pid=$1; shift; exec nsenter -t "$pid" -m -p -- setpriv --reuid=switch-agent --regid=switch-agent --clear-groups --no-new-privs -- "$@"' \
  in-agent "$procs" "$init" "$@"
