# Hosted EC2 machine supervisor

This directory holds the trusted supervisor for hosted agents. One EC2 VM
serves one user. The VM runs all agents of that user. The supervisor runs as
root. Each agent runs as the unprivileged `switch-agent` account in its own
systemd unit, `switch-agent@<agent-id>.service`.

The AMI is built ahead of time. It pins Node.js 24, the provider CLIs and the
built `@switch-console/agent-providers` bootstrap artifacts. The instance
profile can call only `secretsmanager:GetSecretValue` on the assignment secret
(and the KMS decrypt operation for that secret). The supervisor makes no EC2,
IAM, KMS, S3 or secret-list calls.

## Install

Build the Node entrypoints:

    node deploy/hosted/build-runtime.mjs /path/to/runtime-build

Run the installer while you bake the AMI:

    install.sh /path/to/runtime-build <node-sha256> <provider-sha256>

The installer:

- Verifies the runtime manifest and the SHA256 pins of Node.js and the provider.
- Makes sure that the host commands the supervisor calls are present at their
  absolute paths, including `flock`, `systemctl` and `systemd-mount`.
- Creates the `switch-agent` account.
- Installs the supervisor, `switch-hosted-worker.service`,
  `switch-agent@.service` and `switch-agents.slice`.
- Writes the root-only `/etc/switch-hosted/runtime.json` with all artifact
  digests.
- Enables the supervisor unit.

The checked-in `runtime.json` shows the schema. Its zero digests are examples.
`nodePath` and `bootstrapPath` must agree with `ExecStart` in
`switch-agent@.service`. The supervisor refuses to start if they do not.

For more providers, put a `providers.json` beside the bundles. It maps
`codex`, `cursor`, `opencode` and `antigravity` to
`{ "path": "/opt/switch/providers/<provider>", "sha256": "<digest>" }`.
Antigravity uses `/opt/switch/providers/antigravity-acp`. Each entry must be a
root-owned executable, not a symlink, with no group or world write access. On
AppArmor hosts, a Codex install also installs a profile for its bundled `bwrap`.

## Assignment metadata

The controller writes the root-owned, mode 0600
`/etc/switch-hosted/assignment.json`:

```json
{
  "version": 2,
  "installationId": "inst-test",
  "slotId": "slot-a",
  "generation": 2,
  "assignmentSecretId": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:example",
  "dataVolumeId": "vol-0123456789abcdef0",
  "dataDevice": "/dev/sdf"
}
```

`previousInstanceId` and `previousRuntimeFingerprint` can be present. The
supervisor ignores them. Other keys are refused. `assignmentSecretId` must be
the full Secrets Manager ARN. The supervisor gets the region from the ARN and
gives it to boto3.

No credential can be in user-data, in this file, in an environment variable or
in a command argument.

## Machine bundle

The assignment secret holds one JSON document, the machine bundle:

```json
{
  "version": 2,
  "assignment": {
    "installationId": "inst-test",
    "slotId": "slot-a",
    "generation": 2,
    "dataVolumeId": "vol-0123456789abcdef0"
  },
  "machineId": "<machine-uuid>",
  "apiEndpoint": "https://switch.example.test/agent-api",
  "machineCapability": "<machine-capability>"
}
```

- If `version` is not 2, the supervisor writes `obsolete bundle` to stderr and
  exits with code 75. It does this before it changes the host.
- `assignment` must agree with `assignment.json`.
- `apiEndpoint` must be HTTPS, with no user information, query or fragment.
- `machineCapability` is 16 to 4096 printable ASCII characters with no
  whitespace. The supervisor never logs it.

The supervisor writes the machine fields to `/run/switch-hosted/machine/bundle.json`
(root, mode 0600) after it makes sure that `/run/switch-hosted` is tmpfs.

## Data volume

The supervisor finds the data volume by its EBS serial. It uses `dataDevice`
only as a hint. It formats a blank volume as ext4 only if `runtime.json` allows
it and the volume has no filesystem, partition or other signature. It mounts
the volume on `/data` with
`systemd-mount --type=ext4 --options=nodev,nosuid`, so that the mount is also
visible outside the supervisor's mount namespace.

The layout is `per-user-v1`:

| Path | Owner | Contents |
| --- | --- | --- |
| `/data/.switch-hosted/machine.json` | root, 0600 | Machine marker |
| `/data/.switch-hosted/agents.json` | root, 0600 | OOM kill count for each agent |
| `/data/.switch-hosted/quarantine/` | root, 0700 | Stale ownership records |
| `/data/.switch-hosted/ownership-blocked.json` | root, 0600 | Agents whose stale ownership records could not be moved |
| `/data/agents/<agent-id>/` | agent, 0700 | Agent state, `home/` and `tmp/` |
| `/data/repos/<owner>/<repo>.git` | agent, 0700 | Shared repository mirror |
| `/data/worktrees/<agent-id>/` | agent, 0700 | The agent's worktree |

The marker has version 2 and records the installation, slot, generation,
filesystem UUID, instance ID, boot ID and runtime fingerprint
(`sha256:<hex>`). The supervisor refuses the volume if:

