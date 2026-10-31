# Run agents on your own machine

The Switch agent controller is a headless service that runs the agents assigned
to one machine. Use it for a server, workstation, or VM where Switch Console is
not responsible for keeping the agents running.

One controller serves all agents assigned to that machine. It opens one outbound
HTTPS/WebSocket connection to Switch, so the machine does not need an inbound
port.

## Before you start

You need:

- macOS, Linux, or Windows 10/11;
- Node.js 22.13 or later (`node --version`);
- a Switch server with agent management enabled;
- access to **Machines** in the Switch gateway; and
- each provider CLI your agents use, installed on `PATH` and signed in as the
  same operating-system user that runs the controller.

Supported provider commands include `claude`, `codex`, `opencode`,
`cursor-agent`, and `antigravity-acp`. Antigravity has no Windows build.

If you self-host Switch, enable agent management with
`FEATURE_FLAGS_ENABLED=agent_management`. Behind a proxy, route `/v1` to
switch-core. The server URL used below must be HTTPS, except for a loopback
development server.

## Install and enroll

In the gateway, open **Machines**, choose **Add machine**, and copy the command
it shows. The one-time code expires after ten minutes. It looks like this:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code>
```

The installer verifies the signed release, installs it without npm lifecycle
scripts, enrolls the machine, and installs the user service. Do not reuse the
example URL or literal `<code>`.

To install and enroll separately:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh | sh

switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <code> \
  --name build-box \
  --description "Build agents"
```

`--name` defaults to the host name. Add `--data-dir <dir>` to every command if
you do not want the OS default. Add `--secret-store keychain`,
`secret-service`, or `file` to `enroll` to choose where the long-lived
controller credential is kept. The default is Keychain on macOS and
owner-only files elsewhere.

After enrollment, change the label shown in **Machines** without reenrolling:

```bash
switch-agent-controller set-info --name build-box-2 --description "Nightly builds"
```

## Keep it running

On macOS and Linux, install a service for the current user:

```bash
switch-agent-controller install-service
switch-agent-controller status
switch-agent-controller doctor
```

`install-service` uses a launchd agent on macOS and a systemd user unit on
Linux. It starts immediately and at login. On Linux, the command reports when
you need lingering so the controller also starts at boot and survives logout:

```bash
sudo loginctl enable-linger "$USER"
```

On a minimal Linux system without a systemd user manager, or under another
supervisor, run the foreground process instead:

```bash
switch-agent-controller run
```

On Windows, Switch Console starts and stops the controller. `install-service`
is intentionally unsupported; use Console or keep `switch-agent-controller
run` alive with your own supervisor.

`status` reads local state and makes no network request. `doctor` checks Node,
enrollment, the server, provider installations and sign-ins, the service, and
available updates. Run both after installation and whenever a machine stops
accepting work.

To remove the user service but keep enrollment and agent state:

```bash
switch-agent-controller uninstall-service
```

## Sign providers in

The service must see the same login that works for its operating-system user.
For interactive provider logins, sign in before installing the service and
confirm the provider CLI is on `PATH`. `install-service` records the current
shell's `PATH`.

For API keys and cloud-provider settings, create an owner-readable environment
file:

```bash
chmod 600 /path/to/agents.env
switch-agent-controller install-service --env-file /path/to/agents.env
switch-agent-controller doctor --env-file /path/to/agents.env
```

The file accepts `NAME=value`, comments, blank lines, optional `export`, and
single- or double-quoted values. For example:

