# Switch Agent Controller Guide

_Install, configure, and operate headless Switch agent controllers on your own servers and machines._

The **Switch Agent Controller** (`switch-agent-controller`) is a lightweight, headless daemon that runs Switch agents on your own infrastructure — cloud VMs, on-premises servers, or developer workstations. It connects outbound to your Switch server over a single secure WebSocket, executes assigned coding agents using their respective CLI engines (such as Claude Code, Codex, OpenCode, Cursor, and Antigravity), manages agent processes and workspaces, and reports real-time health and telemetry back to Switch Console and Gateway.

---

## Architecture Overview

```
                      ┌───────────────────────────────────────────────┐
                      │                 Switch Server                 │
                      │  (Gateway, Core API, Management Control Plane) │
                      └──────────────────────▲────────────────────────┘
                                             │ Outbound WebSocket
                                             │ (Heartbeats & Cursors)
┌────────────────────────────────────────────┴────────────────────────┐
│ Machine / Host                                                      │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ switch-agent-controller                                        │  │
│  │                                                               │  │
│  │  - Single Controller WebSocket connection                    │  │
│  │  - Reconciler & Assignment Manager                           │  │
│  │  - In-memory Sealed Secret Store (X25519)                     │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ Local Loopback Relay (127.0.0.1:<port>)                  │  │  │
│  │  │  - Forwards agent requests with temporary tokens        │  │  │
│  │  │  - Exposes Local Hub WebSocket for isolated agents      │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────┬────────────────────────┬───────────┘  │
│                             │                        │              │
│                             ▼                        ▼              │
│               ┌────────────────────────┐  ┌──────────────────────┐  │
│               │ Shared Agents          │  │ Isolated Agents      │  │
│               │ (In-process host,      │  │ (Separate process/   │  │
│               │  spawned session child)│  │  user, Local Hub WS) │  │
│               └────────────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

- **Single outbound connection:** The controller opens a single WebSocket connection to the Switch server. No inbound ports or firewall exceptions are needed on the controller host.
- **Relay-protected credentials:** Switch API tokens never reach agent environments or disk directly. Agents communicate with Switch exclusively through a local loopback relay (`127.0.0.1:<port>`), which injects the controller's short-lived access credentials.
- **Local hub:** Agents marked as isolated or running under separate user accounts communicate event states over the controller's local hub WebSocket.

---

## Requirements

Before installing the agent controller, verify that the host meets the following prerequisites:

| Component | Requirement | Notes |
|---|---|---|
| **Operating System** | Linux (Ubuntu 20.04+, Debian 11+, RHEL 9+), macOS (12+), or Windows 10/11 | Linux and macOS support background service daemons (`install-service`). On Windows, background services are not supported; run interactively (`run`) or manage via Switch Console desktop. |
| **Node.js** | **v22.13.0 or later** | Required for built-in `node:sqlite` database storage. Run `node -v` to check. |
| **Switch Server** | Feature flag enabled: `FEATURE_FLAGS_ENABLED=agent_management` | Behind proxies or ingresses, ensure requests to `/v1` route directly to `switch-core`. |
| **Network** | Outbound HTTPS and WebSocket access to the Switch server | No inbound listening ports are exposed to external networks. |
| **Provider CLIs** | Installed and signed in on `PATH` for the controller user | See [Provider Setup](#provider-sign-in-and-authentication). |

---

## Installation

### Method 1: Automated One-Line Installer (Recommended)

The fastest way to install, enroll, and register the controller as a system service is via the one-line command generated on the Switch Gateway **Machines** page:

> **Note:** Open the **Machines** page in Switch Gateway and copy the generated installation command for your machine. The snippet below illustrates its structure; use the command provided by your own Switch instance.

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code YOUR_ONE_TIME_CODE
```

- When run as a regular user with write access to npm's global prefix, it installs globally via `npm install --global`.
- If global npm permissions are restricted (e.g. system `/usr`), it automatically installs into `~/.local` and configures the systemd user service using the resolved binary path.
- The installer automatically verifies cryptographic release signatures against trusted built-in keys before executing any package code.

### Method 2: Manual Installation via npm

You can also install the package globally using npm (`--ignore-scripts` ensures no arbitrary package lifecycle scripts run during installation):

```bash
npm install --global --ignore-scripts @switch-console/agent-controller
```

Verify the installation:

```bash
switch-agent-controller --version
```

---

## Machine Enrollment

Every machine running an agent controller must be enrolled with your Switch organization.

1. Navigate to **Settings** > **Machines** (or the **Machines** tab) in Switch Console or Gateway.
2. Click **Enroll Machine** to generate a one-time enrollment code. Enrollment codes expire after **10 minutes**.
3. Run the `enroll` command on the target host:

