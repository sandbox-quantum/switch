# Run the headless agent controller

_Install the controller, enroll your machine, run managed agents, and keep them healthy_

Published at <https://docs.switchagents.ai/flintai/switch/deploy/agent-controller> — link readers there, not to this file.

The Switch agent controller (`switch-agent-controller`) runs the Switch agents that management assigns to a machine and reports their status. It is a headless daemon designed to run on servers, dedicated virtual machines, or office build boxes that stay online around the clock, so your team's agents answer even when nobody has Switch Console open.

Each machine runs one controller. The controller holds a single WebSocket connection to your Switch server on behalf of all its agents, starts agent sessions when people message them, and restarts them if they fail.

## Requirements

Before installing the controller, confirm your machine meets these requirements:

- **Operating system:** Linux (Ubuntu 22.04 or 24.04 recommended, Debian, Fedora) or macOS. On Windows 10 or 11, the controller runs natively as an internal engine managed by Switch Console; background service installation (`install-service`) is supported on Linux and macOS.
- **Node.js:** Node 22.13 or later. The controller uses the built-in `node:sqlite` database for its local state store.
- **Tools:** `curl` and `npm` (which comes bundled with Node.js).
- **Provider CLIs:** The command-line interface for each provider your agents use (`claude`, `codex`, `opencode`, `agent` or `cursor-agent`, `antigravity-acp`) must be installed on `PATH` and signed in for the user running the controller, or configured with API keys in an environment file.
- **Switch server:** A running Switch server with the `agent_management` feature flag enabled (`FEATURE_FLAGS_ENABLED=agent_management`) and a configured `CONTROLLER_TOKEN_SECRET` (at least 32 characters). Behind a reverse proxy or ingress, the `/v1` path must route to `switch-core`.

## Install and enroll

Switch provides a one-line installer that downloads the controller package from GitHub releases, installs it with npm, enrolls the machine with your Switch server, and registers it as a system service.

### Get an enrollment code from the Gateway

1. Open the Switch Gateway in your browser and sign in.
2. Select **Machines** in the navigation rail.
3. Select **Add a machine**.
4. Optionally enter a **Name** (defaults to the host name if left blank) and a **Description** (such as "Production worker in us-east").
5. The dialog issues a single-use enrollment code valid for 10 minutes and displays the complete installation command.

### Run the one-line installer

Copy the command from the dialog and run it in a shell on your target machine:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code> [--name <name>] [--description "<text>"]
```

Replace `https://switch.example.com` with your Switch server's API URL and `<code>` with your enrollment code.

**What the installer does:**

- Checks for a supported operating system and Node 22.13+.
- Installs the newest `switch-agent-controller` package globally with `npm install --global`. If npm's global prefix is not writable by your user (such as a system Node in `/usr`), it installs into `~/.local` instead.
- Enrolls the machine with Switch, generating a long-lived credential and a local X25519 keypair for sealed logins.
- Registers and starts the controller as a user service (`systemd` user unit on Linux, `launchd` agent on macOS).

### Manual installation and enrollment

If you prefer to install and enroll in separate steps, or already have the package installed:

```bash
# 1. Install the controller globally
npm install --global https://github.com/sandbox-quantum/switch/releases/download/switch-agent-controller-v0.1.1/switch-agent-controller-0.1.1.tgz

# 2. Enroll the machine
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <code> \
  --name build-box \
  --description "Team build box"

# 3. Install and start as a service
switch-agent-controller install-service
```

### Where data lives

The controller creates a private data directory with `0700` permissions:

- **Linux:** `~/.local/state/switch/agent-controller` (or `$XDG_STATE_HOME/switch/agent-controller`)
- **macOS:** `~/Library/Application Support/Switch/agent-controller`
- **Custom path:** Pass `--data-dir <path>` or set `SWITCH_CONTROLLER_DATA_DIR`

The data directory contains:

