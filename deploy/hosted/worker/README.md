# Hosted EC2 machine supervisor

This directory holds the trusted supervisor for hosted agents. One EC2 VM
serves one user. The VM runs all agents of that user. The supervisor runs as
root and does the machine's work: storage, the ownership marker and
quarantine, the agents' memory slice, the machine heartbeat and retirement.

What runs on the machine is decided by the machine's **agents controller**
(`console/packages/agent-controller`), which the supervisor enrolls at boot and
runs as the unprivileged `switch-agent` account in its own unit,
`switch-agent-controller.service`. Switch places every cloud agent of the
machine on that controller as a managed agent. Each agent still runs as
`switch-agent` in its own systemd unit, `switch-agent@<agent-id>.service`,
with its memory limit, OOM handling and crash-loop limit: the controller asks
the supervisor to install, start, stop and remove these units over a local
socket.

The AMI is built ahead of time. It pins Node.js 24, the provider CLIs, the
built `@switch-console/agent-providers` bootstrap artifacts and the agents
controller. The instance profile can call only
`secretsmanager:GetSecretValue` on the assignment secret (and the KMS decrypt
operation for that secret). The supervisor makes no EC2, IAM, KMS, S3 or
secret-list calls.

## Install

Build the console workspace packages, then the Node entrypoints:

    (cd console && pnpm install && pnpm -r --filter './packages/**' run build)
    node deploy/hosted/build-runtime.mjs /path/to/runtime-build

The build writes three self-contained files and their SHA256 manifest:
`hosted-bootstrap.mjs`, `shared-host-daemon.mjs` and `agent-controller.mjs`.

Run the installer while you bake the AMI:

    install.sh /path/to/runtime-build <node-sha256> <provider-sha256>

The installer:

- Verifies the runtime manifest (all three files) and the SHA256 pins of
  Node.js and the provider.
- Makes sure that the host commands the supervisor calls are present at their
  absolute paths, including `flock`, `systemctl` and `systemd-mount`.
- Creates the `switch-agent` account.
- Installs the supervisor, `switch-hosted-worker.service`,
  `switch-agent-controller.service`, `switch-agent@.service` and
  `switch-agents.slice`, and the controller as
  `/opt/switch/agent-controller/agent-controller.mjs`.
- Writes the root-only `/etc/switch-hosted/runtime.json` with all artifact
  digests.
- Enables the supervisor unit.

The checked-in `runtime.json` shows the schema. Its zero digests are examples.
`nodePath` and `bootstrapPath` must agree with `ExecStart` in
`switch-agent@.service`, and `controllerPath` with `ExecStart` in
`switch-agent-controller.service`. The supervisor refuses to start if they do
not, and verifies every pinned file (`agentController` included) against its
digest at each start.

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

## The agents controller

Switch must run with agent management on (`AGENT_MANAGEMENT_ENABLED=true`
and `CONTROLLER_TOKEN_SECRET`); a supervisor whose server has none stops with
an error that says so.

At start, before anything else is run, the supervisor:

1. Enrolls the machine's controller, unless it already did in this boot:
   `POST <apiEndpoint>/v1/management/controllers/enroll` with
   `{"proof": {"kind": "machine_secret", "machine_id", "capability"},
   "controller": {"kind": "ec2", "name": "cloud-machine-<slot>", ...}}` and
   the host instance and boot IDs. Switch checks the capability exactly as on
   the machine routes. A machine keeps one controller across boots: enrolling
   again gives it a new credential and invalidates the old one. A machine
   whose controller was revoked gets a new one. Every cloud agent of the
   machine is placed on it.
2. Keeps the controller id and credential in
   `/run/switch-hosted/machine/controller.json` (root, 0600, tmpfs), so a
   supervisor restarted in the same boot reuses them; a new boot enrolls
   again.
3. Starts `switch-agent-controller.service` as `switch-agent`. The unit reads
   the controller id and server from `/run/switch-hosted/machine/controller.env`
   and the credential on stdin from `/run/switch-hosted/machine/controller-credential`,
   a root-only tmpfs file that systemd opens before the controller starts
   (`Type=exec`) and the supervisor deletes as soon as `systemctl start`
   returns. The credential is never on disk, on a command line or in an
   environment. The controller's data directory is
   `/run/switch-hosted/controller` (agent, 0700, tmpfs).

The supervisor starts the controller again when it stops, after 15 seconds,
doubling to 5 minutes; one that ran for 10 minutes starts again at once. A
controller that exits 3 (revoked) is enrolled again first. A controller that
runs while its credential record is gone is stopped and enrolled again.

## The supervisor socket

The controller reaches the supervisor at `/run/switch-hosted/supervisor.sock`
(root, group `switch-agent`, mode 0660; the peer uid must be root or the
agent account). Each connection carries one JSON request on one line and gets
one JSON answer on one line: `{"ok": true, ...}` or
`{"ok": false, "error": {"code", "message"}}`.