```bash
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code YOUR_ONE_TIME_CODE \
  --name "prod-worker-01" \
  --description "Production worker running on Ubuntu 24.04" \
  --secret-store file
```

### Command Options

- `--server URL` *(Required)*: The base HTTPS URL of your Switch server. Plain `http://` is strictly rejected unless connecting to a loopback address (`127.0.0.1` or `localhost`).
- `--code CODE` *(Required)*: The 10-minute one-time enrollment code from Gateway.
- `--name NAME` *(Optional)*: A human-readable display name for this machine (defaults to the system hostname, max 200 characters).
- `--description TEXT` *(Optional)*: Description explaining the purpose or specs of the machine (max 500 characters). Can be updated later with `set-info` or in Gateway.
- `--data-dir DIRECTORY` *(Optional)*: Custom path for controller state, SQLite database, and workspaces. Defaults to:
  - Linux: `~/.local/share/switch-agent-controller` (or `/var/lib/switch-agent-controller-<uid>` in isolated mode)
  - macOS: `~/Library/Application Support/Switch/agent-controller`
  - Windows: `%LOCALAPPDATA%\Switch\agent-controller`
- `--secret-store KIND` *(Optional)*: Mechanism used to store long-lived credentials:
  - `keychain`: macOS Keychain (default on macOS).
  - `file`: Restrictive file permissions `0600` in the data directory (default on Linux and Windows).
  - `secret-service`: Linux desktop secret service (GNOME Keyring / KWallet). Only use if the keyring is unlocked on login/boot.

### Updating Machine Metadata

You can update the name or description of an enrolled machine at any time without re-enrolling:

```bash
# Update name and description
switch-agent-controller set-info --name "ci-worker-gpu" --description "Dedicated GPU worker for inference"

# Clear description
switch-agent-controller set-info --description ""
```

---

## Running as a Service

Running the controller as a managed background service ensures high availability, automatic startup on system boot, and automatic recovery from transient crashes.

### User Service (Standard)

To install the controller as a service running under your current user account:

```bash
# Install service definition under current user
switch-agent-controller install-service

# Or install with a custom environment file for API keys
switch-agent-controller install-service --env-file /path/to/agents.env

# On Linux, ensure the user service persists across logouts and starts on boot:
sudo loginctl enable-linger $USER
```

- **Linux:** Generates a systemd user unit at `~/.config/systemd/user/switch-agent-controller.service`.
  - Check status: `systemctl --user status switch-agent-controller`
  - View live logs: `journalctl --user -u switch-agent-controller -f`
- **macOS:** Generates a launchd agent at `~/Library/LaunchAgents/com.switch.agent-controller.plist`.
  - Logs are streamed to `controller.log` inside the data directory.
- **Windows:** Background services are not supported (`install-service` is refused on Windows). Run interactively via `switch-agent-controller run` or use the Switch Console desktop app.

To uninstall the service:

```bash
switch-agent-controller uninstall-service
```

---

## Operating and Maintaining the Controller

### Inspecting Local Status (`status`)

Check the controller's identity, connection status, assigned agents, and runtime states without making network calls:

```bash
switch-agent-controller status
```

Example output:
```text
Data directory: /home/ubuntu/.local/share/switch-agent-controller
Controller:     ctrl_01JBCDEFGHJK ("prod-worker-01")
Server:         https://switch.example.com
Enrolled at:    2026-11-06T10:15:30.000Z
Secret store:   File in /home/ubuntu/.local/share/switch-agent-controller/secrets
Relay:          http://127.0.0.1:41923 (where agents were last pointed)
Assignment:     revision 4, 2 agent(s)

  Backend Reviewer (agent_backend_99)
    provider claude, desired running, revision 4, applied 4
    running: pid 18234, session ses_01JBC...

  Documentation Bot (agent_docs_12)
    provider opencode, desired running, revision 2, applied 2
    running: pid 18235, session ses_01JBD...
```

For automation and script parsing, use the `--json` flag:

```bash
switch-agent-controller status --json
```

### Pre-flight Diagnostic Checks (`doctor`)

The `doctor` command validates all prerequisites, network reachability, credential validity, provider CLI sign-ins, and service status:

```bash
# Run all pre-flight diagnostic checks
switch-agent-controller doctor

# Or validate against credentials in an environment file
switch-agent-controller doctor --env-file /path/to/agents.env
```

