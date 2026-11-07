# Run agents on your own machine

The headless agent controller runs the agents assigned to one machine. It is
useful for a server or workstation where Switch Console does not manage the
agents. The controller connects to Switch over HTTPS and WebSocket; the machine
does not need an inbound port.

## Before you start

You need:

- Linux, macOS, or Windows 10/11;
- Node.js 22.13 or later on Linux and macOS (Switch Console supplies the
  runtime when it manages a Windows controller);
- a Switch server with agent management enabled; and
- at least one supported provider CLI installed and signed in as the operating
  system user who will run the controller, or an API key for that provider.

Supported providers include Claude Code, Codex, OpenCode, Cursor, and
Antigravity. Antigravity is not available on Windows. If you self-host Switch,
enable `agent_management` in `FEATURE_FLAGS_ENABLED`. If Switch is behind a
proxy, route `/v1` to switch-core.

## Install and enroll

In the Switch gateway, open **Machines**, choose **Add machine**, and copy the
one-time enrollment code. It expires after ten minutes.

On Linux or macOS, the installer verifies and installs the signed controller
release. When you provide the server URL and code, it also enrolls the machine
and installs the user service:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code>
```

Replace the example server and `<code>` with the values for your Switch
instance. The URL must use HTTPS, except for a local loopback development
server. To install without enrolling or installing a service, run the same
installer without `--server` and `--code`.

The installer uses stable controller releases and skips development
prereleases. If it reports that no controller release is available, wait for a
stable release before following these steps. For a checkout build, use the
development instructions in `console/packages/agent-controller/README.md`.

You can also install and enroll separately:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh | sh

switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <code> \
  --name build-box \
  --description "Build agents"
```

If the installer says its bin directory is not on `PATH`, add the printed
directory before running these commands. For the common `$HOME/.local` fallback:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The name defaults to the machine's host name. The description is optional and
can be changed later in the gateway. On Windows, Switch Console manages the
controller; the shell installer and `install-service` command are not
supported.

## Run and check the controller

On Linux and macOS, install and inspect the service with:

```bash
switch-agent-controller install-service
switch-agent-controller status
switch-agent-controller doctor
```

The service runs at login: systemd user service on Linux, launchd agent on
macOS. On Linux it also starts at boot and survives logout when lingering is
enabled:

```bash
sudo loginctl enable-linger "$USER"
```

If a Linux machine has no systemd user manager, run
`switch-agent-controller run` under your own supervisor and restart it after
exit code `1`. Do not restart it unchanged after configuration or credential
errors (exit codes `2` through `6`). On Windows, Switch Console starts and
stops the controller. The `install-service` command is unsupported there.

`status` reads local state and does not contact the server. `doctor` checks
enrollment, the server connection, Node, provider installation and sign-in,
service state, and updates. Run `doctor` when the machine or an agent is not
ready.

To remove the user service while keeping enrollment and agent state, run:

```bash
switch-agent-controller uninstall-service
```

If you used `--data-dir` during enrollment, pass the same directory to each
later command, for example `switch-agent-controller status --data-dir /srv/sw`.

## Sign in to provider CLIs

In the default mode, the service uses the provider login available to the
controller's operating system user. Sign in to the provider CLI before
installing the service, then confirm it is on that user's `PATH`. With Linux
`--separate-users`, agents run under isolated users and cannot use the
controller user's local CLI login. Install provider CLIs system-wide and put
provider API keys or settings in the service environment file.

For API keys or cloud provider settings, put the required variables in a
private environment file and pass it when installing the service:

```bash
chmod 600 /path/to/agents.env
switch-agent-controller install-service --env-file /path/to/agents.env
```

The file uses `NAME=value` lines and supports comments, blank lines, optional
`export`, and quoted values. For example:

