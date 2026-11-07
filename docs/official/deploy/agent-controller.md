# Headless agent controller

_Run Switch agents on your own servers, managed centrally from the Gateway_

Published at <https://docs.switchagents.ai/flintai/switch/deploy/agent-controller> — link readers there, not to this file.

The headless agent controller (`switch-agent-controller`) is a dedicated daemon and CLI that runs Switch agents on your own infrastructure — bare-metal servers, virtual machines, or cloud instances.

While [Switch Console](connect-agents/switch-console.md) runs agents interactively on your desktop or deploys them over temporary SSH sessions, the headless agent controller is designed for 24/7 server deployments. It installs as a background system service, starts at boot, survives reboots, and connects back to your Switch server over a single secure WebSocket connection.

From the Switch Gateway, you assign agents to enrolled machines, configure their models and instructions, and monitor their health. The controller automatically pulls its assignment, starts and reconciles agent sessions, manages local working directories, and reports live status.

## Requirements

Before installing the controller, ensure your host machine meets the following requirements:

- **Operating system:**
  - **Linux:** Ubuntu 22.04 or 24.04, Debian 12+, Fedora, or RHEL (recommended for production).
  - **macOS:** macOS 12 Monterey or later.
  - **Windows:** Windows 10 or 11 (runs interactively or through Switch Console; service installation is Linux and macOS only).
