# Switch agents controller (headless)

`switch-agent-controller` runs the Switch agents that Management assigns to this
machine and reports their status. Run one per machine. It is the headless half of
"agent management and agent controllers v1". The design is in
`docs/design/agent-controllers-v1.md`, and the wire contract in
`docs/design/controller-contract-v1.md`.

Each assigned agent runs as a room watcher, through the same shared-host bundle
(`@switch-console/agent-providers/shared-host-daemon`) that Switch Console deploys to
SSH hosts. The controller decides what runs, and the watchers do the running.

The controller holds **one** event stream to Switch for all of its agents, and
runs a **local relay** on a loopback port that each agent's watcher and session
hosts use as their Switch endpoint. No agent holds a Switch credential: each is
given a token that only the relay accepts.

## Requirements

- macOS or Linux. The shared host needs POSIX process control.
- Node 22.13 or later. The store uses the built-in `node:sqlite`.
- The workspace packages built, so the shared-host bundle exists:
  `pnpm install && pnpm -r --filter './packages/**' run build` from `console/`.
- Each provider CLI the agents use, installed on `PATH` and signed in as the user
  the controller runs as (`claude`, `codex`, `opencode`, `agent`/`cursor-agent`,
  `antigravity-acp`).
- A Switch server with `AGENT_MANAGEMENT_ENABLED=true`.

## Enroll and run

Create a one-time enrollment code in Switch. It is valid for 10 minutes. Then:

```bash
node packages/agent-controller/dist/cli.mjs enroll \
  --server https://switch.example.com \
  --code <code> \
  [--name build-box] [--data-dir <dir>]

node packages/agent-controller/dist/cli.mjs run [--data-dir <dir>]
node packages/agent-controller/dist/cli.mjs status [--data-dir <dir>]
```

- `--server` is the agent bridge URL, and it must be `https`. Plain `http` is
  accepted only for a loopback server. Agents never see it: they reach Switch
  through the controller's relay.
- `--name` defaults to the host name.
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

  Code `2` covers: an unknown command, option or missing argument; a server
  URL that is not one, or is plain `http` to a host that is not loopback; a
  data directory that belongs to another controller identity, or whose store
  a newer controller wrote; a shared-host bundle that is missing, not a file
  or unreadable; an unsupported platform (Windows); a data directory that
  holds no identity, or no credential (revoked earlier and wiped, or never
  enrolled); and with `--credential-stdin`, a credential that does not arrive
  (stdin is a terminal, closes empty, holds more than one token, cannot be
  read, or stays open past 10 s). The reason is the last line on stderr,
  prefixed `switch-agent-controller: `. Once the controller is running,
  failures talking to Switch are retried inside the process and do not end
  it.

Stopping the controller does **not** stop its agents. The watchers are detached
processes, and they keep running the last assignment, but they cannot reach Switch
while the relay is down: they keep retrying. The next `run` binds the relay to the
same port again and accepts the tokens already in each agent's credentials file, so
the watchers reconnect where they left off. If the port has been taken in the
meantime, the relay takes a new one, rewrites each agent's credentials, and restarts
the running watchers so they read them. Agents stop when Management says so, or when
the controller is revoked.

To run it as a service, have your init system run `run` and restart it on exit code
`1` only. Do not restart it on `2`, because it would fail the same way until its
configuration is fixed, nor on `3`, because a revoked controller must be enrolled
again, nor on `4`, because two instances would take the stream from each other in
turn. With systemd, `Restart=on-failure` and `RestartPreventExitStatus=2 3 4`.

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
  environment, so the watchers and sessions the controller starts never inherit
  it. On revocation the controller forgets it, records the revocation in
  `controller.db` and exits with code `3`; the parent deletes its own copy.
- `--shared-host-bundle` (or `SWITCH_CONTROLLER_SHARED_HOST_BUNDLE`) names the
  agent-providers shared-host bundle. Without it the controller resolves the one
  built in the workspace, which a bundled controller does not have. `status`
  takes the same flag.