Example output:
```text
ok    Node           v22.13.0
ok    Platform       linux
ok    Enrollment     Controller ctrl_01JBCDEFGHJK ("prod-worker-01") on https://switch.example.com
ok    Credential     In File in /home/ubuntu/.local/share/switch-agent-controller/secrets
ok    Server         https://switch.example.com accepts this controller
ok    Shared host    /home/ubuntu/.local/lib/node_modules/@switch-console/agent-providers/dist/shared-host-daemon.mjs
ok    claude         Installed 1.0.12, authenticated
ok    codex          Installed 0.8.4, authenticated
warn  opencode       Installed 0.4.1, missing_auth: Run `opencode auth login` or provide OPENCODE_API_KEY
ok    Service        Installed and running
ok    Version        0.1.1, the latest
```

`doctor` exits with status `0` if all checks pass or warn, and `1` if any critical check fails.

### Updating the Controller (`update`)

Switch releases signed updates on GitHub. To check for and apply updates:

```bash
# Check if a newer version is available without installing
switch-agent-controller update --check

# Install the latest verified release and restart the service
switch-agent-controller update
```

The updater downloads the package, validates its cryptographic Ed25519 signature against trusted public keys, installs the bundle, and restarts the running service.

---

## Agent Runtimes: Shared vs. Isolated

Switch supports two execution topologies for assigned agents:

### 1. Shared Agents (Default)

- Runs the agent host inside the controller's main daemon process.
- Sessions are spawned as child processes using the shared-host daemon bundle.
- Best suited for trusted environments, single-purpose servers, or developers running agents on their primary workstation.
- Default workspace location: `<data-dir>/workspaces/<agent-id>`.

### 2. Isolated Agents (`isolation: "isolated"`)

- Configured per-agent in the agent definition.
- Spawns the agent host in a dedicated, independent process (`--ensure-watch`).
- Connects to the controller's local hub WebSocket (`ws://127.0.0.1:PORT/hub`).
- **Survives controller restarts:** Because each isolated agent runs as an independent OS process, it is not terminated when the controller process exits. The isolated host process keeps retrying connection to the local hub and reconnects automatically once the controller restarts. If the controller was updated to a newer package version, it flags the running isolated agent as outdated and restarts it once the agent becomes idle (turning off the host, waiting for completion, and relaunching from the new bundle).

### 3. Multi-User Linux Sandboxing (`--separate-users`)

For multi-tenant machines, enterprise security compliance, and untrusted execution, Switch provides root-level system sandboxing where **every agent runs as a distinct Linux system user**:

```bash
# Set up enterprise user isolation with defaults (pool of 16 users)
sudo switch-agent-controller install-service --separate-users

# Or configure with a custom user, pool size (up to 99), and environment file:
sudo switch-agent-controller install-service --separate-users \
  --user ubuntu \
  --agent-users 32 \
  --env-file /etc/switch/agents.env
```

#### What `--separate-users` Does:
1. **Dedicated User Pool:** Provisions dedicated system users (`sa<uid>-01` through `sa<uid>-16`, belonging to group `switch-agents-<uid>`). The pool size defaults to 16 and can be configured up to a maximum of 99 users.
2. **Systemd Unit Template:** Installs template units `switch-agent-<uid>@.service` to manage agent lifetimes individually.
3. **Polkit Authorization:** Installs fine-grained Polkit rules allowing the non-root controller user to start, stop, and restart only its designated agent units without sudo.
4. **Filesystem Isolation:** Each agent is jailed inside `/var/lib/switch-agents/<uid>/agent`, with isolated subdirectories for `home/` and `workspace/`. Agents cannot access:
   - Host user directories (`/home`, `/root`, `/run/user`)
   - The controller's internal data directory or SQLite database
   - Peer agent processes or workspaces
   - Cloud instance metadata endpoints (`169.254.169.254`)

To uninstall user sandboxing:

```bash
sudo switch-agent-controller uninstall-service --separate-users
```

---

## Provider Sign-in and Authentication

Agents execute coding tasks using installed AI provider CLIs. The controller supports three authentication methods:

### Method 1: Local CLI Login

Sign in interactively on the controller host as the user running the controller:

```bash
# Claude Code
claude login

# OpenAI Codex
codex login

# OpenCode
opencode auth login
```

Ensure the CLI binary is located in standard system directories (`/usr/bin`, `/usr/local/bin`) or the user's `~/.local/bin`, and verify with `switch-agent-controller doctor`.

### Method 2: Environment File (`--env-file`)

Pass API keys and enterprise cloud configurations via an environment file (e.g. `/etc/switch/agents.env` or `~/.config/switch/agents.env`):