```dotenv
# Claude Code on Vertex AI
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

The file is read when the controller starts. Reinstall or restart the service
after changing it. Do not put keys in a shell command, share the file, or commit
it to a repository. To check provider readiness with the same file, run
`switch-agent-controller doctor --env-file /path/to/agents.env`.

For Linux `--separate-users`, pass the file when installing the service. The
controller supplies its provider settings to the agent users:

```bash
sudo switch-agent-controller install-service --separate-users --env-file /path/to/agents.env
```

## Agent isolation and workspaces

An agent's isolation mode is set in its Switch definition:

- **Shared** runs the agent host inside the controller process.
- **Isolated** runs the agent host in its own process and lets it reconnect
  after a controller restart.

Both modes run with the controller user's operating system permissions by
default. Process isolation does not prevent an agent from reading files that
user can access. On Linux, an administrator can configure the advanced
`install-service --separate-users` mode to run agents as separate system users
with separate directories; it requires systemd, polkit, root access, and
system-wide Node and provider installations. See the controller package README
for the setup and removal commands.

In the default shared-user mode, when an agent definition does not specify a
working directory, its workspace is created under:

```text
~/.switch/agents/<server-host>/<agent-name>
```

The server folder is based on its host name; a local server such as
`http://localhost:8000` uses `localhost-8000`.

With Linux `--separate-users`, workspaces instead live under
`/var/lib/switch-agents/<controller-uid>/agent/`; each agent gets its own
directory there. The base path changes if you set `--agents-dir` during setup.

The controller's data directory holds its database and service state. In the
default shared-user mode it also holds agent runtime state. A file-stored
controller credential is kept there on Linux by default; with the `keychain` or
`secret-service` store, the credential is in the OS keychain or keyring instead.
Back up that store separately if you need to preserve the credential. The data
directory defaults to:

| Operating system | State directory                                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| macOS            | `~/Library/Application Support/Switch/agent-controller`                                |
| Linux            | `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller` |
| Windows          | `%LOCALAPPDATA%\Switch\agent-controller`                                               |

Set `SWITCH_CONTROLLER_DATA_DIR` or pass `--data-dir` to use another location.
Keep the data directory private and back it up for local controller state. In
Linux `--separate-users` mode, also back up the agents directory (default
`/var/lib/switch-agents/<controller-uid>`), which holds agent homes and
workspaces. The service environment file may contain provider secrets; back it
up securely if needed.

## Update

The controller follows releases named by Switch when it is running as a
service. To check for or install the latest release manually, run:

```bash
switch-agent-controller update --check
switch-agent-controller update
```

The update is verified before installation. Switch Console manages updates for
controllers it starts on Windows.

## Troubleshoot

Start with:

```bash
switch-agent-controller status
switch-agent-controller doctor
```

On Linux, read the service log with
`journalctl --user -u switch-agent-controller`. On macOS, find `controller.log`
in the state directory.

| Reason                                       | What to check or fix                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_not_installed`                     | In default mode, install the provider CLI for the controller user and make sure it is on that user's `PATH`. With Linux `--separate-users`, install CLIs system-wide.                                                               |
| `provider_version_unsupported`               | Upgrade the provider CLI to a supported version.                                                                                                                                                                                    |
| `provider_login_missing`                     | In default mode, sign in as the controller user or configure the provider in the service environment file. With Linux `--separate-users`, use system-wide provider CLIs and provide credentials/settings in that file.              |
| `provider_login_expired`                     | Renew the provider login or key, then run `doctor` again.                                                                                                                                                                           |
| `definition_invalid`                         | Correct the agent's provider settings or working directory in Switch. A custom working directory must exist.                                                                                                                        |
| `capacity_exceeded`                          | Stop or move an agent, or increase the configured separate-user pool.                                                                                                                                                               |
| `disk_full`                                  | Free space on the filesystem that holds the controller state or agent workspace.                                                                                                                                                    |
| `crash_loop`                                 | Use `doctor` and the provider logs to find the repeated failure, fix it, then restart the agent or change its definition.                                                                                                           |
| `controller_offline`                         | Check the service and outbound HTTPS/WebSocket access to the Switch server.                                                                                                                                                         |
| `taken_over`                                 | Stop the other controller process using the same machine identity, then start one instance.                                                                                                                                         |
| `protocol_unsupported`                       | Upgrade the controller to a release compatible with the Switch server.                                                                                                                                                              |
| `controller_revoked` or `invalid_credential` | Check the machine in the gateway. If it was revoked or its credential was replaced, create a new enrollment code and enroll into an empty data directory. Keep the old directory until you have recovered any local state you need. |

The controller's exit code is useful when running it under a supervisor: `1`
is a retryable network or server failure; `2` is a configuration error; `3`
means the controller was revoked; `4` means another instance took over; `5`
means the server requires a newer controller; `6` means the credential is
invalid; and `7` means it installed an update and should be started again.