Under Console the controller runs on Electron's own binary with
`ELECTRON_RUN_AS_NODE=1`, as Console runs its local hosts. That variable stays in
the environment the controller passes to the shared host, so the watchers and
session hosts it launches with `process.execPath` run as Node too.

## How it works

- Exchanges its long-lived credential for a one-hour access token. It refreshes the
  token at 80% of its lifetime, and exchanges once more if a request is refused
  with a 401.

### The controller stream

- Opens a connection (`POST /v1/controllers/{id}/connection`) with each agent's
  cursor (the last sequence its watcher confirmed, or `"head"`), then attaches the
  stream (`GET /v1/controllers/{id}/events`). The stream carries every bound agent's
  events (`agent.event`, `agent.gap`, `agent.session_command`,
  `agent.approval_outcome`), its attachment and room membership (`agent.attached`,
  `agent.detached`, `agent.rooms`), and the management nudges (`assignment.changed`,
  `operation.pending`, `credential.revoked`).
- Beats the connection (`POST .../connection/beat`) every `heartbeat_interval_s`
  (2 s) while the stream is attached, with each agent's confirmed cursor.
- The open and every beat also carry `placements`: for each agent with a session
  placed in a room by one of its live local connections, those rooms. It is the
  whole current map each time (Switch replaces what it held), and agents with no
  placement are left out, so a placement the watcher makes reaches Switch on the
  next beat.
- A dropped stream is reattached to the same connection. A connection Switch no
  longer knows (`unknown_connection`, `stale_generation`, or any `evicted` but
  `taken_over`) is opened afresh, from the cursors as they stand. Reconnects back
  off with jitter, and a stream silent for 45 s (Switch writes a keepalive every
  15 s) counts as dropped.
- `taken_over`, as a frame or a refusal, means another instance of this controller
  opened the stream. This one exits with code `4` and leaves the agents running.
- An agent's cursor moves only once its watcher has confirmed reading that far: the
  relay advances it from the watcher's own heartbeat, as Switch does for an agent's
  connection. It is kept in `controller.db`, so a restarted controller resumes each
  agent where its watcher stopped.

### The local relay

- Listens on `127.0.0.1` only, on a port chosen once and reused while it is free.
  Each agent's `agents/<id>/credentials.json` names it as `SWITCH_API_ENDPOINT`,
  with a token minted for that agent (`swlr_…`) as `SWITCH_API_TOKEN`. A token the
  relay did not mint is refused with `401`; while the controller is still starting,
  with `503`, so a watcher that reconnects early retries instead of stopping.
- **Answered locally**, reproducing the per-agent agent protocol so the watcher and
  session hosts run unchanged:
  - `GET /agents/{id}/events`: the agent's own stream, served from what the
    controller stream delivered. `connection_state` first, domain events with their
    sequence as the SSE id, `missed` counts as Switch computed them, resume through
    `Last-Event-ID`, and the `addressed` filter applied locally. Control frames:
    `gap`, `evicted` (another local stream took the connection, or its heartbeat
    lapsed), `subscription_changed`, `room_released`, `session_command` and
    `approval_outcome`.
  - `POST /agents/{id}/connection/beat`, `/connection/placements`,
    `/connection/subscribe` and `/connection/unsubscribe`, with Switch's answers
    and refusals (`404` for a connection that is not open; `409` with
    `taken_over`, `unfenced` or `no_stream`).
  - Placements say which room each session works in. An in-room command
    (`!reset`, `!compact`, `!interrupt`) arrives for a room and is handed to the
    session placed there.
