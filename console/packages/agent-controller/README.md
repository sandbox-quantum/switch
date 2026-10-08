# Switch agents controller (headless)

`switch-agent-controller` runs the Switch agents that Management assigns to this
machine and reports their status. Run one per machine. It is the headless half of
"agent management and agent controllers v1". The design is in
`docs/design/agent-controllers-v1.md`, and the wire contract in
`docs/design/controller-contract-v1.md`.

Each assigned agent runs as an agent host inside the controller's process, the
same agent host code (`runAgentHost` from `@switch-console/agent-providers`) Switch
Console runs for its own agents. Its sessions are the controller's child
processes, started from the shared-host bundle
(`@switch-console/agent-providers/shared-host-daemon`). The controller decides what
runs, and the agent hosts do the running.

An agent whose definition asks for `isolation: "isolated"` runs instead as an agent
host in a process of its own (the shared-host bundle with `--ensure-watch`, as Console
runs an agent on an SSH host). It hears its events on the controller's **hub**, the
same one in-process agent hosts use, over a WebSocket on the relay's port, and it is
not stopped when the controller exits: it reconnects when the controller is back.
Changing an agent's isolation restarts it the other way.

On Linux, a controller set up for it runs every agent, whatever its isolation, as
a Linux user of its own under systemd, seeing only its own directory: see
[Each agent as a Linux user of its own](#each-agent-as-a-linux-user-of-its-own).

The controller holds **one** connection to Switch, a WebSocket, for all of its agents and hands
each shared agent's events to its agent host directly. Each agent host makes its calls to Switch
through a **local relay** on a loopback port, which adds the controller's
credentials. No agent holds a Switch credential: each is given a token that only the
relay accepts.

## Requirements

- macOS or Linux. The shared host needs POSIX process control.
- Node 22.13 or later. The store uses the built-in `node:sqlite`.
- Each provider CLI the agents use, installed on `PATH` and signed in as the user
  the controller runs as (`claude`, `codex`, `opencode`, `agent`/`cursor-agent`,
  `antigravity-acp`), or its API key in the `--env-file` the controller runs with.
- A Switch server with `AGENT_MANAGEMENT_ENABLED=true`. Behind a proxy or ingress,
  `/v1` must reach switch-core (the Helm chart routes it).

## Install

Each `switch-agent-controller-v*` release on GitHub carries one npm package, the CLI
and the shared-host bundle it runs agents with, with no dependencies. The gateway's
Machines page shows the one command that installs it, enrolls the machine and starts
it as a service:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code>
```

Without `--server` and `--code`, `install.sh` only installs. `--data-dir <dir>`
keeps the controller's state in that folder rather than the default one.

It installs with `npm install --global`, into npm's global prefix. When the user
cannot write there (Node from the system's packages installs into `/usr`), it
installs into `~/.local` instead, without changing npm's settings, and says so
if `~/.local/bin` is not on the PATH; the service runs the controller by its
full path either way. `switch-agent-controller update` installs into the same
prefix the running controller came from. The package can also be installed
directly: `npm install --global <the release's .tgz URL>`.

From a checkout, build the workspace packages
(`pnpm install && pnpm -r --filter './packages/**' run build` from `console/`) and
run `node packages/agent-controller/dist/cli.mjs`; `pnpm --filter
@switch-console/agent-controller run package` builds the release package into
`dist-package/`.

## Enroll and run

Create a one-time enrollment code in Switch. It is valid for 10 minutes. Then:

```bash
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <code> \
  [--name build-box] [--description "The build box in the office"] [--data-dir <dir>] \
  [--secret-store keychain|secret-service|file]

switch-agent-controller install-service [--data-dir <dir>] [--env-file <path>]
switch-agent-controller run [--data-dir <dir>] [--env-file <path>]
switch-agent-controller status [--data-dir <dir>]
switch-agent-controller set-info [--name <name>] [--description <text>] [--data-dir <dir>]
switch-agent-controller doctor [--data-dir <dir>]
switch-agent-controller update [--check]
```

- `--server` is the agent bridge URL, and it must be `https`. Plain `http` is
  accepted only for a loopback server. Agents never see it: they reach Switch
  through the controller's relay.
- `--name` defaults to the host name.
- `--description` says what the machine is for (optional, at most 500
  characters). Its owner sees it in the gateway's Machines page, where both the
  name and the description can be changed later, and so do the agents allowed
  to manage agents for that owner.
- `set-info` changes the machine's name and/or description on the server after
  enrollment, with this controller's own credential, and records the new name
  in the data directory. Give `--name`, `--description` or both; `--description ""`
  clears the description. The limits are enrollment's (a name of at most 200
  characters, not blank). It needs the credential in the data directory, so a
  controller whose credential is handed over with `--credential-stdin` is
  renamed in the gateway instead. It can run while `run` does.
