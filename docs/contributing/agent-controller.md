# Running the headless agent controller

`switch-agent-controller` runs the Switch agents that Management assigns to one
machine and reports their status. Run one per machine. It is the headless half
of agent management: Switch Console runs agents on the computer you work on,
and the controller runs them on a machine nobody is sitting at — a build box,
a cloud VM, a home server.

This guide covers install, enrollment, running it as a service, and keeping it
healthy. The design is in
[`docs/design/agent-controllers-v1.md`](https://github.com/sandbox-quantum/switch/blob/main/docs/design/agent-controllers-v1.md),
the wire contract in
[`docs/design/controller-contract-v1.md`](https://github.com/sandbox-quantum/switch/blob/main/docs/design/controller-contract-v1.md),
and the package's own
[README](https://github.com/sandbox-quantum/switch/blob/main/console/packages/agent-controller/README.md)
is the reference for every flag.

## What you need first

- **macOS, Linux, or Windows 10/11.** On Windows the controller is meant to run
  with Switch Console, which starts it (see *Windows* below).
- **Node 22.13 or later.** The controller's store uses the built-in
  `node:sqlite`.
- **One provider CLI per agent type**, installed on `PATH` and signed in as the
  user the controller runs as — `claude`, `codex`, `opencode`,
  `agent`/`cursor-agent`, `antigravity-acp` — or its API key in the `--env-file`
  the controller runs with. Switch coordinates agents; it does not ship one.
- **A Switch server with the `agent_management` feature flag on**
  (`FEATURE_FLAGS_ENABLED=agent_management`). Behind a proxy or ingress, `/v1`
  must reach switch-core (the Helm chart routes it).

## 1. Install

The gateway's **Machines** page shows the one command that installs the
controller, enrolls the machine, and starts it as a service:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code>
```

- Without `--server` and `--code`, `install.sh` only installs.
- `--data-dir <dir>` keeps the controller's state in that folder rather than
  the default one.
- It installs with `npm install --global` into npm's global prefix. When the
  user cannot write there, it installs into `~/.local` instead and says so if
  `~/.local/bin` is not on the `PATH`; the service runs the controller by its
  full path either way.
- You can also install the release package directly:
  `npm install --global <the release's .tgz URL>`.

## 2. Enroll the machine

Create a one-time enrollment code in Switch (the gateway's Machines page).
It is valid for **10 minutes**. Then:

```bash
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <code> \
  [--name build-box] [--description "The build box in the office"] \
  [--data-dir <dir>] [--secret-store keychain|secret-service|file]
```

- `--server` is the agent bridge URL and must be `https` (plain `http` is
  accepted only for a loopback server). Agents never see it: they reach Switch
  through the controller's local relay.
- `--name` defaults to the host name; `--description` is at most 500
  characters. Both are visible on the gateway's Machines page and can be
  changed later with `set-info`.
- `--secret-store` says where the controller credential lives: `keychain` (the
  default on macOS), `secret-service` (the Linux desktop keyring — choose it
  only where the keyring is unlocked whenever the controller starts, which a
  service started at boot usually is not), or `file` (the default on Linux: a
  0600 file in the data directory, with a logged warning at every start).
- The credential is exchanged for a one-hour access token, refreshed at 80% of
  its lifetime. No agent ever holds a Switch credential: each gets a token only
  the local relay accepts.

## 3. Run it

Foreground, to see it work:

```bash
switch-agent-controller run [--data-dir <dir>] [--env-file <path>]
```

As a service, so it survives logout and reboot:

```bash
switch-agent-controller install-service [--data-dir <dir>] [--env-file <path>]
```

- On Linux this is a systemd **user** unit
  (`~/.config/systemd/user/switch-agent-controller.service`; log with
  `journalctl --user -u switch-agent-controller`). It starts at each login, and
  at boot too — but surviving logout needs lingering on
  (`sudo loginctl enable-linger <user>`), which the command tells you about
  when it is off.
- On macOS it is a launchd agent
  (`~/Library/LaunchAgents/com.switch.agent-controller.plist`, logging to
  `controller.log` in the data directory).
- The service keeps the `PATH` of the shell that installed it, so the provider
  CLIs found then are found by the service.
- `uninstall-service` stops and removes the service and the releases it
  installed, and keeps the enrollment.
- On Linux **without** a systemd user manager (some containers and minimal
  VMs), `install-service` refuses. Run `run` under your own supervisor instead,
  with the restart rules below.

### Environment for the agents

`--env-file <path>` reads `NAME=value` lines (comments, blank lines, `export`,
single or double quotes), as systemd's `EnvironmentFile=` does, into the
environment the agents inherit:

```bash
# Claude Code on Vertex AI, signed in with `gcloud auth application-default login`
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

Sessions inherit only the provider variables Switch knows (API keys, base
URLs, model overrides, and the Vertex AI, Bedrock and Google Cloud settings),
plus the basics a CLI needs. The file is read once at start — restart the
service after changing it.

## 4. Check it

```bash
switch-agent-controller status [--data-dir <dir>]   # local state only, no network call
switch-agent-controller doctor [--data-dir <dir>] [--env-file <path>]
```

`status` reads only local state and makes no network call. `doctor` checks
what a machine needs to run agents and says what to do where it falls short:
Node, the platform, enrollment, the credential, the server (exchanging the
credential, so a proxy that does not send `/v1` to switch-core shows up), the
shared-host bundle, each provider CLI on `PATH` and its sign-in, the service,
and updates. It exits 1 when a check fails — that is the one command to run
first when an agent will not start.

Logging goes to stderr; set the level with `SWITCH_CONTROLLER_LOG_LEVEL`
(`debug`, `info`, `warn`, `error`; the default is `info`).

## 5. Understand the exit codes

The exit code tells a supervisor what to do. Restart on `1` and `7` only:

| Code | Meaning | Restart? |
|---|---|---|
| `0` | Stopped by SIGINT/SIGTERM, or the command finished | No |
| `1` | An error that may pass: the network, the server, or a crash | Yes, with backoff |
| `2` | A configuration error starting again unchanged cannot fix | No, not until the configuration changes |
| `3` | The server revoked this controller | No: enroll again |
| `4` | Another instance took the controller stream over | No |
| `5` | The server does not speak this controller's protocol | No: update the controller |
| `6` | The server knows no controller by this credential | No: enroll again |
| `7` | It installed the release Switch names and is restarting into it | Yes, at once |

With systemd: `Restart=on-failure` and
`RestartPreventExitStatus=2 3 4 5 6`. Code `2` covers an unknown command or
option, a server URL that is not one, a data directory that belongs to another
controller identity, and the other configuration faults; the reason is the
last line on stderr, prefixed `switch-agent-controller: `.

## 6. Shared and isolated agents, and where workspaces live

By default every agent runs as the user the controller runs as, so an agent can
read the controller's files, its credential, and the other agents' files. An
agent whose definition asks for `isolation: "isolated"` instead runs as an
agent host in a process of its own, hears its events on the controller's hub,
and is not stopped when the controller exits.

On Linux with systemd and polkit, each agent can run as a **Linux user of its
own**, seeing only its own directory:

```bash
sudo npm install --global <the release's .tgz URL>   # Node and the controller system-wide
switch-agent-controller enroll --server https://switch.example.com --code <code>
sudo switch-agent-controller install-service --separate-users [--env-file /etc/switch/agents.env]
```

The setup creates a pool of system users (`sa<uid>-01` …, 16 by default,
`--agent-users <n>` up to 99), a systemd template unit per agent, a polkit rule
that lets the controller's user start, stop, restart and reset those units and
nothing else, and the agents' directories in `/var/lib/switch-agents/<uid>`.
Node, the controller and the provider CLIs must be installed outside the home
directories (`/usr`, `/usr/local` or `/opt`), where the agents can reach them.
`sudo switch-agent-controller uninstall-service --separate-users` removes what
the setup made, except the agents' directories and the releases directory.

An agent whose definition names no directory works in
`~/.switch/agents/<server>/<name>/`; the server fills the path in once the
controller reports `machine.workspaces_dir`.

## 7. Provider sign-in on the machine

Three ways a machine gets its providers, in the order the controller prefers
them:

1. **The machine's own login** — a provider CLI on `PATH`, signed in as the
   controller's user, or an API key in the `--env-file`.
2. **A login given by its owner** (for a cloud machine or a fresh SSH host):
   `enroll` makes an X25519 keypair, keeps the private half in the secret store
   and sends the public half to Switch; Console seals the login to that key
   before sending it, so Switch stores and relays only ciphertext it cannot
   open. From then on the provider is reported ready with
   `auth_source: "sealed"`. Logins are kept in memory only and fetched again
   every ten minutes.
3. **A Claude Vertex AI login** — a Google Cloud project, a region, and a
   Google credential (a service account key with `roles/aiplatform.user` is
   recommended over an owner-wide `gcloud auth application-default login`).
   The agent host writes the credential to `provider-home/google-credentials.json`
   in its own state (mode 0600).

`doctor` checks the providers the way an agent would see them — which is the
difference between "the CLI is installed" and "the CLI is signed in".

## 8. Updates

When Switch names a release for this controller (`controller_release` in a
status response), `run` follows it: it waits until no session is mid-turn,
downloads the package into `<data dir>/updates/` (at most 200 MB), checks its
SHA-256 against the one Switch gave — the only one trusted — installs from
that file, and exits with code `7` so the service starts it again on the new
release. A failed attempt is reported and not retried for an hour.

By hand: `switch-agent-controller update` installs the newest published
release and restarts the service; `update --check` only says whether there is
one. A controller Switch Console runs never updates itself — Console replaces
its bundle instead.

## 9. Where the data lives

The data directory is the first of these that is set: `--data-dir`,
`SWITCH_CONTROLLER_DATA_DIR`, or the OS default
(`~/Library/Application Support/Switch/agent-controller` on macOS,
`$XDG_STATE_HOME/switch/agent-controller` or
`~/.local/state/switch/agent-controller` on Linux,
`%LOCALAPPDATA%\Switch\agent-controller` on Windows). It is created mode 0700
and holds:

| Path | What |
|---|---|
| `controller.db` | SQLite: identity, cached assignment, per-agent applied revision and local failures, restart times, each agent's stream cursor, the relay's port. Everything except the identity can be rebuilt from the server. |
| `secrets/controller-credential` | The controller credential, with the `file` secret store. |
| `agents/<id>/credentials.json` | Each agent's relay endpoint, relay token and hub. No Switch credential. |
| `agent hosts/<id>/` | Each agent's agent host state root (`watch.json`, `config.json`, `health.json`, its journal). |
| `updates/` | A release being downloaded to, and npm's cache. |
| `releases/` | With `install-service`: the releases the controller installed for itself, and `current`, the link the service runs through. |

## 10. Windows

The controller runs natively on Windows, without WSL. Switch Console starts it
and stops it, so it is not installed as a service there: `install-service`
refuses, and a controller started by hand is run with `run`. Its data lives in
`%LOCALAPPDATA%\Switch\agent-controller`, whose access list is set to the
current user and the system alone.

- Provider CLIs are found on `PATH` with `PATHEXT`, so `claude.exe` and an npm
  install's `codex.cmd` both count.
- Antigravity has no Windows build, so it is reported as not installed.
- `--agent-runtime separate-user` is Linux only.
- An agent's shell setup is refused: it is a POSIX shell snippet.
- Stopping an agent host asks it over its IPC channel or a stop file in its
  state root, since Windows has no catchable SIGTERM.

## What it does not do

- No connector tokens and no sealed provider logins.
- No session limit is enforced (`sessions_max` is reported as `0`), and OOM
  kills are not detected (`oom_kills` is always `0`).
- Only enrollment by one-time code, or adoption of an identity a parent process
  enrolled. There is no EC2 machine secret.
- An in-room command for a room with no session placed here is dropped with a
  warning; Switch keeps no copy to send again.
