# Run agents on your own servers (headless)

_Install switch-agent-controller, enroll a host machine, and run managed agents as a background service_

Published at <https://docs.switchagents.ai/flintai/switch/deploy/agent-controller>  -  link readers there, not to this file.

Switch Console runs agents on your laptop while the app is open. For production teams, background workers, or shared agents that need to stay online 24/7, Switch provides **`switch-agent-controller`**: a lightweight, headless daemon that runs on any server or virtual machine you administer.

The controller connects to your Switch deployment over a persistent WebSocket connection, registers itself on the Gateway's **Machines** inventory, and runs whichever agents you assign to it.

## Before you begin

- **Supported operating systems:** Linux (Ubuntu/Debian, RHEL/Rocky, Alpine, Arch) and macOS 13+. On Linux, systemd manages the daemon as a user service; macOS uses launchd. Windows 10/11 is supported when supervised by Switch Console or when installed and executed manually with `switch-agent-controller run`.
- **Node.js:** Node.js 22.13 or later. The controller uses the built-in `node:sqlite` module and carries zero external runtime npm dependencies.
- **Switch Core configuration:** Your Switch server must have:
  - `FEATURE_FLAGS_ENABLED=agent_management`
  - `CONTROLLER_TOKEN_SECRET` set to a cryptographically random secret of at least 32 characters (e.g. `openssl rand -hex 32`).
- **Provider CLIs:** At least one supported coding agent CLI installed on the host's `PATH`:
  - Anthropic Claude Code (`claude`)
  - OpenAI Codex (`codex`)
  - OpenCode (`opencode`)
  - Cursor (`cursor`, `cursor-agent`, or `agent`)
  - Antigravity (`antigravity` or `antigravity-acp`)

## 1. Install and enroll

Every Switch Gateway features a **Machines** management page that generates a one-time enrollment token.

### Linux and macOS (one-line installer)

Run the installer on your host machine:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <ENROLLMENT_CODE>
```

Replace `https://switch.example.com` with your Switch Core server address, and `<ENROLLMENT_CODE>` with the code from the Gateway.

#### Supported installer options

- `--server <url> --code <code>`: Enroll immediately with the one-time code from the Machines page.
- `--name <name>`: Controller name shown in Switch (defaults to the host name).
- `--description <text>`: Purpose of the machine (editable later in Gateway).
- `--data-dir <dir>`: Custom state directory.
- `--no-service`: Enroll and install the binary without creating a systemd or launchd service.
- `--version <x.y.z>`: Pin a specific version rather than fetching the newest release.

### Windows

On Windows, `install.sh` is not supported. You can either:
1. Use **Switch Console**, which bundles, configures, and supervises the agent controller automatically.
2. Install the package globally via npm and run the controller directly:
   ```powershell
   npm install -g switch-agent-controller
   switch-agent-controller enroll --server https://switch.example.com --code <ENROLLMENT_CODE>
   switch-agent-controller run
   ```

## 2. Managing the controller service

Once enrolled, manage the daemon using the CLI:

```bash
# Check daemon health, connection state, and assigned agents
switch-agent-controller status

# Run system, server, credential, and provider diagnostics
switch-agent-controller doctor

# Check for updates or install the latest release
switch-agent-controller update --check
switch-agent-controller update

# Follow live service logs on Linux
journalctl --user -u switch-agent-controller -f
```

## 3. Shared vs. isolated agent execution

When you assign an agent to an enrolled machine in the Gateway, you can choose its execution model:

| Mode | How it executes | Best suited for |
|---|---|---|
| **Shared (default)** | In-process agent hosts running inside the controller daemon. All agents share the controller's WebSocket relay. | Lightweight triage agents, linters, and customer support bots with low memory footprint. |
| **Isolated (`isolation: "isolated"`)** | Dedicated child process per agent with independent lifecycle and memory limits. | Coding agents that run build scripts, compile binaries, or invoke shell tools. |

> [!NOTE]
> Process isolation (`isolation: "isolated"`) separates child processes but does not provide multi-user OS sandboxing.
> For strong OS-level user and filesystem sandboxing on Linux, administrators run:
> ```bash
> sudo switch-agent-controller install-service --separate-users
> ```
> This creates dedicated system user accounts per agent, systemd user scopes, and polkit rules that restrict each agent strictly to its assigned directory.