- `status` reads only local state. It makes no network call.
- Logging goes to stderr. Set the level with `SWITCH_CONTROLLER_LOG_LEVEL`
  (`debug`, `info`, `warn`, `error`; the default is `info`).
- Exit codes:

  | Code | Meaning | Restart? |
  |---|---|---|
  | `0` | Stopped by SIGINT/SIGTERM, or the command finished. | No |
  | `1` | An error that may pass: the network, the server, or a crash. | Yes, with backoff |
  | `2` | A configuration error that starting again unchanged cannot fix. | No, not until the configuration changes |
  | `3` | The server revoked this controller. | No: it must be enrolled again |
  | `4` | Another instance of this controller, with the same identity, opened the controller stream after this one, which took it over. | No |
  | `5` | The server does not speak this controller's protocol (`protocol_unsupported`). | No: update the controller |
  | `6` | The server knows no controller by this credential (`invalid_credential`): it was replaced, or its key was deleted. | No: enroll again |

  Code `2` covers: an unknown command, option or missing argument; a server
  URL that is not one, or is plain `http` to a host that is not loopback; a
  data directory that belongs to another controller identity, or whose store
  a newer controller wrote; a shared-host bundle that is missing, not a file
  or unreadable; an unsupported platform (Windows); a data directory that
  holds no identity, or no credential (revoked earlier and wiped, or never
  enrolled); `set-info` with nothing to change, or a name or description past
  the limits; and with `--credential-stdin`, a credential that does not arrive
  (stdin is a terminal, closes empty, holds more than one token, cannot be
  read, or stays open past 10 s). The reason is the last line on stderr,
  prefixed `switch-agent-controller: `. Once the controller is running,
  failures talking to Switch are retried inside the process and do not end
  it.

Stopping the controller stops its agents and their sessions: nothing an agent runs
outlives the controller. The next `run` starts them again from where each agent host
left off: its journal is on disk, and the controller resumes each agent's events
from the cursor it last confirmed. A session that was mid-turn is reported as
interrupted, and the next message resumes its conversation.

An agent host that fails is started again on its own, after 2, 4 and 8 seconds; a fourth
failure within ten minutes is recorded, and the agent stays down until a new
revision or an explicit restart. The other agents are not affected. An agent host left
running as a separate process by an earlier version of the controller is stopped
before this one starts its own.

### As a service

`install-service` runs the controller as a service of the user who runs it: a
systemd user unit on Linux (`~/.config/systemd/user/switch-agent-controller.service`,
log with `journalctl --user -u switch-agent-controller`) or a launchd agent on macOS
(`~/Library/LaunchAgents/com.switch.agent-controller.plist`, logging to
`controller.log` in the data directory). It starts at once and at each login. On
Linux it also starts at boot and survives logout only with lingering on
(`sudo loginctl enable-linger <user>`), which it says when it is off. The service
keeps the `PATH` of the shell that installed it, so the provider CLIs found then are
found by the service. A data directory other than the default gets a service name
with a hash of its path, so two controllers on one account each get their own.
`uninstall-service` stops and removes it and keeps the enrollment.

On Linux without a systemd user manager (some containers and minimal VMs),
`install-service` refuses. Run `run` under your own supervisor instead, with the
restart rules below.

### Environment for the agents

`--env-file <path>` (on `run` and `install-service`) reads `NAME=value` lines,
as systemd's `EnvironmentFile=` does for the common cases (comments, blank lines,
`export `, single or double quotes), into the environment the agents inherit:

