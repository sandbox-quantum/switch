#!/bin/bash
# Lays a volume out the way the worker runtime left it (the per-user-v1
# layout): a v2 machine marker from an earlier instance, each agent's root and
# worktrees owned by switch-agent and private to it, a bare mirror under
# /data/repos, and one worktree per agent on a branch of its own with a commit
# on it. Then records what must survive the move to the controller layout
# and back.
set -euo pipefail

: "${A1:?}" "${A2:?}" "${INSTALLATION_ID:?}" "${SLOT_ID:?}" "${GENERATION:?}"
loop=$(cat /etc/cc-gate/loop-device)
fs_uuid=$(blkid -p -o value -s UUID "$loop")
as_agent() { setpriv --reuid switch-agent --regid switch-agent --clear-groups env HOME=/tmp/cc-gate-agent-home "$@"; }
gitc() { as_agent git -c user.name="Gate Agent" -c user.email=gate-agent@example.invalid -c init.defaultBranch=main "$@"; }

install -d -o root -g root -m 0700 /data/.switch-hosted
python3 - "$fs_uuid" <<PY
import json, os, sys, uuid
value = {
    "version": 2,
    "installationId": "$INSTALLATION_ID",
    "slotId": "$SLOT_ID",
    "generation": $GENERATION,
    "instanceId": "i-0aaaaaaaaaaaaaaa0",
    "bootId": str(uuid.uuid4()),
    "filesystemUuid": sys.argv[1],
    "runtimeFingerprint": "sha256:" + "0" * 64,
    "layout": "per-user-v1",
}
path = "/data/.switch-hosted/machine.json"
with open(path, "w") as handle:
    json.dump(value, handle)
os.chmod(path, 0o600)
PY

install -d -o root -g root -m 0755 /data/agents /data/worktrees
install -d -o switch-agent -g switch-agent -m 0700 /data/repos /data/repos/acme /tmp/cc-gate-agent-home

seed=/tmp/cc-gate-agent-home/seed
gitc init -q "$seed"
as_agent sh -c "echo 'widgets: the gate fixture repository' > $seed/README.md"
gitc -C "$seed" add README.md
gitc -C "$seed" commit -q -m "Initial commit"
gitc clone -q --bare "$seed" /data/repos/acme/widgets.git

for agent in "$A1" "$A2"; do
  install -d -o switch-agent -g switch-agent -m 0700 \
    "/data/agents/$agent" "/data/agents/$agent/home" "/data/agents/$agent/tmp" \
    "/data/agents/$agent/watcher" "/data/worktrees/$agent" "/data/worktrees/$agent/acme"
  as_agent sh -c "echo 'notes kept by $agent before the move' > /data/agents/$agent/home/notes.txt"
  gitc -C /data/repos/acme/widgets.git worktree add -q -b "switch/$agent" "/data/worktrees/$agent/acme/widgets" main
  as_agent sh -c "echo 'work in progress by $agent' > /data/worktrees/$agent/acme/widgets/WORK.md"
  gitc -C "/data/worktrees/$agent/acme/widgets" add WORK.md
  gitc -C "/data/worktrees/$agent/acme/widgets" commit -q -m "Work by $agent"
done
rm -rf /tmp/cc-gate-agent-home

fingerprint() {
  for agent in "$A1" "$A2"; do
    echo "branch $agent $(git --git-dir=/data/repos/acme/widgets.git rev-parse "switch/$agent")"
    sha256sum "/data/agents/$agent/home/notes.txt" "/data/worktrees/$agent/acme/widgets/WORK.md" \
      "/data/worktrees/$agent/acme/widgets/README.md"
  done
}
fingerprint >/var/lib/cc-gate/fixture-before.txt
echo "per-user-v1 fixture written (filesystem $fs_uuid)"
