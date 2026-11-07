# Agent Controller Guide

The Switch Agent Controller runs agents on a machine connected to your Switch instance. It allows Switch Management to assign work to that machine while the controller manages agent processes and their connection to Switch.

This guide covers installation, enrollment, service management, provider setup, troubleshooting, and security.

## 1. Requirements

Before installing the controller, check the following:

- Node.js 22.13 or later.
- A supported operating system: macOS, Linux, or Windows 10/11.
- A supported agent provider CLI installed and available on `PATH`, or provider credentials supplied through an environment file.
- Access to a Switch instance with Agent Management enabled.
- The Switch server must have the `agent_management` feature enabled through `FEATURE_FLAGS_ENABLED`.
- Network access to the Switch API. If a reverse proxy is used, it must route `/v1` requests to `switch-core`.

The controller uses Node.js built-in SQLite support, which requires Node.js 22.13 or later.

### Platform differences

- **macOS:** Supports installation and a user-level launchd service.
- **Linux:** Supports installation and a user-level systemd service. An advanced separate-user mode is also available.
- **Windows:** The controller is managed by Switch Console. The standalone installer and `install-service` command are not supported.

Antigravity does not have a Windows build. The separate-user runtime is Linux-only.

## 2. Install the controller

### macOS and Linux

Open a terminal and use the installation command provided by the Machines page in Switch:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <enrollment-code>
```

Replace the server URL with your Switch API URL and `<enrollment-code>` with the one-time code generated from the Machines page.

The installer:

1. Checks the operating system and Node.js version.
2. Downloads a published stable controller release.
3. Verifies the release signature.
4. Installs the controller using npm.
5. Enrolls the machine.
6. Installs the service unless `--no-service` is specified.
7. Runs the controller diagnostic checks.

The enrollment code is valid for 10 minutes. Generate a new code if it expires.

Additional installer options:

- `--name <name>`: Set the machine name.
- `--description <text>`: Add a machine description.
- `--data-dir <path>`: Use a custom controller data directory.
- `--no-service`: Skip service installation.
- `--version <version>`: Install a specific version.

If you install without `--server` and `--code`, only the CLI is installed. You can enroll the machine later.

If the installer reports that its binary directory is not on your `PATH`, add the directory shown in its output to your shell's `PATH`.

### Windows

Windows machines are managed through Switch Console. The standalone shell installer and `install-service` command are not supported.

The default controller data directory is:

```text
%LOCALAPPDATA%\Switch\agent-controller
```

## 3. Enroll a machine

If the machine was not enrolled during installation, generate an enrollment code from the Machines page in Switch.

Run:

```bash
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <enrollment-code> \
  --name build-machine \
  --description "Build machine"
```

Replace the server URL and enrollment code with your own values.

The name and description are optional. If no name is provided, the machine hostname is used.

The enrollment code is valid for 10 minutes. Generate a new code if it expires.

The server URL must use HTTPS. Plain HTTP is accepted only for loopback addresses.

Enrollment creates the controller identity and stores its credentials in the configured secret store. Keep the controller data directory and credentials protected.

## 4. Install and manage the service

On macOS and Linux, install the user-level service using:

```bash
switch-agent-controller install-service
```

You can also specify a custom data directory and environment file:

```bash
switch-agent-controller install-service --data-dir <path> --env-file <path>
```

The service runs under the current operating-system user.

### Linux

The controller uses a systemd user service:

```text
~/.config/systemd/user/switch-agent-controller.service
```

View its logs with:

```bash
journalctl --user -u switch-agent-controller
```

To allow the service to start at boot and continue after logout, enable lingering:

```bash
sudo loginctl enable-linger <user>
```

### macOS

The controller uses a launchd agent:

```text
~/Library/LaunchAgents/com.switch.agent-controller.plist
```

The controller log is stored in `controller.log` inside the data directory.

### Windows

Service management is handled by Switch Console. The standalone `install-service` command is not supported.

### Remove the service

On macOS and Linux, remove the installed service using:

```bash
switch-agent-controller uninstall-service
```

This removes the service and its installed releases but keeps the machine enrollment.

## 5. Configure agent providers

Install the provider CLI you intend to use and ensure that it is available on the controller user's `PATH`.

The supported provider login commands are:

| Provider | Login command |
|---|---|
| Claude | `claude auth login` |
| Codex | `codex login` |
| OpenCode | `opencode auth login` |
| Antigravity | `antigravity-acp --login` |
| Cursor | `agent login` |

In the default shared-user mode, sign in as the same operating-system user that runs the controller.

In Linux separate-user mode, agents run under dedicated operating-system users and do not inherit the controller user's local provider login. Configure provider credentials and settings through the service environment file, and install provider CLIs system-wide so the agent users can access them.

For Cursor, the controller uses the `agent` binary and launches it in ACP mode.

Alternatively, configure provider API keys and settings through an environment file. Never commit API keys or other secrets to source control.

## 6. Configure an environment file

An environment file can provide provider API keys, base URLs, model overrides, and supported cloud-provider settings.

Example:

```bash
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

Pass the file when running the controller:

```bash
switch-agent-controller run --env-file <path>
```

Or when installing the service:

```bash
switch-agent-controller install-service --env-file <path>
```

The controller reads the environment file at startup. Restart the controller after changing it.

Protect the file because it may contain credentials. On Linux, restrict its permissions:

```bash
chmod 600 <path-to-env-file>
```

Never commit an environment file containing secrets.

## 7. Check controller status and diagnostics

Use the `status` command to inspect the controller's local state:

```bash
switch-agent-controller status
```

The `status` command reads local state only and does not contact the Switch server.

To run diagnostic checks, use:

```bash
switch-agent-controller doctor
```