```bash
# Claude Code on Vertex AI, signed in with `gcloud auth application-default login`
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

Sessions inherit only the provider variables Switch knows (API keys, base URLs,
model overrides, and the Vertex AI, Bedrock and Google Cloud settings), plus the
basics a CLI needs. The file is read once at start; restart the service after
changing it.

### Each agent as a Linux user of its own

By default every agent runs as the user the controller runs as, so an agent can
read the controller's files, its credential and the other agents' files. On Linux
with systemd and polkit, each agent can instead run as a Linux user of its own,
which sees only its own directory. Set it up once, as root, after enrolling:

```bash
sudo npm install --global <the release's .tgz URL>   # Node and the controller system-wide
switch-agent-controller enroll --server https://switch.example.com --code <code>
sudo switch-agent-controller install-service --separate-users [--env-file /etc/switch/agents.env]
```

`install-service --separate-users` runs as root and sets up, for the user who ran
`sudo` (or `--user <name>`) and the data directory (`--data-dir`, by default that
user's default one):

- a pool of system users, `sa<uid>-01` … (16 by default, `--agent-users <n>` up to
  99), all in a group of their own, `switch-agents-<uid>`;
- a systemd template unit, `switch-agent-<uid>@.service`, that runs an agent as
  one of them;
- a polkit rule that lets the controller's user start, stop, restart and reset
  those units and nothing else, so the controller itself never needs root;
- the agents' directories, in `/var/lib/switch-agents/<uid>` (`--agents-dir`);
- the controller as a system service of that user,
  `switch-agent-controller-<uid>.service`, run with
  `--agent-runtime separate-user` and the agents' group as a supplementary group,
  so it can read what its agents write. It replaces the user service, which must
  be uninstalled first.

The setup is written to `/etc/switch-agent-controller/separate-users-<uid>.json`.
Running the setup again rewrites everything and adds agent users. `sudo
switch-agent-controller uninstall-service --separate-users` stops the controller
and its agents, then removes what the setup made except the agents' directories.

Each agent claims a free user from the pool when it is first started, and runs as
`switch-agent-<uid>@<NN>.service`. systemd restarts an agent host that crashes. The
agent:

- sees only its own directory, always at `/var/lib/switch-agents/<uid>/agent`,
  whichever user it runs as, with its `home` and its `workspace` in it. A
  definition with no directory works in that `workspace`. A definition naming a
  directory outside it is refused (`definition_invalid`);
- cannot see the home directories, the controller's data directory, the other
  agents' processes, or the cloud instance metadata address, and the rest of the
  system is read-only to it;
- gets its relay credentials and the provider settings from the controller's
  environment (the `--env-file`) through systemd, never the controller user's own
  provider logins in its home. Give each provider an API key or a token, for
  example `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. `doctor` checks the
  providers the way an agent would see them.

Node, the controller and the provider CLIs must be installed outside the home
directories (`/usr`, `/usr/local` or `/opt`), where the agents can reach them; the
setup and the controller refuse what is not. An agent removed from the machine
frees its user, and its directory is moved to `released/<agent id>` under the
agents' directory, where it is picked up again if the agent comes back. Before an
agent starts, root hands it back the files in its directory that another agent
user owns, so an agent can move from one user to another. Only files in the
agents' group are handed back.

When every user in the pool runs an agent, the next agent fails with
`capacity_exceeded` until the setup is run again with a larger `--agent-users`.
Agents' units keep running when the controller stops, as isolated agents do.
`status` run in a shell without the agents' group shows each agent's unit state
only.

### The controller credential

`enroll --secret-store` says where the controller credential is kept, and the data
directory remembers it:

- `keychain`, the default on macOS: the login keychain, through `security`. The
  launchd agent runs in the user's session and can read it.
- `secret-service`: the desktop keyring on Linux (GNOME Keyring, KWallet), through
  `secret-tool`. Choose it only where the keyring is unlocked whenever the controller
  starts, which a service started at boot usually is not.
- `file`, the default on Linux: a file only the user can read, in the data directory.

### Updates

`update` installs the newest release with npm and restarts the service if it runs;
`update --check` only says whether there is one. `run` logs a warning when a newer
release exists, and `doctor` shows it.