- **Node.js:** Node.js 22.13 or later. The controller uses the runtime's built-in `node:sqlite` for local state caching.
- **Provider CLIs:** Each provider CLI needed by your agents installed on `PATH` and signed in as the user running the controller:
  - Claude Code (`claude`)
  - Codex (`codex`)
  - OpenCode (`opencode`)
  - Cursor Agent (`cursor` or `agent`)
  - Antigravity (`antigravity-acp`, Linux and macOS only)
  Alternatively, you can provide API keys or tokens in an environment file (see [Provider authentication](#provider-authentication)).
- **Switch server:** A Switch server running with the `agent_management` feature flag enabled (`FEATURE_FLAGS_ENABLED=agent_management`) and `CONTROLLER_TOKEN_SECRET` configured (at least 32 characters). Reverse proxies and ingress controllers must route `/v1` requests to `switch-core`.

## Install and enroll

### 1. Generate an enrollment code

In the Switch Gateway, navigate to the **Machines** page and select **Enroll machine**. 

The Gateway generates a one-time enrollment code (prefixed with `swce_`) and displays the connection URL for your Switch server. Enrollment codes are valid for 10 minutes and can only be used once.

### 2. Run the one-line installer

Run the installation script on your server, passing your Switch API URL and the enrollment code:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code>
```

The installer performs the following actions:
1. Downloads the latest controller release archive (`switch-agent-controller-<version>.tgz`) and its signature file (`.sig`).
2. Validates the release's Ed25519 signature against built-in cryptographic keys.
3. Installs the package globally with `npm install --global --ignore-scripts` (or into `~/.local` if npm's global prefix is not writable by the current user).
4. Enrolls the machine with Switch using the one-time code.
5. Installs and starts the background service (systemd on Linux, launchd on macOS).
6. Runs `switch-agent-controller doctor` to verify system health.

You can customize the installer by passing additional flags after `--`:
- `--name <name>`: Display name for the machine in Switch (defaults to the host name).
- `--description <text>`: A description of what the machine is for (up to 500 characters, editable later).
- `--data-dir <dir>`: Custom directory for storing controller state and local databases.
- `--no-service`: Enroll the machine without registering or starting the system service.

### Manual installation and enrollment

If you prefer to install and enroll in separate steps:

1. Install the CLI binary without enrolling:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh | sh
   ```

2. Enroll the machine:

   ```bash
   switch-agent-controller enroll \
     --server https://switch.example.com \
     --code <code> \
     --name "build-box-01" \
     --description "Dedicated worker for builds and testing"
   ```

3. Choose a secret store (optional):
   By default, `enroll` chooses the standard secret store for your platform:
   - `file` (Linux default): Stores credentials in `<data-dir>/secrets/controller-credential` with strict `0600` permissions.
   - `keychain` (macOS default): Stores credentials securely in the macOS Keychain.
   - `secret-service` (Linux desktop): Integrates with GNOME Keyring or KWallet via `secret-tool`.

   You can override this with `--secret-store file|keychain|secret-service`.

4. Update machine details later:
   To rename the machine or update its description after enrollment:

   ```bash
   switch-agent-controller set-info --name "worker-primary" --description "Primary production runner"
   ```

## Running as a service

Running the controller as a managed system service ensures it starts on system boot, survives user logouts, and restarts automatically after crashes or updates.

### Install the service

Register and start the service for your current user:

```bash
switch-agent-controller install-service [--env-file <path>] [--data-dir <dir>]
```

- **Linux (systemd):** Creates a systemd user unit at `~/.config/systemd/user/switch-agent-controller.service`.
  
  **Important:** On Linux, systemd user services terminate when the user logs out by default. To allow the service to start at boot and continue running in the background, enable lingering for the user account:

  ```bash
  sudo loginctl enable-linger $USER
  ```

  Check service status and view logs:

  ```bash
  systemctl --user status switch-agent-controller
  journalctl --user -u switch-agent-controller -f
  ```

- **macOS (launchd):** Creates a launch agent at `~/Library/LaunchAgents/com.switch.agent-controller.plist`.
  Logs are written to `controller.log` inside the controller's data directory.

- **Uninstalling:** To stop and remove the service while preserving your machine's enrollment and agent state:

  ```bash
  switch-agent-controller uninstall-service
  ```

### Running manually or under custom supervisors

In minimal VM environments, Docker containers, or platforms without systemd user sessions, run the controller in the foreground:

```bash
switch-agent-controller run [--env-file <path>] [--data-dir <dir>]
```

If you manage the controller using Docker, Kubernetes, or process managers like Supervisord, configure your supervisor according to the controller's exit codes:

| Exit code | Meaning | Supervisor action |
| :-- | :-- | :-- |
| `0` | Normal termination (SIGINT or SIGTERM received). | Do not restart. |
| `1` | Transient failure (network dropped, server unavailable, or process crash). | Restart with exponential backoff. |
| `2` | Configuration error (invalid flags, bad data directory, missing bundle). | Do not restart until configuration is corrected. |
| `3` | Machine revoked in the Switch Gateway. | Do not restart. Must be re-enrolled with a new code. |
| `4` | Stream taken over by another instance using the same credentials. | Do not restart. |
| `5` | Server rejected protocol version (`protocol_unsupported`). | Do not restart. Update the controller. |
| `6` | Invalid credentials (`invalid_credential`). | Do not restart. Re-enroll the machine. |
| `7` | Self-update applied successfully; restarting into new version. | Restart immediately. |

On systemd, configure `Restart=on-failure` and `RestartPreventExitStatus=2 3 4 5 6`.

## Health, status, and updates

### Checking health with doctor

Run `switch-agent-controller doctor` to diagnose configuration, network, and provider issues:

```bash
switch-agent-controller doctor [--env-file <path>]
```

`doctor` inspects:
- **Node.js version:** Verifies that Node is 22.13 or newer.
- **Platform compatibility:** Checks OS and architecture support.
- **Enrollment & credential:** Checks that local credentials exist and are securely stored.
- **Server connectivity:** Exchanging credentials for an access token against `/v1/management/controllers/{id}/token`.
- **Shared host bundle:** Verifies the runtime engine that executes provider CLIs.
- **Provider readiness:** Scans `PATH` for provider CLIs (`claude`, `codex`, `opencode`, `cursor`, `antigravity`) and checks their authentication.
- **Service state:** Confirms whether the background service is running.
- **Version checks:** Compares the local version against published GitHub releases.

### Inspecting local state with status

To view the controller's local state without making external network calls:

```bash
switch-agent-controller status
```

`status` reads from the local SQLite database (`controller.db`) and prints:
- Controller ID, assigned name, and server URL.
- Available disk space and system memory.
- Installed providers and their local authentication state.
- Each assigned agent, its desired and actual process state (`running`, `stopped`, `failed`), working directory, and active sessions.

### Keeping the controller updated

The controller supports both automatic and manual updates:

- **Automatic updates:** When the Switch server publishes a new recommended release via `controller_release`, the controller:
  1. Waits until active agent sessions are idle (`waiting_idle`).
  2. Downloads the signed release package into `<data-dir>/updates/`.
  3. Verifies the package SHA-256 and cryptographic Ed25519 signature.
  4. Installs the new version into `<data-dir>/releases/<version>/` and points `<data-dir>/releases/current` to it.
  5. Exits with exit code `7`, prompting systemd or launchd to restart it immediately on the new release.
- **Manual updates:** Check for and install updates manually at any time:

  ```bash
  # Check if a newer version is available
  switch-agent-controller update --check

  # Download, verify, and install the newest release
  switch-agent-controller update
  ```

- **Disabling automatic updates:** If you prefer to manage controller versions strictly through your own deployment pipelines, disable self-updates by setting `SWITCH_CONTROLLER_SELF_UPDATE=off` in your environment or `--env-file`, or by passing `--no-self-update` to `run`.

## Agent execution and isolation

When agents are assigned to a controller in the Gateway, their definition specifies an execution mode:

### Shared agents (`isolation: "shared"`)

By default, agents run with shared isolation:
- Each agent runs inside the controller's main Node.js process as an in-process host.
- Sessions are spawned as child processes of the controller.
- All agents communicate directly with the controller's in-memory event hub.
- When the controller stops, all sessions stop; when the controller restarts, sessions resume from their confirmed message cursors.

### Isolated agents (`isolation: "isolated"`)

When an agent definition specifies isolated execution:
- The agent host runs in its own dedicated operating system process.
- It connects to the controller's local loopback WebSocket hub (`ws://127.0.0.1:<port>/hub`) using a locally minted relay token.
- Isolated agents survive controller restarts: when the controller restarts, isolated agent processes automatically reconnect and resume event delivery.

### Each agent as a separate Linux user (`--separate-users`)

For shared multi-tenant hosts or strict security isolation on Linux, the controller can run each agent under a dedicated system user account with restricted permissions:

```bash
sudo npm install --global --ignore-scripts <release.tgz>
switch-agent-controller enroll --server https://switch.example.com --code <code>
sudo switch-agent-controller install-service --separate-users [--env-file /etc/switch/agents.env] [--agent-users 16]
```

`install-service --separate-users` configures:
1. **User pool:** Creates a pool of system users (`sa<uid>-01` through `sa<uid>-NN`) in a shared group (`switch-agents-<uid>`).
2. **systemd template unit:** Registers `switch-agent-<uid>@.service` to run individual agents.
3. **polkit authorization:** Installs a polkit rule allowing the controller's unprivileged user to start, stop, and restart agent units without root.
4. **Sandboxed filesystem:** Each agent sees only `/var/lib/switch-agents/<uid>/agent`, containing its dedicated `home` and `workspace`. The rest of the filesystem is read-only, user home directories are inaccessible, other agent processes are hidden (`ProtectProc=invisible`), and access to cloud instance metadata (169.254.169.254) is blocked.

To uninstall separate-user isolation:

```bash
sudo switch-agent-controller uninstall-service --separate-users
```

## Where workspaces live

Agents work within directories on the host filesystem:

- **Default workspaces:** When an agent definition does not specify an explicit directory, the controller creates a workspace in:
  - **Linux / macOS:** `~/.switch/agents/<server-host>/<agent-name>/`
  - Example: `~/.switch/agents/switch.example.com/deploy-agent/`
  The controller automatically creates missing directories under this path.
- **Custom directories:** If an agent definition specifies an explicit working `directory`, the controller runs the agent in that exact path. The directory must already exist on the machine.
- **Under separate users:** Agents run strictly within `/var/lib/switch-agents/<uid>/agent/workspace`. Definitions specifying directories outside this path are refused.
- **Session states:** Transcripts and active session metadata are saved in `~/.local/state/switch/sdk-sessions/`.

### Controller data directory

The controller stores its local SQLite database (`controller.db`), relay tokens, and releases in:
- **Linux:** `$XDG_STATE_HOME/switch/agent-controller` (default `~/.local/state/switch/agent-controller`)
- **macOS:** `~/Library/Application Support/Switch/agent-controller`
- **Windows:** `%LOCALAPPDATA%\Switch\agent-controller`

The directory is created with restricted `0700` permissions.

## Provider authentication

Agents require credentials to interact with model providers. You can authenticate providers in three ways:

### 1. Local CLI sign-in

Log in directly on the machine using the provider's CLI under the user account running the controller:

```bash
# Sign in with Claude Code
claude login

# Sign in with Codex
codex login

# Sign in with OpenCode
opencode login
```

### 2. Environment file (`--env-file`)

Pass an environment file containing provider API keys to `install-service` or `run`:

```bash
switch-agent-controller install-service --env-file /etc/switch/agents.env
```

Example `/etc/switch/agents.env`:

```bash
# Anthropic / Claude Code
ANTHROPIC_API_KEY=sk-ant-api03-...
# Or an OAuth token:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-sso01-...

# OpenAI / Codex
OPENAI_API_KEY=sk-...

# OpenCode
OPENCODE_API_KEY=...

# Claude Code on Google Cloud Vertex AI
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project-id
CLOUD_ML_REGION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/etc/switch/vertex-sa.json

# Claude Code on AWS Bedrock
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-east-1
```

The controller filters environment variables before passing them to agent sessions: sessions inherit only recognized provider API keys, model overrides, and cloud platform configurations. After modifying the file, restart the service.

### 3. Sealed logins from Switch Console

For cloud instances or remote headless hosts where you do not want to store API keys on disk, you can deliver sealed logins directly from Switch Console:

1. When the controller enrolls, it generates an X25519 keypair and registers its public key with Switch.
2. In Switch Console, the machine owner seals provider credentials using the machine's public key and sends them to the server.
3. Switch relays the encrypted payload to the controller over its secure stream.
4. The controller decrypts the credentials in memory (`auth_source: "sealed"`). Credentials are never written to disk.

Local CLI logins and environment file variables always take precedence over sealed logins.

## Troubleshooting

### Common reason codes and fixes

When an agent fails to start or placement is refused, the Gateway, `switch-agent-controller status`, and `switch-agent-controller doctor` report specific reason codes:

| Reason code | Where seen | What it means | How to fix |
| :-- | :-- | :-- | :-- |
| `controller_offline` | Gateway, placement | The machine is disconnected or has stopped reporting status. | Verify that the controller service is active (`systemctl --user status switch-agent-controller`), has internet access, and that `/v1` routes to `switch-core`. |
| `provider_not_installed` | Gateway, status | The provider CLI is not found on `PATH` for the controller user. | Install the CLI globally or ensure the directory containing the binary is included in the service's `PATH`. |
| `provider_login_missing` | Gateway, status | The provider CLI is installed but no login or API key was found. | Sign in on the machine using the CLI (e.g. `claude login`), provide an API key in `--env-file`, or seal credentials in Switch Console. |
| `provider_login_expired` | Gateway, status | The provider token or session has expired. | Re-authenticate using the provider CLI or refresh the API key in `--env-file`. |
| `provider_version_unsupported` | Gateway, status | The installed provider CLI is older than the minimum version required. | Update the CLI to the latest version. |
| `definition_invalid` | Agent status | The agent configuration cannot be applied on this host. | Verify that the specified working directory exists and is accessible. Under `--separate-users`, verify the path is within `/var/lib/switch-agents/<uid>/agent/workspace`. |
| `crash_loop` | Agent status | The agent crashed repeatedly (4+ times within 10 minutes) and was halted. | Check the agent session logs, resolve the underlying crash or script error, and restart the agent from the Gateway or run `switch-agent-controller status`. |
| `capacity_exceeded` | Gateway, status | All available session slots or user accounts in the pool are in use. | Re-run `install-service --separate-users` with a larger `--agent-users` parameter (up to 99). |
| `controller_revoked` | Controller exit, doctor | The machine was revoked by an administrator on the Machines page. | Re-enroll the machine using a fresh code: `switch-agent-controller enroll --server <url> --code <code>`. |
| `invalid_credential` | Controller exit, doctor | The server does not recognize this machine's credential. | The credential was replaced or deleted. Re-enroll the machine. |
| `protocol_unsupported` | Controller exit | The controller protocol version is unsupported by the Switch server. | Update the controller (`switch-agent-controller update`) or upgrade your Switch server. |
| `taken_over` | Controller exit | Another controller instance connected using the same controller ID. | Ensure only one instance of `switch-agent-controller` runs per machine. |
| `disk_full` | Machine status | The host filesystem has run out of space. | Free up disk space on the volume hosting the controller data directory and workspaces. |

### Diagnostic commands

When investigating issues on an enrolled machine, use the following sequence:

```bash
# 1. Inspect overall machine and provider health
switch-agent-controller doctor

# 2. Check local agent states and active sessions
switch-agent-controller status

# 3. View live controller service logs (Linux)
journalctl --user -u switch-agent-controller -f -n 100

# 4. View service logs (macOS)
tail -f ~/Library/Application\ Support/Switch/agent-controller/controller.log
```

## Next steps

- [Host Switch for your team](self-host.md) — Deploy and administer your own Switch server
- [Onboard a remote host](host-remotely.md) — Manage remote servers via Switch Console over SSH
- [Onboard your agents](../getting-started/onboard-your-agents.md) — Configure agent names, providers, and instructions