- `controller.db`: SQLite database caching the machine's identity, agent assignments, cursors, and status.
- `secrets/`: Holds the controller credential with the `file` store. On macOS, credentials default to the login keychain (`keychain`).
- `agents/<id>/credentials.json`: Relay tokens and loopback hub addresses generated for each running agent.
- `releases/`: Versioned releases downloaded during automatic updates.

To change the machine's display name or description after enrollment without re-enrolling, run:

```bash
switch-agent-controller set-info --name "new-name" --description "New description"
```

## Run as a service

Running the controller as a background service ensures it starts when the machine boots and recovers automatically from unexpected errors.

```bash
switch-agent-controller install-service [--env-file <path>] [--data-dir <dir>]
```

`install-service` inspects your operating system and configures the appropriate service manager:

- **Linux:** Installs a systemd user service at `~/.config/systemd/user/switch-agent-controller.service`.
- **macOS:** Installs a launchd agent at `~/Library/LaunchAgents/com.switch.agent-controller.plist`.

The service captures the `PATH` of the shell that installed it, ensuring provider CLIs in custom paths (such as `~/.local/bin` or `/opt/homebrew/bin`) remain accessible.

**Important on Linux:**

By default, systemd terminates user services when you log out of an SSH session. To keep the controller running after logout and ensure it starts at system boot, enable user lingering:

```bash
sudo loginctl enable-linger <username>
```

Replace `<username>` with the Linux user account running the controller.

### Managing the service

```bash
# Check service logs on Linux
journalctl --user -u switch-agent-controller -f

# Check service logs on macOS
tail -f ~/Library/Application\ Support/Switch/agent-controller/controller.log

# Stop and remove the service (keeps enrollment and local state)
switch-agent-controller uninstall-service
```

### Isolated agent users on Linux

For shared servers where agents should not read each other's files or the controller's credentials, Linux hosts can run agents under separate system users:

```bash
sudo switch-agent-controller install-service --separate-users [--agent-users 16]
```

This allocates a dedicated pool of unprivileged system users (`sa<uid>-01` through `sa<uid>-16`), runs each agent in an isolated systemd unit (`switch-agent-<uid>@<id>.service`), and restricts each agent's file visibility strictly to `/var/lib/switch-agents/<uid>/agent`.

## Check health and status

Two commands help you inspect and diagnose the controller: `status` and `doctor`.

### Check current status

Run `status` to inspect the machine's local state and assigned agents:

```bash
switch-agent-controller status
```

`status` reads only local disk state (`controller.db` and agent health files). It makes no network calls, answering immediately even when offline. The output shows:

- Controller ID and enrollment status.
- Connected server URL and socket state.
- Assigned agents, their current process state (`running`, `stopped`, `failed`), and active session count.
- Recent process exit codes and error reasons.

### Diagnose issues with doctor

Run `doctor` to run an end-to-end audit of what the machine needs to run agents:

```bash
switch-agent-controller doctor [--env-file <path>]
```

`doctor` checks and reports:

1. **Node.js version:** Confirms Node 22.13 or later is active.
2. **Platform:** Confirms a supported operating system and architecture.
3. **Enrollment and credentials:** Validates that local credentials exist and are readable.
4. **Server connectivity:** Performs a live token exchange with your Switch server to verify the network path and confirms `/v1` routes reach `switch-core`.
5. **Shared-host bundle:** Ensures the internal agent runtime bundle is intact.
6. **Provider CLIs:** Searches `PATH` for each provider binary (`claude`, `codex`, `opencode`, `agent`) and tests their version.
7. **Provider sign-in:** Probes each installed provider to verify active authentication.
8. **Service state:** Confirms whether the background service is installed and running.
9. **Release updates:** Checks whether a newer controller release is available.

`doctor` exits with code `0` if all checks pass, and code `1` if any check fails, displaying specific guidance on how to fix each problem.

## Keep it updated

The controller supports both automatic updates managed by your Switch server and manual CLI updates.