### Checking a machine

`doctor` checks what a machine needs to run agents and says what to do where it
falls short: Node, the platform, enrollment, the credential, the server (exchanging
the credential, so a proxy that does not send `/v1` to switch-core shows up),
the shared-host bundle, each provider CLI on `PATH` and its sign-in, the service,
and updates. It exits 1 when a check fails.

### Running under your own supervisor

To run it under another supervisor, have it run `run` and restart it on exit code
`1` only. Do not restart it on `2`, because it would fail the same way until its
configuration is fixed, nor on `3`, because a revoked controller must be enrolled
again, nor on `4`, because two instances would take the stream from each other in
turn, nor on `5` or `6`, because the server has said it will refuse this controller
the same way again. With systemd, `Restart=on-failure` and
`RestartPreventExitStatus=2 3 4 5 6`.

## Run by a parent process

Switch Console runs this controller as a child process for "Run managed agents on
this computer". It enrolls through its own signed-in session and keeps the
credential in its encrypted secrets store, so the controller is handed what
`enroll` would have written, without anything reaching the disk:

```bash
switch-agent-controller run \
  --data-dir <dir> \
  --controller-id <id> --server <agent-bridge-url> [--name <name>] \
  --credential-stdin \
  [--shared-host-bundle <path>]
```

- `--controller-id` and `--server` adopt an identity enrolled elsewhere. A data
  directory that holds no identity is seeded with it; one that holds the same
  identity is used as it is; one that holds another controller's is refused
  (exit code `2`), as `enroll` refuses it. `--name` (default: the host name) is
  recorded only when the identity is seeded.
- **A new server URL for the same controller.** When the data directory holds
  this controller (the same `--controller-id`) at another server URL, the
  stored server is replaced with the new `--server` and the controller runs
  against it, with a warning in the log naming both. The cached assignment and
  agent cursors are kept: they belong to the controller, not to the address it
  was reached at. This is how a parent follows its Switch server to a new
  address: it stops the controller and starts it again with the new
  `--server`. Only the server moves this way; a different controller id is
  still refused.
- `--credential-stdin` reads the controller credential from stdin, to the end of
  the pipe, and keeps it in memory only (the memory secret store). The parent
  writes it and closes the pipe; the controller gives up after 10 s, and refuses a
  terminal. Nothing is written to `secrets/`, and nothing goes into the
  environment, so the agent hosts and sessions the controller starts never inherit
  it. On revocation the controller forgets it, records the revocation in
  `controller.db` and exits with code `3`; the parent deletes its own copy.
- `--shared-host-bundle` (or `SWITCH_CONTROLLER_SHARED_HOST_BUNDLE`) names the
  agent-providers shared-host bundle. Without it the controller resolves the one
  built in the workspace, which a bundled controller does not have. `status`
  takes the same flag.

Under Console the controller runs on Electron's own binary with
`ELECTRON_RUN_AS_NODE=1`, as Console runs its local hosts. That variable stays in
the environment the controller passes to the shared host, so the agent hosts and
session hosts it launches with `process.execPath` run as Node too.

## How it works

- Exchanges its long-lived credential for a one-hour access token. It refreshes the
  token at 80% of its lifetime, and exchanges once more if a request is refused
  with a 401.

### The controller stream

- Opens a connection (`POST /v1/controllers/{id}/connection`) with each agent's
  cursor (the last sequence its agent host confirmed, or `"head"`), then attaches a
  WebSocket to it (`/v1/controllers/{id}/connection/ws`). It carries every bound agent's
  events (`agent.event`, `agent.gap`, `agent.session_command`,
  `agent.approval_outcome`), its attachment and room membership (`agent.attached`,
  `agent.detached`, `agent.rooms`), and the management nudges (`assignment.changed`,
  `operation.pending`, `credential.revoked`).
- Answers every `ping` Switch sends on the socket (each `heartbeat_interval_s`, 2 s)
  with a `pong` naming each agent's confirmed cursor: that pong is its heartbeat.
- The open and every beat also carry `placements`: for each agent whose running
  agent host has a session placed in a room, those rooms. It is the
  whole current map each time (Switch replaces what it held), and agents with no
  placement are left out, so a placement the agent host makes reaches Switch on the
  next beat.
