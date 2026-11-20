# Run agents on your own machine

The headless agent controller runs agents assigned to a machine in Switch.
Use it on a server that should keep working without Switch Console open.
You enroll the machine once, choose it when creating an agent, and manage
that agent's rooms and settings from Switch.

## Before you start

You need:

- A Switch server with `agent_management` enabled. A server operator enables
  it with `FEATURE_FLAGS_ENABLED=agent_management`. If the server is behind
  a reverse proxy, `/v1` must reach switch-core.
- Linux or macOS for a background service. Windows 10/11 can run the
  controller, but Switch Console manages it there; the service commands
  described below are for Linux and macOS.
- Node.js 22.13 or later, including npm. The controller uses Node's built-in
  SQLite support.
- The CLI for each provider you plan to use, installed on the machine's
  `PATH`. Sign in as the user who will run the controller, or supply the
  provider's supported environment settings as described below.

## Install and enroll

Open the gateway's **Machines** page and create an enrollment code. Codes
expire after ten minutes. Copy the installation command shown there onto
the machine you want to enroll. It has this shape; replace the example
server address and `ENROLLMENT_CODE` with your own values:

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code ENROLLMENT_CODE
```

The installer verifies the release signature, installs the controller,
enrolls it and starts a service. It uses npm's global prefix when writable,
otherwise `~/.local`. Follow its `PATH` instructions if the command cannot
be found afterward. Running the installer without `--server` and `--code`
only installs the software.

If the controller is already installed, enroll it separately:

```bash
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code ENROLLMENT_CODE \
  --name build-box