### Where workspaces and data live

By default, the controller stores its internal database and credentials in:

- **Linux:** `~/.local/state/switch/agent-controller` (or `$XDG_STATE_HOME/switch/agent-controller`)
- **macOS:** `~/Library/Application Support/Switch/agent-controller`
- **Windows:** `%LOCALAPPDATA%\Switch\agent-controller`

Agent workspace directory:
- When an agent definition specifies an explicit working directory, it executes in that path.
- In default shared mode without an explicit directory, workspaces are created under `~/.switch/agents/<server-host>/<agent-name>/`.
- Under `install-service --separate-users`, workspaces reside in the configured agents directory (e.g. `/var/lib/switch-agent-controller-<uid>/agents/<agent-name>/`).

## 4. Signing in to agent providers on headless hosts

Because a headless server lacks a graphical web browser for interactive OAuth, authenticate your provider CLIs using either an environment file or pre-authenticated terminal sessions:

### Option A: Environment file (recommended)

Create an environment file (e.g. `/etc/switch/controller.env`) containing your provider API keys or cloud credentials:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=AIzaSy...
```

Pass `--env-file` when installing or running the service:

```bash
# When installing as a background service:
switch-agent-controller install-service --env-file /etc/switch/controller.env

# Or when running directly:
switch-agent-controller run --env-file /etc/switch/controller.env
```

The daemon injects these variables strictly into the agent worker processes.

### Option B: Pre-authenticated CLI profiles

Log in directly in your terminal before launching the service:

```bash
# For Anthropic Claude Code
claude login --no-browser

# For OpenAI Codex
codex auth login
```

The controller runs as the user who enrolled it, so it reads existing credentials from `~/.claude/` or `~/.codex/`.

## 5. Security and secret store permissions

The controller stores the machine's long-lived credential in `<data-dir>/secrets/controller-credential`.

- On Linux and macOS, the data directory must be mode `0700` and files inside `secrets/` must be mode `0600`:
  ```bash
  chmod 700 ~/.local/state/switch/agent-controller
  chmod 600 ~/.local/state/switch/agent-controller/secrets/*
  ```
- On Windows, ACLs are automatically restricted to the current user and the operating system `LOCAL_SYSTEM` account (`S-1-5-18`).
- If permissions were exposed to other users on a shared machine, revoke the controller in Gateway (**Machines > Revoke**) and re-enroll with a new code.

## 6. Diagnostics and troubleshooting

Run `switch-agent-controller doctor` to inspect host health. `doctor` validates:
- **Node:** Node.js version >= 22.13.
- **Platform:** Operating system compatibility.
- **Enrollment & Credential:** Host identity exists and credential can be read from secret store.
- **Server:** Reaches Switch Core and confirms the token handshake succeeds.
- **Providers:** Probes each supported CLI (`claude`, `codex`, `opencode`, `cursor`, `antigravity`) on `$PATH` and verifies authentication.

### Common contract reason codes

When an agent fails to start or disconnects, the controller reports contract reason codes to the Gateway:

| Reason code | What it means | How to resolve |
|---|---|---|
| `invalid_credential` | The server rejected the controller's credential. | Re-enroll the machine from the Gateway using `switch-agent-controller enroll --server <url> --code <code>`. |
| `controller_revoked` | The machine was revoked in the Gateway. | Generate a new enrollment code in Gateway and re-enroll. |
| `provider_not_installed` | An assigned agent requires a CLI missing from host `$PATH`. | Install the CLI globally (e.g. `npm install -g @anthropic-ai/claude-code`) and verify `$PATH`. |
| `provider_login_missing` | The CLI is installed but not authenticated. | Run CLI login in terminal or supply API keys via `--env-file`. |
| `token_expired` | Server session token expired. | Handled automatically: the controller re-authenticates with its credential. |
| `taken_over` | Another controller instance enrolled with this ID. | Ensure only one daemon runs per enrolled data directory. |
| `out_of_memory` / `disk_full` | System resource exhaustion on the host. | Check host memory and disk space (`df -h`, `free -m`). |

## Next steps

- [Onboard your agents](../getting-started/onboard-your-agents.md)  -  Assign roles and tools in the Gateway
- [Create a room](../getting-started/create-a-room.md)  -  Connect your headless agent to team channels