- A dropped socket is reattached to the same connection. A connection Switch no
  longer knows (`unknown_connection`, `stale_generation`, or any `evicted` but
  `taken_over`) is opened afresh, from the cursors as they stand. Reconnects back
  off with jitter, except after close code 1012 (Switch restarting), which is
  retried within a second. A socket silent for 10 s (Switch pings every 2 s)
  counts as dropped.
- `taken_over`, as a frame or a refusal, means another instance of this controller
  opened the stream. This one stops its agents and exits with code `4`.
- Each agent's events are handed to its agent host one at a time, in order, and only
  the events that address the agent (the `addressed` filter Switch applies to a
  agent host). Events that arrive while its agent host is not running are held, up to
  5,000; past that the oldest are dropped and the agent host is told of the gap when
  it starts.
- An agent's cursor moves only once its agent host has taken an event. It is kept in
  `controller.db`, so a restarted controller resumes each agent where its agent host
  stopped.
- Placements say which room each session works in. An in-room command
  (`!reset`, `!compact`, `!interrupt`) arrives for a room and is handed to the
  session placed there.

### The local relay

- Listens on `127.0.0.1` only, on a port chosen once and reused while it is free.
  Each agent's `agents/<id>/credentials.json` names it as `SWITCH_API_ENDPOINT`,
  with a token minted for that agent (`swlr_…`) as `SWITCH_API_TOKEN`. A token the
  relay did not mint is refused with `401`; while the controller is still starting,
  with `503`.
- It serves no event stream and no connection bookkeeping of the agent protocol
  (`GET /agents/{id}/events`, `POST /agents/{id}/connection/…` answer `410`): the
  controller holds each agent's connection to Switch itself.
- **The hub**, at `ws://127.0.0.1:<port>/hub` with the agent's relay token, named in
  the credentials file as `SWITCH_AGENT_HUB`. An agent host in a process of its own
  hears its events there: the hub sends each event, gap, room control and approval
  outcome as a request, and counts it handled when the agent host answers `done`, as
  it does for an agent host in the controller's process. The agent host states its
  sessions' rooms there too (`placements`). One agent host per agent: a newer one
  takes the hub over (close `4409`, the older stands down). When the controller
  stops, the hub closes with `1012` and the agent hosts reconnect when it is back,
  resuming after the last event they handled.
- **Forwarded to Switch**, everything else under `/agents/{id}/…`,
  `/agent-sessions/…`, `/sessions/…`, `/version` and `/health`: operations, media,
  typing, history, session activity and approvals. The relay sends them with the
  controller's access token, `X-Switch-Agent-Id`, and `X-Switch-Room-Id`: the room
  the calling session is placed in (from `X-Switch-Session-Id`), or else the
  agent's only placed room. The agent host's connection id is not passed on.
  Bodies are streamed both ways; a request body up to 1 MiB is read first so it can
  be sent once more if Switch refuses an access token that went stale early.
  Switch's answer, refusals included, is passed back as it came.
- Nothing else is relayed. In particular the controller's own management and stream
  routes are never reachable with an agent's token, and an agent's token reaches
  only that agent's routes.

### Reconciling and reporting

- On every connect and every `assignment.changed`, it pulls the assignment with
  `If-None-Match` and reconciles. It also resyncs fully every 10 minutes.
- Reconciles each agent:
  - **Desired `running`, not yet applied:** writes the agent's relay credentials to
    `<data>/agents/<id>/credentials.json` (0600), prepares the working directory,
    writes the agent host root `<data>/agent hosts/<id>/` (`watch.json`, `config.json`),
    and starts the agent host in the controller's process.
  - **Desired `running`, at a newer revision:** the same, as a restart. The
    agent host is turned off and waited out, then launched again with the new
    template.
  - **Desired `running`, agent host gone with no recorded failure** (after a
    reboot, say): the agent host is launched again, once 15 s have passed since it
    was last launched, so an agent host still coming up is not launched twice.
  - **Desired `running`, relay credentials rewritten** (the relay came back on
    another port, or they were written before the hub): a running agent host is
    restarted so it reads them.
  - **Agent host failed or was taken over:** it is left down, and reported as
    `failed`. A new revision or an `agent.restart` brings it back. One that failed
    because the relay refused its token is relaunched once it has a new one.
  - **Desired `stopped`:** `watch.json` is set to `{enabled: false}`, and the
    agent host and its sessions are stopped.
  - **Removed from the assignment:** it is stopped, the relay stops accepting its
    token, and its credentials file and cursor are deleted.
  - **Revision older than the one already applied:** the controller refuses it
    (fencing).