### Automatic updates from Switch

When your server deployment specifies a controller release (via `CONTROLLER_RELEASE_VERSION`, `CONTROLLER_RELEASE_URL`, and `CONTROLLER_RELEASE_SHA256`), the controller automatically manages the update lifecycle:

1. **Waiting for idle:** The controller monitors its agents and waits until no session is in the middle of a turn.
2. **Verification:** Downloads the new package into `<data-dir>/updates/` and validates its SHA-256 hash against the server's signed value.
3. **Atomic switch:** Installs the package into `<data-dir>/releases/<version>` and updates the `current` symlink.
4. **Graceful restart:** Exits with code `7`. The service manager (`systemd` or `launchd`) immediately restarts the process into the new release.

### Manual updates

To update the controller manually:

```bash
# Check if an update is available without installing
switch-agent-controller update --check

# Install the latest release and restart the service
switch-agent-controller update
```

## Shared vs isolated agents

When you assign an agent to a controller in the Gateway or through the API, its definition specifies an `isolation` setting:

| Isolation | Runtime architecture | Behavior during controller updates | Best for |
| :-- | :-- | :-- | :-- |
| **`shared`** (default) | Runs in-process inside the controller daemon. | Stops when the controller stops; resumes when the controller starts. | Standard workloads, minimal memory footprint. |
| **`isolated`** | Runs as a separate process communicating via a local loopback WebSocket hub. | Keeps running independently during controller restarts and updates. | Long-running tasks, mission-critical agents. |

### Where workspaces live

Every agent needs a working directory where it reads project files, writes code, and stores local configuration:

- **Explicit working directory:** If the agent definition specifies a directory, the agent works there. The folder must exist on the machine before the agent starts.
- **Default working directory:** If no directory is named in the definition, Switch creates a dedicated folder under:
  ```text
  ~/.switch/agents/<server-host>/<agent-name>/
  ```
  For example: `~/.switch/agents/switch.example.com/tech-writer/`. The controller automatically creates missing directories under this folder on first launch.
- **Separate-users mode:** Under `--separate-users`, every agent's working directory is isolated at `/var/lib/switch-agents/<uid>/agent/workspace`.

## Provider sign-in on the machine

Agents run the provider's CLI directly on the host. The controller does not bypass authentication; each provider must have valid credentials on the machine.

You can authenticate providers in three ways:

### 1. Interactive sign-in

On a machine with a desktop browser or terminal session, sign in directly under the user account that runs the controller:

```bash
# Claude Code
claude login

# OpenAI Codex
codex login
```

Credentials are saved in the user's home directory (such as `~/.claude/` or `~/.codex/`) where the controller's sessions find them.

### 2. Environment file (--env-file)

For headless servers and cloud instances, pass an environment file containing API keys or tokens. Create a protected file (for example, `~/.switch/agents.env` with `chmod 600`):

```bash
# Anthropic API key
ANTHROPIC_API_KEY=sk-ant-api03-...

# Or Claude Code OAuth token (from `claude setup-token`)
# CLAUDE_CODE_OAUTH_TOKEN=...

# OpenAI API key for Codex
OPENAI_API_KEY=sk-...

# Google Cloud / Vertex AI for Claude Code
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project
CLOUD_ML_REGION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=/etc/switch/gcp-key.json
```

Pass the file when installing the service:

```bash
switch-agent-controller install-service --env-file ~/.switch/agents.env
```

**Note:** The environment file is read when the service starts. Restart the service whenever you edit the file:

```bash
# Linux
systemctl --user restart switch-agent-controller

# macOS
launchctl kickstart -k gui/$(id -u)/com.switch.agent-controller
```

### 3. Sealed provider logins from Switch Console

If you use Switch Console, you can push credentials to an enrolled machine securely without manually copying secrets:

1. When the controller enrolls, it generates an X25519 public key and sends it to Switch.
2. In Switch Console, navigate to the machine and select **Give provider login**.
3. Console seals (encrypts) the credentials to the machine's public key before sending them to Switch.
4. The controller receives the ciphertext, decrypts it in memory, and validates the login. Secrets are held in memory only and never written to disk.

## Troubleshooting

When a controller or agent cannot start, Switch reports a specific reason code in the Gateway's **Machines** and **Agents** pages, in `switch-agent-controller status`, and in `switch-agent-controller doctor`.

### Common reason codes

| Reason code | Where it appears | What it means | How to fix |
| :-- | :-- | :-- | :-- |
| **`controller_offline`** | Gateway, placement | Switch cannot reach the controller's WebSocket stream. | Check that the service is running (`switch-agent-controller status`). On Linux, verify lingering is enabled (`sudo loginctl enable-linger`). Confirm network firewalls allow outbound HTTPS/WSS to your Switch server. |
| **`provider_not_installed`** | Gateway, `doctor` | The required CLI (`claude`, `codex`, `opencode`, `agent`) was not found on `PATH`. | Install the provider CLI. Make sure it is installed globally or in a directory present in the service's `PATH`. Run `switch-agent-controller doctor` to confirm. |
| **`provider_login_missing`** / **`provider_login_expired`** | Gateway, `doctor` | The provider CLI is installed but not authenticated, or its credentials expired. | Sign in interactively (`claude login`, `codex login`), supply an API key in the `--env-file`, or grant a sealed login from Switch Console. |
| **`invalid_credential`** / **`controller_revoked`** | Controller logs, exit code `3` or `6` | The controller's credential was deleted or revoked in Switch. | Re-enroll the machine. Generate a new enrollment code in the Gateway, then run `switch-agent-controller enroll --server <url> --code <code>`. |
| **`protocol_unsupported`** | Controller logs, exit code `5` | The controller and server speak incompatible protocol versions. | Update the controller to match the server version: `switch-agent-controller update`. |
| **`definition_invalid`** | Agent status | An agent definition parameter (such as a working directory or advanced configuration) is invalid or unsupported. | In the Gateway, edit the agent definition. If a custom working directory was specified, verify that the directory exists on the machine and is readable by the controller. |
| **`capacity_exceeded`** / **`disk_full`** | Machine status | The machine has run out of disk space, or all user accounts in the `--separate-users` pool are occupied. | Free disk space on the host, or increase the agent user pool: `sudo switch-agent-controller install-service --separate-users --agent-users 32`. |
| **`taken_over`** | Controller logs, exit code `4` | Another controller instance connected using the same machine identity. | Ensure only one controller process runs per machine and per data directory. Stop redundant processes. |

### Process exit codes

When running under a process supervisor or investigating unexpected terminations, refer to these exit codes:

| Code | Meaning | Supervisor action |
| :-- | :-- | :-- |
| **`0`** | Clean exit (terminated by SIGINT/SIGTERM, or command finished). | Do not restart. |
| **`1`** | Transient error (network failure, temporary server outage, unexpected crash). | Restart with exponential backoff. |
| **`2`** | Configuration error (invalid arguments, invalid URL, unreadable bundle). | Do not restart; fix the configuration first. |
| **`3`** | Machine revoked by Switch server. | Do not restart; re-enroll the machine. |
| **`4`** | Connection taken over by another instance with the same identity. | Do not restart. |
| **`5`** | Protocol unsupported by Switch server. | Do not restart; update the controller. |
| **`6`** | Invalid credential (replaced or deleted on server). | Do not restart; re-enroll the machine. |
| **`7`** | New controller release installed and ready. | Restart immediately into the new release. |

## Next steps

- [Choose how to run Switch](index.md) — Review hosting options for your server and agents
- [Host Switch for your team](self-host.md) — Deploy your own Switch server with Docker Compose or Kubernetes
- [Troubleshooting](../resources/troubleshooting.md) — General troubleshooting for Switch rooms and messaging apps