```dotenv
# Claude Code on Vertex AI
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

Restart or reinstall the service after changing the file; it is read once at
startup. Do not put provider secrets directly in a shell command or commit the
environment file.

The owner can also send a provider login from Switch Console. It is sealed to
the controller's enrollment key before Switch stores it. A local CLI login or
environment-file credential takes precedence over a delivered login.

## Shared and isolated agents

Choose an agent's isolation mode when you define it in Switch:

- **Shared** runs the agent host inside the controller process. It is lighter,
  but it shares the controller user's filesystem permissions.
- **Isolated** runs the agent host in a separate process. It reconnects after a
  controller restart and is not stopped merely because the controller exits,
  but it still runs as the same OS user by default.

Changing isolation restarts that agent. It does not erase the conversation or
workspace.

For stronger Linux isolation, an administrator can install the controller in
separate-user mode. This creates a bounded pool of system users and confines
each agent to its own directory. Follow the package README's separate-user
procedure; it requires root, systemd, polkit, and system-wide Node, controller,
and provider CLI installs. Provider credentials must come from the environment
file or a sealed login because agent users cannot read the controller user's
home directory.

## State and workspaces

Controller state defaults to:

| OS | State directory |
|---|---|
| macOS | `~/Library/Application Support/Switch/agent-controller` |
| Linux | `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller` |
| Windows | `%LOCALAPPDATA%\Switch\agent-controller` |

Override it with `--data-dir <dir>` or `SWITCH_CONTROLLER_DATA_DIR`. The
directory contains the controller database, credentials, cursors, and agent
state; back it up and keep it private. A custom data directory identifies a
separate controller service, so use the same value for `enroll`,
`install-service`, `status`, `doctor`, and `run`.

When an agent definition does not name a directory, its workspace is:

```text
~/.switch/agents/<switch-server-host>/<agent-name>
```

Shared and ordinary isolated agents use that workspace. Separate-user mode
uses the configured agents directory (by default
`/var/lib/switch-agents/<controller-uid>`), where each agent sees only its own
subtree.

## Update safely

Check for a signed controller release and install it with:

```bash
switch-agent-controller update --check
switch-agent-controller update
```

The service normally follows the release named by Switch automatically. It
waits for active turns to become idle, verifies the release, switches versions,
and restarts. `update` is useful for a manual installation. On Windows, update
through Switch Console or install the named release manually.

## Troubleshoot

Start with:

```bash
switch-agent-controller status
switch-agent-controller doctor
```

On macOS, service logs are in `controller.log` under the data directory. On
Linux, read the user service log with:

```bash
journalctl --user -u switch-agent-controller
```

The last stderr line begins with `switch-agent-controller:` and is the reason a
foreground run stopped. Common reported reason codes mean:

| Reason | What to do |
|---|---|
| `provider_not_installed` | Install the named provider CLI where the service user can execute it, then reinstall/restart the service if `PATH` changed. |
| `provider_version_unsupported` | Update that provider CLI to a supported release. |
| `provider_login_missing` | Sign the service user in, add the required key to `--env-file`, or deliver a login from Console. |
| `provider_login_expired` | Renew the local or delivered provider login, then run `doctor` again. |
| `definition_invalid` | Correct the agent's provider options or working directory in Switch. A custom directory must already exist. |
| `capacity_exceeded` | Stop/move an agent, or enlarge the separate-user pool by rerunning its setup with a larger `--agent-users` value. |
| `disk_full` | Free space in the state/workspace filesystem before restarting work. |
| `crash_loop` | Inspect the agent/provider log, fix the repeated failure, then explicitly restart the agent or change its revision. |
| `controller_offline` | Check the service and outbound HTTPS/WebSocket access to the Switch server. |
| `taken_over` | Another process opened the same controller identity. Stop the duplicate and start only one instance. |
| `protocol_unsupported` | Update the controller. |
| `controller_revoked` or `invalid_credential` | Delete or move aside the old data directory if appropriate, create a new Machines code, and enroll again. |

Useful process exit codes are `1` for a retryable network/server failure, `2`
for configuration that must be changed, `3` for a revoked controller, `4` for
a duplicate that took over, `5` for an unsupported protocol, and `6` for an
invalid credential. A service should restart code `1`, but should not loop on
codes `2` through `6` unchanged.

If `doctor` reports a stopped service, reinstall it with the same data and
environment-file arguments. Reenrollment is a last resort: it creates a new
machine identity, while reinstalling the service preserves the existing one.