- The marker has version 1. The message is `data volume uses the one-agent
  layout; see 'Moving to one machine per user' in deploy/hosted/README.md`.
- The installation, slot, generation or filesystem UUID is different.
- The volume has data but no marker.

The supervisor writes the instance ID, boot ID and runtime fingerprint again at
each start. On a new boot, it moves each agent's stale ownership records to
`quarantine/<agent-id>/<old-boot>--<new-boot>/`. If an agent's records are not
valid, that agent is not started and is reported as `failed` with the result
`ownership-invalid`. Its records stay in place and the other agents start. The
blocked agents are listed in `ownership-blocked.json`, and a supervisor restart
in the same boot tries to move their records again. Journals, provider homes
and worktrees stay in place.

## Agent loop

The supervisor holds a root flock under `/run/lock` for its lifetime. It then
does these steps in a loop:

1. It gets `GET <apiEndpoint>/hosted/machines/<machineId>/agents` at start, when
   `agents_version` in a heartbeat response changes, and when an agent exits
   with code 75. A failed request is tried again after 15 seconds.
2. It reconciles each agent in the list:
   - A new or changed `revision` gets new runtime files, `reset-failed` and a
     restart (or a stop if `desired_state` is `stopped`). The revision counts
     as installed only when the restart or stop succeeds. A new revision
     resets the agent's OOM kill count.
   - The same revision only corrects the running state.
   - Each stop is followed by `reset-failed`, so a stopped unit is not left
     in the `failed` state.
   - An entry with an `unavailable` code (for example `agent_key_missing`) has
     no credentials. Its unit is stopped, its data stays on disk, and it is
     reported as `stopped` with the result `invalid-config`.
   - An agent that is not valid is stopped and reported as `failed` with the
     result `invalid-config`. Its data stays on disk.
   - A setup error is reported as `failed` with the result `setup-failed`.
3. It removes each agent that is on disk but not in the list. It stops the
   unit, removes the runtime files, runs `git worktree remove --force` on the
   mirror, and removes the agent's state and worktree directories. It then
   runs `git worktree prune` on each mirror it touched. It keeps the mirror and
   the agent's branch.

   If any agent in steps 2 or 3 fails to set up, stop or be removed, or a
   prune fails, the list is not marked as applied. The supervisor gets the
   list and reconciles it again after 15 seconds, doubling the wait after each
   failure up to 5 minutes. A failed prune is kept and tried again.
4. It reads unit state every 3 seconds and sends
   `POST <apiEndpoint>/hosted/machines/<machineId>/heartbeat` when a state
   changes, and at the interval that core returns (15 seconds by default).
   Each agent's `since` is a UTC time with a `Z` offset. Core refuses a time
   without an offset.

Each request sends `Authorization: Bearer <machineCapability>` and the host
instance and boot IDs. Redirects are not followed.

- HTTP 401 stops the supervisor. systemd starts it again.
- HTTP 410 means that the machine is retired. The supervisor stops all agent
  units, sends a heartbeat every 60 seconds and gets the list again when core
  accepts a heartbeat.
- Other errors are logged and tried again.

## Runtime files

For each agent, the supervisor writes `/run/switch-hosted/agents/<agent-id>/`
(root, group `switch-agent`, mode 0750). It replaces the directory atomically.
Each file has mode 0440:

- `deployment.json`: the deployment document, version 2.
- `env`: the unit's environment file (`PATH`, `HOME`, `TMPDIR` and the host
  identity).
- `switch.json`: the Switch credentials of the agent.
- `worker-capability`: the capability for the current revision.

The provider and GitHub credentials are not written here. The bootstrap gets
them over authenticated HTTPS. Code that runs as the agent can read the
credentials of the agents on that machine. The boundary is the VM of one user.

## Units

`switch-agent@.service` runs the bootstrap as `switch-agent` in
`switch-agents.slice`, with no capabilities. It restarts on failure, at most 5
times in 10 minutes. Exit code 75 does not restart. Each unit is limited to 75%
of memory. At start, the supervisor sets the slice limit to the total memory
minus 1 GiB. An OOM kill stops the unit. The supervisor counts each OOM kill
once and keeps the count in `agents.json`.

`switch-hosted-worker.service` uses `Restart=always` and
`RuntimeDirectoryPreserve=yes`, so agent runtime files stay in place when the
supervisor restarts. The supervisor runs git as the agent through `setpriv`,
which removes all capabilities, and under `flock --no-fork <mirror>.lock`, so it
does not change a mirror while the bootstrap uses it. Each git command runs in
its own process group. If it runs longer than 5 minutes, the supervisor kills
the whole group and waits until every process in it is gone; while any is left,
it does not delete the agent's directories. A git error is logged with the
operation and the exit status only, because a repository's configuration could
make git print a secret.

## Tests

    python3 -m unittest deploy/hosted/worker/test_switch_hosted_worker.py

Worker-only fixtures are in `testdata/`. The fixtures shared with core are in
`core/tests/switch_core/fixtures/hosted_machines/`.