| Request | Does |
| --- | --- |
| `{"op": "install", "agent": <entry>, "restart": bool}` | Builds the agent's deployment from the entry, installs its runtime files, and starts or stops its unit as the entry's `desired_state` says. Answers the unit. |
| `{"op": "stop", "agent_id", "wait": bool}` | Stops the unit and resets a failed one. |
| `{"op": "remove", "agent_id"}` | Removes the agent from the machine (below). |
| `{"op": "prune", "keep": [agent_id, ...]}` | Removes every agent on the machine that is not in `keep`: the controller states its whole assignment after each pass. |
| `{"op": "state", "agent_id"}` | Answers the unit. |

The entry has the shape the agent list had: `launch_id`, `agent_id`, `name`,
`revision` (the launch revision), `desired_state`, `provider`,
`provider_credential_kind`, `worker_capability`, `switch_credentials`,
`repository`, `spec` and `skills`. The supervisor validates every field and
derives every path itself; nothing in a request is a path. Agent IDs must be
lowercase UUIDs. `switch_credentials` must name the controller's loopback
relay (`http://127.0.0.1:<port>`) with a token it minted (`swlr_…`): no
Switch credential is written on the machine.

A unit answer is `{"installed", "revision", "process_state", "restarts",
"oom_kills", "exit"}`, with the process states of the heartbeat below.

Install:

- Files that differ from those installed (a new revision, new relay
  credentials) are replaced, and the unit restarted (`reset-failed`, then
  `restart`) or stopped. A new revision resets the agent's OOM kill count.
- With the same files the unit is only corrected: started when inactive, or
  restarted when `restart` asks for it. A unit that crashed or failed is not
  started again by a correction; a new revision or a restart does.
- An entry that is not valid stops the agent and removes its runtime files;
  its data stays on disk, and it is reported `failed` with `invalid-config`.
  A setup error is reported `failed` with `setup-failed`. An agent whose
  ownership records could not be quarantined is refused with
  `ownership_invalid` and reported `failed` with `ownership-invalid`.
- A retired machine (below) installs nothing.

Remove stops the unit, removes the runtime files, runs
`git worktree remove --force` on the mirror, and removes the agent's state
and worktree directories. It then runs `git worktree prune` on each mirror it
touched; a failed prune is retried on later ticks. It keeps the mirror and
the agent's branch.

The agents the controller installed are kept in
`/run/switch-hosted/machine/held.json` (root, 0600, tmpfs, no secrets), so a
supervisor restarted in the same boot keeps reporting them.

## Heartbeat and retirement

The supervisor reads unit state every 3 seconds and sends
`POST <apiEndpoint>/hosted/machines/<machineId>/heartbeat` when a state
changes, and at the interval that core returns (15 seconds by default). It
carries the machine's disk and memory and, for each agent the controller
installed, its process state, restarts, OOM kills and last exit. Each agent's
`since` is a UTC time with a `Z` offset. Core refuses a time without an
offset. Core uses the heartbeat for the machine's and each launch's state
(ready, disk full, crashed), and to catch up placing the machine's agents on
its controller when it missed a change.

Each request sends `Authorization: Bearer <machineCapability>` and the host
instance and boot IDs. Redirects are not followed.

- HTTP 401 stops the supervisor. systemd starts it again.
- HTTP 410 means that the machine is retired. The supervisor stops the
  controller and all agent units, sends a heartbeat every 60 seconds and
  starts the controller again when core accepts a heartbeat; the controller
  then starts the agents again.
- Other errors are logged and tried again.

The supervisor no longer reads `GET <apiEndpoint>/hosted/machines/<machineId>/agents`.
Core keeps serving it for a machine whose controller has not enrolled; for an
agent placed on a controller it lists the launch without its credential and
marked `"unavailable": "managed_by_controller"`, which an older supervisor
stops and keeps.

## Runtime files

For each agent, the supervisor writes `/run/switch-hosted/agents/<agent-id>/`
(root, group `switch-agent`, mode 0750). It replaces the directory atomically.
Each file has mode 0440:

- `deployment.json`: the deployment document, version 2.
- `env`: the unit's environment file (`PATH`, `HOME`, `TMPDIR` and the host
  identity).
- `switch.json`: the controller relay's endpoint and the agent's relay token.
- `worker-capability`: the capability for the current revision.

The provider and GitHub credentials are not written here. The bootstrap gets
them over the relay, which forwards each request to Switch as the controller
acting for the agent. Code that runs as the agent can read the relay tokens of
the agents on that machine. The boundary is the VM of one user.

## Units

`switch-agent@.service` runs the bootstrap as `switch-agent` in
`switch-agents.slice`, with no capabilities. It restarts on failure, at most 5
times in 10 minutes. Exit code 75 does not restart. Each unit is limited to 75%
of memory. At start, the supervisor sets the slice limit to the total memory
minus 1 GiB. An OOM kill stops the unit. The supervisor counts each OOM kill
once and keeps the count in `agents.json`.

`switch-agent-controller.service` runs the controller as `switch-agent`,
with no capabilities, a read-only file system but for its data directory, and
`Restart=no`: the supervisor restarts it. It is not enabled; only the
supervisor starts it.

`switch-hosted-worker.service` uses `Restart=always` and
`RuntimeDirectoryPreserve=yes`, so agent runtime files, the controller's
record and its data stay in place when the supervisor restarts. The supervisor runs git as the agent through `setpriv`,
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