You can also specify a custom data directory and environment file:

```bash
switch-agent-controller doctor --data-dir <path> --env-file <path>
```

The `doctor` command checks:

- Node.js runtime and operating system compatibility.
- Machine enrollment and controller credentials.
- Communication with the Switch server.
- Agent-host availability.
- Provider CLI installation and authentication.
- Service status.
- Available controller updates.

A non-zero exit code indicates that one or more diagnostic checks failed.

## 8. Update the controller

Check whether a newer release is available:

```bash
switch-agent-controller update --check
```

Install the latest published stable release:

```bash
switch-agent-controller update
```

The controller can also receive managed release updates from Switch Management. These releases are downloaded over HTTPS and validated using their SHA-256 checksum and Ed25519 signature.

The controller waits until active agent sessions are no longer in the middle of a turn before applying a managed update.

Windows updates are managed through Switch Console. Controllers built from a source checkout cannot self-update.

## 9. Controller data directory

The controller stores its local state, credentials, agent-host information, and release data in its data directory.

You can choose a custom directory using the `--data-dir` option or the `SWITCH_CONTROLLER_DATA_DIR` environment variable.

If neither is configured, the default locations are:

| Operating system | Default location |
|---|---|
| macOS | `~/Library/Application Support/Switch/agent-controller` |
| Linux | `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller` |
| Windows | `%LOCALAPPDATA%\Switch\agent-controller` |

The controller data directory is created with restrictive permissions where supported.

The location of the controller credential depends on the configured secret store:

- **File store:** The credential is stored in the controller data directory under `secrets/controller-credential`. Protect this file and its parent directory.
- **macOS keychain:** The credential is stored in the operating-system keychain, not directly in the controller data directory.
- **Linux Secret Service:** The credential is stored in the operating-system keyring, not directly in the controller data directory.

Back up the controller data directory and the configured operating-system keychain or keyring separately when applicable. In Linux separate-user mode, also account for agent runtime state under the configured agents directory.

Do not assume that backing up the controller data directory alone preserves every credential or agent state.

Do not manually delete or modify its contents while the controller is running.

## 10. Shared and isolated agent hosts

The controller supports two agent-host execution models:

### Shared host

Agents run inside the controller process. This is the simpler execution model and does not require a separate agent-host process.

### Isolated host

An agent host runs in a separate process and connects to the controller through a local relay hub using WebSocket communication.

An isolated agent host can continue running during a controller restart and reconnect afterward.

### How agents connect to Switch

The controller maintains the Switch WebSocket connection for its agents. Agents communicate with Switch through the local relay rather than holding the machine's Switch credential directly.

Each agent receives an agent-scoped relay credential.

### Linux separate-user mode

On Linux, an advanced separate-user mode is available. It runs agents under dedicated operating-system users to provide stronger process and filesystem isolation.

Create `/etc/switch/agents.env` before installing the service. Add the provider API keys or supported cloud-provider settings required by your agents.

Protect the environment file because it contains sensitive credentials:

```bash
sudo chmod 600 /etc/switch/agents.env
```

Install Node.js, the controller, and provider CLIs in system-wide locations so the dedicated agent users can access them.

Agents do not inherit the controller user's local provider login. Configure the required provider credentials through the service environment file.

Install separate-user mode using:

```bash
sudo switch-agent-controller install-service --separate-users --env-file /etc/switch/agents.env
```

In this mode, the default agent workspace is under:

```text
/var/lib/switch-agents/<uid>/agent/workspace
```

The agent runtime state is stored under the configured agents directory rather than the controller's default data directory.

This mode requires additional system configuration and should be enabled only by administrators who understand its operational requirements.

## 11. Troubleshooting

Start troubleshooting with the diagnostic command:

```bash
switch-agent-controller doctor
```

Check the following common issues:

| Problem | What to check |
|---|---|
| Enrollment fails | Verify the Switch server URL and generate a fresh enrollment code. |
| Connection fails | Check network access and confirm that the reverse proxy routes `/v1` to `switch-core`. |
| Provider not detected | Confirm that the provider CLI is installed and available on the controller user's `PATH`. |
| Provider authentication fails | Sign in as the controller user or configure the required credentials in the environment file. |
| Service does not start | Check the systemd logs on Linux or `controller.log` on macOS. |
| Permission errors | Verify that the controller user can access the data directory and provider CLI. |
| Windows controller issues | Confirm that Switch Console is managing the controller. |

### Enable debug logging

For more detailed logs, set the log level:

```bash
SWITCH_CONTROLLER_LOG_LEVEL=debug
```

Supported levels are `debug`, `info`, `warn`, and `error`.

### Process exit codes

| Exit code | Meaning | Recommended action |
|---|---|---|
| `0` | Clean stop or command completed | No action required |
| `1` | Transient network, server, or process failure | Allow retries or restart with backoff |
| `2` | Configuration error | Correct the configuration |
| `3` | Controller revoked | Enroll the machine again |
| `4` | The same identity is active on another instance | Investigate the other instance; do not repeatedly restart |
| `5` | Unsupported protocol | Update the controller |
| `6` | Invalid credential | Enroll the machine again |
| `7` | A release was installed and the process is restarting | Restart the controller immediately |

The controller may retry transient failures internally. Therefore, an individual network error does not necessarily mean the controller process has stopped.

## 12. Security recommendations

- Use HTTPS for the Switch server connection.
- Keep enrollment codes private and use them promptly.
- Protect the controller data directory and environment files.
- Never commit API keys, provider credentials, or environment files containing secrets to Git.
- Run the controller under an appropriate operating-system user.
- Consider Linux separate-user mode when stronger agent isolation is required.
- Do not share controller credentials or copy an enrolled identity to another machine.