switch-agent-controller install-service
```

Use HTTPS for a remote server. HTTP is accepted only for a loopback server.
Run one controller per machine. Starting two copies with the same identity
causes the newer connection to take over.

Check the result:

```bash
switch-agent-controller status
switch-agent-controller doctor
```

`status` reads local enrollment and agent state without contacting Switch.
`doctor` also checks server access, provider installation and sign-in,
the service, and available updates. A warning does not fail `doctor`; a
failed check does. If a release check fails on an offline machine, read
the other checks before concluding that the controller cannot run agents.

The machine should now appear in **Machines**. Create an agent assigned to
it, choose an installed and signed-in provider, and add the agent to a room.
Mention it in that room and check for a reply. If it stays offline, start
with `doctor` and the controller log rather than enrolling it again.

## Keep it running

On Linux, the default service is a systemd user unit:

```bash
systemctl --user status switch-agent-controller
journalctl --user -u switch-agent-controller -f
systemctl --user restart switch-agent-controller
```

It starts at login. To keep it running after logout and start it at boot,
enable lingering for that user:

```bash
sudo loginctl enable-linger USERNAME
```

On macOS, the default service is a launchd agent,
`~/Library/LaunchAgents/com.switch.agent-controller.plist`. It runs while
the user is logged in. Read `controller.log` in the data directory:

```bash
tail -f "$HOME/Library/Application Support/Switch/agent-controller/controller.log"
```

The service keeps the `PATH` of the shell that installed it. If you install
a provider somewhere new, run `install-service` again from a shell that can
find it. Custom data directories produce distinct service names; use the
name printed by the installer instead of the default names above.

In a container or Linux environment without a systemd user manager, run
the controller in the foreground under your own supervisor:

```bash
switch-agent-controller run
```

Logs go to stderr. `SWITCH_CONTROLLER_LOG_LEVEL` accepts `debug`, `info`,
`warn` or `error` and defaults to `info`. For a custom supervisor, use these
restart rules:

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Stopped or finished successfully | Leave stopped |
| 1 | A failure that may pass | Restart with backoff |
| 2 | Configuration error | Fix the final error on stderr before restarting |
| 3 | Controller revoked | Enroll again with a new code |
| 4 | Another instance took over | Stop the duplicate; keep one instance |
| 5 | Protocol unsupported | Update the controller |
| 6 | Controller credential no longer accepted | Enroll again |
| 7 | An update was installed | Restart immediately |

To remove a service:

```bash
switch-agent-controller uninstall-service
```

This keeps enrollment and agent data. It removes the service and the
releases that service installed.

## Give the providers a sign-in

For the default setup, install and sign in to each provider CLI as the
controller's user. A sign-in in someone else's account or home directory
does not make that provider ready for this machine.

For an unattended machine, put the provider's supported `NAME=value`
settings in a private environment file. Keep it outside the checkout,
readable only by the user running the controller. For example, an env file
can supply a provider API key; do not paste its contents into a room or log.
Then use the same file for the service and diagnostics:

```bash
switch-agent-controller install-service --env-file /absolute/path/agents.env
switch-agent-controller doctor --env-file /absolute/path/agents.env
```

The file is read at startup. Restart the service after changing it. Sessions
inherit the supported provider settings, rather than every variable in the
controller's environment. See the package README's
[environment reference](../console/packages/agent-controller/README.md#environment-for-the-agents)
for details, including Vertex AI and Bedrock.

An owner can also give a machine a provider login from Switch Console.
Console seals it for that machine; the server relays encrypted data.
The machine's own sign-in takes precedence. See
[provider logins given to the machine](../console/packages/agent-controller/README.md#provider-logins-given-to-the-machine)
for supported providers and withdrawal behavior.

## Where agents run

**Shared** agents run inside the controller process. **Isolated** agents
run in separate host processes and can reconnect after a controller restart.
Both use the controller's operating-system account by default. Choosing
isolated mode does not give an agent a separate OS user or protect one
agent's files from another agent running under that same user.

When an agent has no directory set, its workspace is under
`~/.switch/agents/<server-host>/<agent-name>`. An explicit directory in its
definition is used instead.

Linux machines with systemd and polkit can run every agent as its own
restricted OS user. This needs a separate setup as root, system-wide Node
and provider installations, and provider settings that those users can
access. Follow the package README's
[separate-user setup](../console/packages/agent-controller/README.md#each-agent-as-a-linux-user-of-its-own)
before enabling it. Those agents use directories under
`/var/lib/switch-agents/<uid>`; a directory outside the permitted agent
workspace is refused. Provider logins in the controller user's home are
not inherited in this mode.

The controller's own data is separate from agent workspaces:

| OS | Default data directory |
| --- | --- |
| Linux | `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller` |
| macOS | `~/Library/Application Support/Switch/agent-controller` |
| Windows | `%LOCALAPPDATA%\Switch\agent-controller` |

Use `--data-dir /absolute/path` consistently on commands when you choose a
different directory, or set `SWITCH_CONTROLLER_DATA_DIR`. Console-managed
controllers use Console's own app data. The directory contains identity,
local state and secrets: keep it private and do not copy it to a second
running machine.

## Updates

```bash
switch-agent-controller update --check
switch-agent-controller update
```

Manual updates verify a signed release and restart a running service.
A controller running from the service's managed releases directory refuses
a manual update; follow its error instructions rather than replacing files
under `releases/current` by hand.

Switch can also tell a controller which release to run. It waits for active
turns to finish, verifies the download and signature, installs it and exits
7 so its supervisor restarts it. A failed update is reported and leaves the
current release running. See the package README's
[update reference](../console/packages/agent-controller/README.md#updates)
for managed installs and rollback behavior.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Machine missing from Machines | Check the server URL, the enrollment code's ten-minute expiry, and the enrollment result. |
| `protocol_unsupported` | Update the controller to a version compatible with the server. |
| `invalid_credential` or a revoked controller | Get a new enrollment code; do not reuse the old credential. |
| `taken_over` | Stop duplicate controllers using the same identity. |
| `provider_not_installed` | Install the CLI on the service user's `PATH`; reinstall the service if that path changed. |
| `provider_login_missing` or `provider_login_expired` | Sign in as the controller user, check its env file, or supply a supported login from Console. In separate-user mode, the controller user's home sign-in is not used. |
| `definition_invalid` | Inspect the reported detail for unsupported settings or a directory outside the permitted workspace. |
| `capacity_exceeded` in separate-user mode | Increase the configured agent-user pool following the separate-user setup instructions. |
| Enrollment works but server checks fail | Check `/v1` proxy routing, HTTPS and connectivity from the controller machine. |
| `status` shows no assignment | It reads the last local assignment; check the running controller and assign an agent to this machine in Switch. |

On Windows, use Switch Console to manage the controller, or keep `run`
running in a terminal. `install-service`, `uninstall-service` and
separate-user mode are not supported there. There is no need to install WSL
to run the Windows controller.

For the full command and implementation reference, see the
[controller README](../console/packages/agent-controller/README.md),
[controller design](design/agent-controllers-v1.md) and
[protocol contract](design/controller-contract-v1.md).