```bash
# Direct API Keys
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
OPENCODE_API_KEY=...

# Claude Code on Google Cloud Vertex AI
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project
CLOUD_ML_REGION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=/etc/switch/gcp-service-account.json

# Amazon Bedrock Configuration
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-east-1
```

Apply the environment file when starting the service:

```bash
switch-agent-controller install-service --env-file /etc/switch/agents.env
```

### Method 3: Remote Sealed Logins (Console Push)

For headless cloud VMs with no interactive shell access, machine owners can remotely push encrypted provider credentials from Switch Console:

1. During `enroll`, the controller generates an X25519 keypair and registers the public key with Switch.
2. In Switch Console, open the machine's page and select **Push Provider Login**.
3. Console encrypts the API token or Vertex service account key directly to the machine's public key.
4. The controller receives the ciphertext, decrypts it in memory using its local private key, and injects it into agent processes.
5. Sealed credentials exist **only in memory** and are never written to disk or logged.

---

## Troubleshooting and Reason Codes

### Common Reason Codes

When an agent fails to start or reconcile, the controller assigns it a specific `ReasonCode`. These codes appear in `switch-agent-controller status` (under failed agent assignments), in `switch-agent-controller doctor` (when diagnosing provider authentication or installation states), and in the Switch Gateway dashboard:

| Reason Code | Meaning | Remediation |
|---|---|---|
| `provider_not_installed` | The requested provider binary was not found on `PATH`. | Install the CLI binary (e.g. `npm install -g @anthropic-ai/claude-code`) and verify `which claude` (or the respective provider binary). |
| `provider_login_missing` | The CLI binary is present but lacks authentication. | Run the CLI login command interactively or configure API keys in `--env-file`. |
| `provider_login_expired` | The provider token has expired or was revoked. | Re-run login or push a renewed sealed login from Switch Console. |
| `provider_version_unsupported` | Installed CLI version does not meet minimum protocol standards. | Update the provider CLI to the latest version. |
| `controller_revoked` | The machine was revoked or removed in Switch Gateway. | Re-enroll the host: remove old state in data directory and run `switch-agent-controller enroll` with a new code. |
| `invalid_credential` | The controller's stored access token was rejected by Switch. | Verify the Switch server URL; re-enroll the machine if the credential was rotated. |
| `crash_loop` | The agent process crashed 4 times in 10 minutes. | Check agent crash logs in `data-dir/agents/{agentId}/` or `journalctl`; verify workspace permissions. |
| `capacity_exceeded` | All sandbox user slots are currently claimed (`--separate-users`). | The user pool defaults to 16 (max 99). To expand capacity, reinstall with a larger pool: `sudo switch-agent-controller install-service --separate-users --agent-users 32`. |
| `definition_invalid` | Agent configuration has invalid parameters or references invalid paths. | Check the agent definition in Switch Console / Gateway. |
| `protocol_unsupported` | The controller is too old for the Switch server protocol. | Update the controller binary: `switch-agent-controller update`. |
| `taken_over` | A new controller instance opened the stream using the same ID. | Ensure only one controller instance is active per enrolled identity. |
| `disk_full` / `out_of_memory` | Host system resource exhaustion. | Free disk space or increase VM memory allocation. |

---

### Controller Exit Codes Reference

If the controller stops, it exits with one of the following documented exit codes:

| Exit Code | Constant | Meaning | Supervisor Action |
|---|---|---|---|
| `0` | `EXIT_OK` | Clean shutdown via `SIGINT`, `SIGTERM`, or command complete. | Do not restart. |
| `1` | `EXIT_FAILURE` | Transient error (network failure, temporary server drop). | **Restart** with exponential backoff. |
| `2` | `EXIT_CONFIGURATION` | Invalid argument, missing config, unreadable file, or invalid URL. | Do not restart until configuration is corrected. |
| `3` | `EXIT_REVOKED` | Controller was revoked by the Switch server. | Do not restart; requires re-enrollment. |
| `4` | `EXIT_TAKEN_OVER` | Another instance connected with this identity. | Do not restart; prevent duplicate processes. |
| `5` | `EXIT_UPGRADE_REQUIRED`| Server requires a newer protocol version. | Do not restart; update controller package. |
| `6` | `EXIT_CREDENTIAL_INVALID`| Credential rejected or missing from server database. | Do not restart; re-enroll machine. |
| `7` | `EXIT_RESTARTING` | Controller successfully installed an update. | **Restart immediately** into the new release. |

When configuring a custom supervisor (such as systemd system units or Docker entrypoints), configure restart behavior matching these codes:

```ini
# Recommended systemd service configuration
Restart=on-failure
RestartPreventExitStatus=2 3 4 5 6
```