- Status (`PUT .../status`) is sent on every observed change and at least every
  `report_within_s`, and never more than once a second. It carries:
  - **Machine:** platform, disk, memory, sessions.
  - **Providers:** installed (a `PATH` lookup and `--version`), and login (the
    bundle's `--probe`, cached for 10 minutes).
  - **Agents:** each one read from its running agent host's state and
    `supervisor/failure.json`. `attached` means the agent's events are flowing on
    the controller stream (Switch attached it, and the stream is up) and its
    agent host is taking them.
- Operations:
  - `agent.restart` and `provider.recheck` run.
  - Every other kind is answered `failed` with `operation_unsupported`.
- On `credential.revoked`, or on any request refused as `controller_revoked`: it
  turns every agent off, stops accepting their tokens, deletes their credentials
  files and the controller credential, and exits with code `3`.

## What it does not do

- No connector tokens and no sealed provider logins.
- An in-room command for a room with no session placed here, or arriving while the
  agent host is not connected, is dropped with a warning in the log. Switch keeps no
  copy to send again.
- Only enrollment by one-time code, or adoption of an identity a parent process
  enrolled (see "Run by a parent process"). There is no EC2 machine secret.
- No session limit is enforced. `sessions_max` is reported as `0`.
- OOM kills are not detected. `oom_kills` is always `0`.
- `restarts_10m` counts the relaunches reconciling made, not the restarts after a
  agent host failure.
- Windows is not supported.

## Where data lives

The data directory is the first of these that is set:

1. `--data-dir`
2. `SWITCH_CONTROLLER_DATA_DIR`
3. the OS default:
   - macOS: `~/Library/Application Support/Switch/agent-controller`
   - Linux: `$XDG_STATE_HOME/switch/agent-controller`, or
     `~/.local/state/switch/agent-controller`

The directory is created with mode 0700, and tightened to 0700 if it already exists.
It holds:

| Path | What |
|---|---|
| `controller.db` | SQLite: identity, cached assignment, per-agent applied revision and local failures, restart times, each agent's stream cursor, the relay's port, status seq. Everything except the identity can be rebuilt from the server. |
| `secrets/controller-credential` | The controller credential, with the `file` secret store (see below). Absent with a keychain store, or when the credential is handed over with `--credential-stdin`. |
| `agents/<id>/credentials.json` | Each agent's relay endpoint, relay token and hub, in the layout the shared host reads. No Switch credential. |
| `agent hosts/<id>/` | Each agent's agent host state root: `watch.json`, `config.json`, `health.json` (what `status` reads), its journal, and `supervisor/failure.json` once it has failed for good. |

An agent whose definition names no directory works in
`~/.switch/agents/<server>/<name>/`, where `<server>` is the server's address
(`localhost-8000`, `switch.example.com`). The server fills this path in once the
controller reports `machine.workspaces_dir`. A missing directory under that folder
is made; any other must already exist.

Sessions an agent host starts keep their state where the shared host puts it
(`~/.local/state/switch/sdk-sessions/`), as they do under Console.

## The file secret store

With the `file` secret store (the default on Linux), the controller credential is a
plaintext file. The file has mode 0600 and sits in a 0700 directory, and the
controller logs a warning saying so every time it starts. Anyone who can read this user's files, or
a backup of them, can act as this controller until it is revoked. If the file is
ever readable by other users, the controller refuses to use it. In that case, revoke
the controller in Switch and enroll it again.

The agents' relay tokens are plaintext files too, because the shared host reads
them that way. They are worth much less: the relay accepts them only on the
loopback interface, only while this controller runs, and only for that agent's own
routes. They hold no Switch credential, and a restart of the controller that has to
change port replaces them.