- **Forwarded to Switch**, everything else under `/agents/{id}/…`,
  `/agent-sessions/…`, `/sessions/…`, `/version` and `/health`: operations, media,
  typing, history, session activity and approvals. The relay sends them with the
  controller's access token, `X-Switch-Agent-Id`, and `X-Switch-Room-Id`: the room
  the calling session is placed in (from `X-Switch-Session-Id`), or else the single
  room of the connection the call names. The local connection id is not passed on.
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
    writes the watcher root `<data>/watchers/<id>/` (`watch.json`, `template.json`),
    and runs the bundle with `--ensure-watch false`.
  - **Desired `running`, at a newer revision:** the same, as a restart. The
    watcher is turned off and waited out, then launched again with the new
    template.
  - **Desired `running`, watcher gone with no recorded failure** (after a
    reboot, say): the watcher is launched again, once 15 s have passed since it
    was last launched, so a watcher still coming up is not launched twice.
  - **Desired `running`, relay credentials rewritten** (the relay came back on
    another port): a running watcher is restarted so it reads them.
  - **Watcher failed or was taken over:** it is left down, and reported as
    `failed`. A new revision or an `agent.restart` brings it back. One that failed
    because the relay refused its token is relaunched once it has a new one.
  - **Desired `stopped`:** `watch.json` is set to `{enabled: false}`.
  - **Removed from the assignment:** it is stopped, the relay stops accepting its
    token, and its credentials file and cursor are deleted.
  - **Revision older than the one already applied:** the controller refuses it
    (fencing).
- Status (`PUT .../status`) is sent on every observed change and at least every
  `report_within_s`, and never more than once a second. It carries:
  - **Machine:** platform, disk, memory, sessions.
  - **Providers:** installed (a `PATH` lookup and `--version`), and login (the
    bundle's `--probe`, cached for 10 minutes).
  - **Agents:** each one read from its watcher's `health.json` and
    `supervisor/failure.json`. `attached` means the agent's events are flowing on
    the controller stream (Switch attached it, and the stream is up) and its
    watcher is connected to the relay.
- Operations:
  - `agent.restart` and `provider.recheck` run.
  - Every other kind is answered `failed` with `operation_unsupported`.
- On `credential.revoked`, or on any request refused as `controller_revoked`: it
  turns every agent off, stops accepting their tokens, deletes their credentials
  files and the controller credential, and exits with code `3`.

## What it does not do

- No connector tokens and no sealed provider logins.
- A session that calls `connect_to_room` on a connection of its own does not have
  the room claimed for that connection by the relay: Switch claims nothing for a
  controller-backed agent, and the watcher states every placement itself right
  after the call, which is what the relay tracks. The shared host's sessions make
  their calls through the watcher, so this does not arise today.
- An in-room command for a room with no session placed here, or arriving while the
  watcher is not connected, is dropped with a warning in the log. Switch keeps no
  copy to send again.
- Only enrollment by one-time code, or adoption of an identity a parent process
  enrolled (see "Run by a parent process"). There is no EC2 machine secret, and
  the controller itself has no OS keychain backend.
- No session limit is enforced. `sessions_max` is reported as `0`.
- OOM kills are not detected. `oom_kills` is always `0`.
- `restarts_10m` counts the relaunches this controller made, not the restarts a
  watcher's own supervisor made.
- No crash-loop guard. A watcher that exits with an error stays down until it is
  restarted on purpose, so there is no loop to guard.
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
| `secrets/controller-credential` | The controller credential (see below). Absent when the credential is handed over with `--credential-stdin`. |
| `agents/<id>/credentials.json` | Each agent's relay endpoint and relay token, in the layout the shared host reads. No Switch credential. |
| `watchers/<id>/` | Each agent's watcher state root: `watch.json`, `template.json`, `config.json`, `health.json`, `supervisor/` logs and failure record. |
| `workspaces/<name>/` | The working directory of an agent whose definition sets none. |

Sessions a watcher starts keep their state where the shared host puts it
(`~/.local/state/switch/sdk-sessions/`), as they do under Console.

## The file secret store

Run on its own, v1 keeps the controller credential in a plaintext file. The file has mode 0600 and
sits in a 0700 directory. No OS keychain backend exists yet, and the controller logs
a warning saying so every time it starts. Anyone who can read this user's files, or
a backup of them, can act as this controller until it is revoked. If the file is
ever readable by other users, the controller refuses to use it. In that case, revoke
the controller in Switch and enroll it again.

The agents' relay tokens are plaintext files too, because the shared host reads
them that way. They are worth much less: the relay accepts them only on the
loopback interface, only while this controller runs, and only for that agent's own
routes. They hold no Switch credential, and a restart of the controller that has to
change port replaces them.
