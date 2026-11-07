# Run agents on a headless machine

Use the Switch agent controller when you want agents to run on a server or workstation without keeping Switch Console open. The controller enrolls one machine with Switch, starts the agents assigned to it, and reports their health. It is separate from the Switch server: it runs where the agent CLIs and their credentials are available.

## Before you start

- A Linux, macOS or Windows 10/11 machine. Linux and macOS can install the controller as a service; Windows is normally managed by Switch Console or a process supervisor.
- Node.js 22.13 or later (`node --version`). The controller uses Node's built-in SQLite support.
- Network access from the machine to your Switch server. The agent bridge URL must use HTTPS, except for a loopback development server.
- At least one supported provider CLI installed and signed in as the account that will run the controller. Supported CLIs include Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), Cursor (`agent` or `cursor-agent`) and Antigravity (`agy`, where supported). Alternatively, configure the provider's API key in the controller environment file.
- The Switch server must have agent management enabled (`FEATURE_FLAGS_ENABLED=agent_management`). If a reverse proxy sits in front of Switch, it must route `/v1` to `switch-core`.

## Install and enroll

Open the **Machines** page in the Switch Gateway and create a one-time enrollment code. The code expires after ten minutes. Use the install command shown there, replacing the server URL and code with the values from your own Gateway:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code YOUR_ONE_TIME_CODE
```

The installer downloads the signed controller release, installs it, enrolls the machine and installs/starts the user service where supported. Keep the enrollment code private; do not commit it or paste it into an issue.

If you prefer to install and enroll separately:

```bash
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code YOUR_ONE_TIME_CODE \
  --name build-box \
  --description "CI and development agents"

switch-agent-controller install-service
```

The machine name defaults to its hostname. The description is optional and can be changed later from the Gateway. `--data-dir PATH` can be supplied to commands when you need a non-default state directory. The installer falls back to `~/.local` when the npm global prefix is not writable; make sure `~/.local/bin` is on your interactive PATH if you want to invoke the CLI directly.

## Run and inspect the machine

On Linux, `install-service` creates a systemd user service. On macOS it creates a launchd agent. Both start the controller at login; Linux can also start it at boot when user lingering is enabled:

```bash
sudo loginctl enable-linger "$USER"  # Linux, when boot-time start is required
switch-agent-controller status
switch-agent-controller doctor
```

`status` reads local state and does not contact the server. `doctor` checks the Node version, platform, enrollment and credential, server connectivity, shared-host bundle, provider installation/sign-in, service state and available controller release. Use its suggested fixes to resolve warnings and failures.

To run the controller in the foreground instead of installing a service:

```bash
switch-agent-controller run
```

To stop and remove the service without deleting the enrollment, run:

```bash
switch-agent-controller uninstall-service
```

To check for and install a newer signed release:

```bash
switch-agent-controller update --check
switch-agent-controller update
```

The `--check` option reports whether a newer release is available without installing it. The controller verifies release signatures before installing updates.

## Provider sign-in

Provider CLIs must be installed and authenticated for the same operating-system user that runs the controller service. A login performed in another user's shell, desktop session or home directory is not automatically available to the controller.

For a provider that uses an API key or a cloud-specific environment, place only the required provider variables in a private environment file and pass it to both service installation and foreground runs:

```bash
switch-agent-controller install-service --env-file /etc/switch/agents.env
switch-agent-controller run --env-file /etc/switch/agents.env
```

Example for Claude Code using Vertex AI:

```dotenv
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

Protect the file so only the controller account (and administrators who need it) can read it. Do not put the Switch controller credential or unrelated secrets in the file. Restart the service after changing provider environment variables; the file is read at startup.

## Shared and isolated agents

The controller normally runs an agent host in its own process and manages its sessions. An agent configured with `isolation: "isolated"` runs in a separate agent-host process. This keeps that agent's lifecycle independent from the controller process and lets it reconnect when the controller returns. Changing an agent's isolation restarts it using the new mode.

On Linux, administrators can optionally configure `install-service --separate-users` so each agent runs as its own system user. This is a stronger filesystem boundary: each agent sees its own workspace rather than the controller user's files and other agents' workspaces. It requires systemd and polkit and must be configured by an administrator; follow the controller package's separate-user setup instructions before enabling it.

Agent workspaces are kept under the controller's workspace directory. The Gateway reports the machine's workspace directory to Switch; each agent's working directory is resolved beneath it. Keep sufficient disk space available and back up project workspaces independently of the controller's SQLite state.

## Troubleshooting

| Symptom or reason | What it means | What to do |
|---|---|---|
| `provider_not_installed` | No supported CLI for the assigned provider was found on the controller user's PATH. | Install the provider CLI for that user, then run `doctor` again. |
| `provider_login_missing` | The CLI is installed but is not authenticated for the controller user. | Sign in as that user, or configure the provider API key in the service's `--env-file`. |
| `provider_login_expired` | A provider login supplied by Switch could not be used. | Sign in locally or ask the owner to provide a fresh provider login, then retry. |
| `invalid_credential` | The server no longer recognizes the controller credential. | Re-enroll the machine from a fresh one-time code. |
| `protocol_unsupported` | The server and controller speak different controller protocols. | Update the controller with `switch-agent-controller update`. |
| `taken_over` | Another controller instance with the same identity connected and took over this stream. | Stop the duplicate instance; run only one controller per machine identity. |
| `doctor` reports the server is not the Switch API | A proxy returned a page or a different service instead of the agent bridge API. | Route `/v1` to `switch-core`, not the Gateway frontend. |
| Service is stopped | The service is installed but not running. | On Linux inspect `systemctl --user status switch-agent-controller`; on macOS inspect the launchd agent and its log in the controller data directory. |

For Linux service logs:

```bash
journalctl --user -u switch-agent-controller -f
```

For a focused diagnosis, run `switch-agent-controller doctor` and include its output (after removing hostnames, server addresses and any other private details) when asking for help. Never share enrollment codes, controller credentials, API keys or the contents of the environment file.

## Further reference

The package README contains the complete command reference, data-directory layout, exit codes and separate-user setup: [agent controller README](https://github.com/sandbox-quantum/switch/blob/main/console/packages/agent-controller/README.md).
