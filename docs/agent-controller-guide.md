# Running agents on your own machines with the agent controller

`switch-agent-controller` is the headless half of Switch's agent management: a small
Node program that runs on a machine of yours (a build box, a VM, a spare laptop), runs
the agents you assign to that machine from Switch, and reports their status back. Switch
Console does the same job for the agents it runs on your desktop; the controller does it
on machines without a desktop, as a service.

This guide takes you from a bare machine to a controller that is enrolled, running as a
service, checked with `doctor` and kept up to date. Every command was run against release
`switch-agent-controller-v0.31.0` on Debian 13 (Linux) and on Windows 11; where the two
differ, the guide says so.

- [Before you start](#before-you-start)
- [1. Install the controller](#1-install-the-controller)
- [2. Enroll the machine](#2-enroll-the-machine)
- [3. Run it as a service](#3-run-it-as-a-service)
- [4. Check the machine with `doctor` and `status`](#4-check-the-machine-with-doctor-and-status)
- [5. Give the agents their provider sign-ins](#5-give-the-agents-their-provider-sign-ins)
- [6. Keep it updated](#6-keep-it-updated)
- [On Windows](#on-windows)
- [Where things live](#where-things-live)
- [Exit codes and what to do about them](#exit-codes-and-what-to-do-about-them)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Before you start

You need three things.

**A Switch server with agent management on.** The controller talks to the
`agent_management` feature of switch-core. On a self-hosted server, set in its `.env`:

```bash
FEATURE_FLAGS_ENABLED=agent_management
CONTROLLER_TOKEN_SECRET=<at least 32 random characters, e.g. from: openssl rand -base64 48>
```

and restart the server. Flags are fixed at startup, so the server must be restarted for
the change to take effect. Behind a proxy or ingress, `/v1` must reach switch-core (the
Helm chart routes it already). When the flag is on, the gateway shows a **Machines** page
in its navigation: that is where enrollment codes come from.

> A local server started by Switch Console on your desktop is managed by Console, which
> decides its flags for you. In our test (Switch Console 0.40.1 on Windows 11,
> switch-core 0.31.0), *Settings → Managed agents* reported "No agent of yours is on a
> server with agent management", and no Machines page was available. To follow this guide
> end to end, use a server you run yourself (`just init-env` and the quickstart in
> `CONTRIBUTING.md`) or a deployed one with the flag on.

**Node 22.13 or later** on the machine. The controller's store uses the built-in
`node:sqlite`, so older Node versions cannot run it. Check with `node --version`. On
Linux distributions whose packaged Node is older (Debian and Ubuntu ship 18 or 20), use
the NodeSource repository or the official tarball from nodejs.org.

**The agent CLIs your agents use**, installed and signed in *as the user the controller
runs as*: `claude`, `codex`, `opencode`, `agent`/`cursor-agent` or `antigravity-acp`.
The controller finds them on `PATH`. If a CLI is not signed in, `doctor` says so and the
agent using it cannot run until it is (or until its API key is in the `--env-file`, see
[step 5](#5-give-the-agents-their-provider-sign-ins)).

## 1. Install the controller

Each `switch-agent-controller-v*` release on GitHub carries one npm package with no
dependencies: the CLI and the bundle it runs agents with. The install script installs it
with `npm install --global`.

### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh | sh
```

Without `--server` and `--code` the script only installs; you enroll in the next step.
On success it prints what to do next:

```
Installing https://github.com/sandbox-quantum/switch/releases/download/switch-agent-controller-v0.31.0/switch-agent-controller-0.31.0.tgz
added 1 package in 895ms
Installed 0.31.0. Next, with a code from the Machines page in Switch:
  switch-agent-controller enroll --server <Switch API URL> --code <code>
  switch-agent-controller install-service
Check this machine with: switch-agent-controller doctor
```

Two things the script handles for you:

- **Too old a Node.** It refuses before installing anything:
  `switch-agent-controller install: Node v20.20.2 is too old; the controller needs 22.13 or later.`
  Install Node 22 and run it again.
- **A global prefix you cannot write to** (Node from the system's packages installs into
  `/usr`). It installs into `~/.local` instead and tells you if `~/.local/bin` is not on
  your `PATH`. Open a new shell, or add it:
  `export PATH="$HOME/.local/bin:$PATH"`.

You can also install the package directly, which is what the script does underneath:

```bash
npm install --global --ignore-scripts https://github.com/sandbox-quantum/switch/releases/download/switch-agent-controller-v0.31.0/switch-agent-controller-0.31.0.tgz
```

**Signed releases.** Controller releases carry a signature beside the package
(`switch-agent-controller-<version>.tgz.sig`). `install.sh`, `update` and the
controller's own updates install only a release whose signature verifies against the
keys built into them, and they install with `--ignore-scripts`, so no install script
runs. If the script answers

```
switch-agent-controller install: Could not download …/switch-agent-controller-<version>.tgz.sig: the release has no signature, and only signed releases are installed.
```

the newest release it found is not signed (older releases before signing was introduced
are not). Install a signed release, or pass the package URL to `npm` directly as above,
which checks no signature: do that only for a release you trust.



### Windows

See [On Windows](#on-windows): the install differs, and the controller is not run as a
service there.

### Check the install

```bash
switch-agent-controller --version
```

prints `0.31.0`. Every command also prints, on stderr:

```
(node:4452) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

That is Node 22 flagging its built-in SQLite module, which the controller uses on purpose.
It is harmless and you can ignore it.

## 2. Enroll the machine

Enrollment ties this machine to your account on the Switch server, once. The server
issues a one-time code; the controller exchanges it for a credential of its own and
keeps that credential in the machine's secret store.

1. In the gateway, open **Machines** and add a machine. It shows a one-time code,
   valid for **10 minutes**, and the full command to run.
2. On the machine, run that command, or write it yourself:

   ```bash
   switch-agent-controller enroll --server https://switch.example.com --code <code>
   ```

   - `--server` is the Switch server's URL and must be `https`. Plain `http` is accepted
     only for a server on the same machine (`http://localhost:8000`).
   - `--name` defaults to the host name; `--description` (optional, up to 500 characters)
     says what the machine is for. Both show on the Machines page and can be changed
     later, there or with `switch-agent-controller set-info`.
   - `--data-dir <dir>` keeps the controller's state somewhere other than the default
     (see [Where things live](#where-things-live)). If you use it here, pass the same
     `--data-dir` to every later command.
   - `--secret-store keychain|secret-service|file` chooses where the credential goes:
     the macOS keychain by default on a Mac, owner-only files elsewhere.
     `secret-service` (the Linux desktop keyring) needs an unlocked keyring whenever
     the controller starts, so it is a poor fit for a headless box.

3. On success it prints the identity it was given and the two ways to run it:

   ```
   Enrolled as controller 609acefe-1691-47f5-9520-738815fbd235 ("debian-test") on https://switch.example.com.
   Data: /home/me/.local/state/switch/agent-controller
   Run it as a service: switch-agent-controller install-service
   or in this terminal: switch-agent-controller run
   Warning: No OS keychain backend is in use: the controller credential is stored as a plaintext file in /home/me/.local/state/switch/agent-controller/secrets, readable by this user only.
   ```

   The warning is what a headless Linux box normally gets: with no keychain, the
   credential is a file with mode `0600` in the data directory. That is the intended
   `file` secret store, not an error.

The machine now appears on the Machines page, with `state: unknown` until the
controller runs for the first time. `status` confirms the enrollment locally:

```
Data directory: /home/me/.local/state/switch/agent-controller
Controller:     609acefe-1691-47f5-9520-738815fbd235 ("debian-test")
Server:         https://switch.example.com
Enrolled at:    2026-10-29T08:58:06.539Z
Secret store:   plaintext files in /home/me/.local/state/switch/agent-controller/secrets (mode 0600)
Relay:          never started
Assignment:     not pulled yet
```

What `enroll` refuses, and how:

- A code that is wrong, already used or older than 10 minutes:
  `switch-agent-controller: enrollment_code_invalid: The enrollment code is invalid, already used, or expired.`
  (exit code 1). Make a new one on the Machines page; each code enrolls one machine.
- A data directory that is already enrolled:
  `switch-agent-controller: /home/me/.local/state/switch/agent-controller already belongs to controller 609acefe-… on https://switch.example.com. Use another --data-dir, or remove that directory to enroll this machine afresh.`
  (exit code 2).
- A plain-`http` server that is not on this machine:
  `switch-agent-controller: The server URL must use https (plain http is accepted only for a loopback server): http://example.com`
  (exit code 2).
- No `--server` at all: the usage text, then
  `switch-agent-controller: enroll needs --server <agent-bridge-url>.` (exit code 2).

To rename the machine or change its description later, from the machine itself:

```bash
switch-agent-controller set-info --description "The build box in the office"
# Controller 609acefe-1691-47f5-9520-738815fbd235 is now "debian-test": The build box in the office.
```

## 3. Run it as a service

```bash
switch-agent-controller install-service
```

runs the controller as a service **of your user** and starts it now:

- **Linux:** a systemd user unit, `~/.config/systemd/user/switch-agent-controller.service`.
  Logs: `journalctl --user -u switch-agent-controller -f`. It starts again at each login.
  To have it start at boot and survive logout, turn lingering on, once:
  `sudo loginctl enable-linger $USER` (the controller tells you when it is off).
- **macOS:** a launchd agent, `~/Library/LaunchAgents/com.switch.agent-controller.plist`,
  logging to `controller.log` in the data directory.

The service keeps the `PATH` of the shell that installed it, so the agent CLIs you can
run from that shell are the ones the service finds. Install the CLIs and sign in first,
then run `install-service`.

`install-service` refuses before enrollment:

```
switch-agent-controller: /home/me/.local/state/switch/agent-controller is not enrolled. Enroll first: switch-agent-controller enroll --server <url> --code <code>
```

(exit code 2). It also refuses on Linux without a systemd user manager (some containers
and minimal VMs) and on Windows; in those cases run it in the foreground or under your
own supervisor:

```bash
switch-agent-controller run
```

`run` stays in the foreground, logs to stderr, and stops its agents when it stops. A
healthy start looks like this:

```
INFO Agents controller starting {"controllerId":"609acefe-…","server":"https://switch.example.com","version":"0.31.0"}
INFO Relay listening for this machine's agents {"endpoint":"http://127.0.0.1:46599"}
INFO Opened the controller connection {"connectionId":"2b0906af-…","generation":1186410396,"agents":0}
INFO Switch has these agents bound to this controller {"agents":[]}
INFO Connected to Switch
INFO Pulled assignment {"revision":0,"why":"status says the assignment moved on"}
```

From here the Machines page shows the machine as **online**, with what the controller
reported about it (OS, free memory and disk, whether `git` and `gh` are on `PATH`, and
its workspaces folder, `~/.switch/agents/<server>/`). Agents you place on the machine
from Switch are started by the controller as soon as the assignment changes. Ctrl-C
stops it cleanly: `Received SIGTERM; stopping this controller's agents and exiting.`

In a container or minimal VM without a systemd user manager, `install-service` says so
and points at `run`:

```
switch-agent-controller: This user has no systemd user manager to install the service with (systemctl --user failed: …). Run `switch-agent-controller run` under your own supervisor, restarting it on exit code 1 only.
```

Under your own supervisor, restart it on exit code `1` and `7` only (see
[Exit codes](#exit-codes-and-what-to-do-about-them)).

Pass `--env-file <path>` to `install-service` or `run` to give the agents API keys and
provider settings ([step 5](#5-give-the-agents-their-provider-sign-ins)).

### Each agent as a Linux user of its own

By default every agent runs as your user and can read your files, including the
controller's credential. On Linux with systemd and polkit, the controller can run each
agent as a system user of its own that sees only its own directory. It is a one-time,
root setup after enrollment, and it needs Node, the controller and the CLIs installed
system-wide (`/usr`, `/usr/local` or `/opt`), not in a home directory:

```bash
sudo npm install --global <the release's .tgz URL>
switch-agent-controller enroll --server https://switch.example.com --code <code>
sudo switch-agent-controller install-service --separate-users [--env-file /etc/switch/agents.env]
```

The controller's README describes what the setup creates (a pool of `sa<uid>-NN` users,
a unit template, a polkit rule, `/var/lib/switch-agents/<uid>`) and its limits. Use it on
shared or internet-facing machines; a personal VM is fine without it.

## 4. Check the machine with `doctor` and `status`

`doctor` is the first thing to run when something does not work. It checks Node, the
platform, enrollment, the credential, the server, the agent CLIs and their sign-in, the
service and updates, and says what to do where a check fails. On a machine that is
installed but not yet enrolled and has no CLI signed in:

```
ok    Node         v22.22.0
ok    Platform     linux
FAIL  Enrollment   /home/me/.local/state/switch/agent-controller is not enrolled. Run: switch-agent-controller enroll --server <url> --code <code>, with a code from the Machines page.
ok    Shared host  /home/me/.local/lib/node_modules/switch-agent-controller/shared-host.mjs
FAIL  Providers    No provider CLI is installed and signed in on PATH for this user, so no agent can run here. Install one (claude, codex, opencode, cursor or antigravity) and sign in, or set its API key in the --env-file the service runs with.
warn  Service      Not installed; run: switch-agent-controller install-service (or keep `run` going yourself)
ok    Version      0.31.0, the latest
```

Each `FAIL` line names the fix. `doctor` exits `1` when any check fails, which makes it
usable from scripts. With `--env-file`, it checks the providers the way the agents would
see them.

`status` shows the controller's identity and its agents **from local state only**: it
makes no network call, so it works offline and before the server is reachable. Before
enrollment it prints the data directory and `Not enrolled.`

To check from the other side, open the Machines page: the machine shows as online once
the controller's stream is up, with the agents placed on it and the result of its
provider checks.

## 5. Give the agents their provider sign-ins

An agent runs with a CLI (Claude Code, Codex, OpenCode, Cursor, Antigravity) and needs
that CLI's sign-in. Three ways, in the order the controller prefers them:

1. **The machine's own sign-in.** Sign in to the CLI as the user the controller runs as
   (`claude auth login`, `codex login`, `opencode auth login`, …) before installing the
   service. `doctor` shows each CLI as `Installed <version>, authenticated`.
2. **An env file.** Put API keys and provider settings in a `NAME=value` file and pass it
   with `--env-file` to `install-service` or `run`:

   ```bash
   # /home/me/agents.env
   ANTHROPIC_API_KEY=sk-ant-...
   # Claude Code on Vertex AI, signed in with `gcloud auth application-default login`
   CLAUDE_CODE_USE_VERTEX=1
   ANTHROPIC_VERTEX_PROJECT_ID=my-project
   CLOUD_ML_REGION=us-east5
   ```

   The file is read once at start; restart the service after changing it
   (`systemctl --user restart switch-agent-controller`). Only the provider variables
   Switch knows reach the agents.
3. **A login given from Switch Console.** The machine's owner can hand a provider login to
   the machine from Console at any time; it is sealed to a key the controller made at
   enrollment, so the server only relays ciphertext. This is how a cloud machine or a
   fresh host with no login of its own gets one. The machine's own sign-in, when it has
   one, still comes first.

## 6. Keep it updated

The controller updates itself when Switch names a release for it, and `update` does it
by hand:

```bash
switch-agent-controller update --check   # "This is the latest release, 0.31.0." or the newer version
switch-agent-controller update           # installs the newest release and restarts the service if it runs
```

When the server names a release, a running controller waits until no agent session is in
the middle of a turn, downloads the package, checks its SHA-256 against the one the server
gave, installs it, and exits with code `7` so its service starts it again on the new
release. A failed update is reported in the machine's status and not retried for an hour.
`run` logs a warning when a newer release exists, and `doctor` shows it.

A controller Switch Console runs (on your desktop or on an SSH host) is updated by
Console, never by itself.

**Turning self-update off.** On current `main` (newer than release 0.31.0) you can pin a
controller to the release it has: set `SWITCH_CONTROLLER_SELF_UPDATE=off` in its
environment or in the `--env-file` it runs with, or start it with
`run --no-self-update`. The controller then installs nothing when Switch names a release
and reports the pending update as failed with a problem saying self-update is off.
`on` (or unset) is the default; any other value stops `run` with a configuration error.

## On Windows

The controller runs natively on Windows 10/11, without WSL, but it is used differently
there: **Switch Console starts and stops it**, so it is not installed as a service.
This is what to expect, verified on Windows 11 with Switch Console 0.40.1 and controller
0.31.0.

**With Switch Console installed, there is no `switch-agent-controller` command.** Console
keeps its own copy of the controller under its application data and runs it for the
agents on this computer. In a terminal, `switch-agent-controller --version` answers
`"switch-agent-controller" non è riconosciuto come comando interno o esterno…`
(*not recognized as an internal or external command*). That is expected: nothing is
broken, and Console's agents keep working.

**Installing the command yourself.** You need Node 22.13+ for Windows (the installer from
nodejs.org). The release package then has to be installed with `npm`, and release 0.31.0
refuses Windows unless told otherwise:

```
> npm install --global https://github.com/sandbox-quantum/switch/releases/download/switch-agent-controller-v0.31.0/switch-agent-controller-0.31.0.tgz
npm error code EBADPLATFORM
npm error notsup Unsupported platform for switch-agent-controller@0.31.0: wanted {"os":"darwin,linux"} (current: {"os":"win32"})
```

The package's manifest lists only `darwin` and `linux` even though the controller runs
on Windows (this is `os: ['darwin', 'linux']` in
`console/packages/agent-controller/scripts/package.mjs`). Until a release lists `win32`,
install with `--force`, which skips the platform check and nothing else:

```
> npm install --global --force https://github.com/sandbox-quantum/switch/releases/download/switch-agent-controller-v0.31.0/switch-agent-controller-0.31.0.tgz
npm warn using --force Recommended protections disabled.
added 1 package in 2s

> switch-agent-controller --version
0.31.0
```

npm puts the command in `%APPDATA%\npm`, which the Node installer already added to your
`PATH`, so it works in the same terminal.

**What differs on Windows.**

- `install-service` refuses: there is no Windows service. Run the controller in the
  foreground with `switch-agent-controller run`, or let Switch Console run it. `doctor`
  reports this as fine:
  `ok    Service      Not a service on Windows: Switch Console starts and stops this controller (or keep `run` going yourself)`.
- The data directory is `%LOCALAPPDATA%\Switch\agent-controller`
  (`C:\Users\<you>\AppData\Local\Switch\agent-controller`). The controller sets its
  access list to your user and the system alone.
- Agent CLIs are found on `PATH` with `PATHEXT`, so both `claude.exe` and an npm
  install's `codex.cmd` or `opencode.cmd` count. `doctor` on a machine with OpenCode
  signed in shows `ok    opencode     Installed 1.19.3, authenticated: OpenCode has connected backends.`
- Antigravity has no Windows build, so it is reported as not installed.
- `--agent-runtime separate-user` (each agent as a user of its own) is Linux only.
- An agent's *shell setup* (a POSIX shell snippet) is refused.
- The controller does not update itself on Windows; install the newer package the same
  way, or let Console update its own copy.

**A full `doctor` on Windows 11**, installed by hand, not yet enrolled, with Claude Code
and Cursor installed but not signed in and OpenCode signed in:

```
ok    Node         v22.19.0
ok    Platform     win32
FAIL  Enrollment   C:\Users\me\AppData\Local\Switch\agent-controller is not enrolled. Run: switch-agent-controller enroll --server <url> --code <code>, with a code from the Machines page.
ok    Shared host  C:\Users\me\AppData\Roaming\npm\node_modules\switch-agent-controller\shared-host.mjs
warn  claude       Installed 2.1.306, unauthenticated: Sign in on the execution machine with claude auth login.
warn  cursor       Installed 2026.07.23-e383d2b, unauthenticated: Sign in on the execution machine with agent login.
ok    opencode     Installed 1.19.3, authenticated: OpenCode has connected backends. Model access depends on the selected backend.
ok    Service      Not a service on Windows: Switch Console starts and stops this controller (or keep `run` going yourself)
ok    Version      0.31.0, the latest
```

## Where things live

The data directory is the first of these that is set: `--data-dir`, the
`SWITCH_CONTROLLER_DATA_DIR` environment variable, then the OS default:

| OS | Default data directory |
|---|---|
| Linux | `$XDG_STATE_HOME/switch/agent-controller`, usually `~/.local/state/switch/agent-controller` |
| macOS | `~/Library/Application Support/Switch/agent-controller` |
| Windows | `%LOCALAPPDATA%\Switch\agent-controller` |

It is created with mode `0700` and holds `controller.db` (identity, cached assignment,
cursors), `secrets/controller-credential` (with the `file` secret store), one
`agents/<id>/` and `agent hosts/<id>/` per agent (relay credentials, journal,
`health.json`, which `status` reads), `updates/` and, for a service, `releases/` with the
`current` link the service runs through. Everything but the identity can be rebuilt from
the server.

An agent whose definition names no working directory works in
`~/.switch/agents/<server>/<name>/`, where `<server>` is the server's address
(`switch.example.com`, `localhost-8000`).

Logs go to stderr; set the level with `SWITCH_CONTROLLER_LOG_LEVEL=debug|info|warn|error`
(default `info`). Under systemd, read them with `journalctl --user -u switch-agent-controller`.

## Exit codes and what to do about them

| Code | Meaning | What to do |
|---|---|---|
| `0` | Stopped cleanly (Ctrl-C, SIGTERM), or the command finished. | Nothing. |
| `1` | An error that may pass: network, server, a crash. `doctor` also exits 1 when a check fails. | Let the service restart it (it does, with backoff). Run `doctor`. |
| `2` | A configuration error: unknown command or option, missing argument, a server URL that is not `https`, a data directory that is not enrolled or belongs to another controller, an unsupported platform. The reason is the last line on stderr, prefixed `switch-agent-controller: `. | Fix what the message names. Restarting unchanged fails the same way. |
| `3` | The server revoked this controller. | Enroll again with a new code. |
| `4` | Another instance with the same identity took over the stream. | Stop one of them. Two controllers must not share a data directory. |
| `5` | The server needs a newer controller (protocol unsupported). | `switch-agent-controller update`. |
| `6` | The server knows no controller by this credential (replaced, or key deleted). | Enroll again. |
| `7` | It installed the release Switch named and is restarting into it. | Nothing: the service starts it again. Under your own supervisor, restart it. |

With systemd, the unit `install-service` writes already uses `Restart=on-failure` and
`RestartPreventExitStatus=2 3 4 5 6`.

## Troubleshooting

- **`switch-agent-controller: command not found` right after installing (Linux).** The
  script installed into `~/.local` because npm's global prefix was not writable, and
  `~/.local/bin` is not on your `PATH`. Open a new shell or
  `export PATH="$HOME/.local/bin:$PATH"`.
- **`Node vXX is too old; the controller needs 22.13 or later.`** Install Node 22 (NodeSource,
  nvm, or the tarball from nodejs.org) and check `node --version` in the shell you install from.
- **`EBADPLATFORM … wanted {"os":"darwin,linux"}` (Windows).** See [On Windows](#on-windows):
  install with `--force`.
- **`doctor` says `FAIL Providers … No provider CLI is installed and signed in`.** Sign in to the
  CLI as the same user, or give the key in `--env-file`, then restart the service.
- **`doctor` says a CLI is `Installed …, unauthenticated`.** Run the sign-in it names
  (`claude auth login`, `agent login`, …) as the same user.
- **No Machines page in the gateway.** The server's `FEATURE_FLAGS_ENABLED` does not list
  `agent_management`, or `CONTROLLER_TOKEN_SECRET` is unset. Fix the `.env` and restart the server.
- **The code is refused.** Codes last 10 minutes and are single-use. Make a new one.
- **`install-service` refuses: "not enrolled".** Run `enroll` first, with the same `--data-dir`
  if you use one.
- **The service runs but the agents' CLIs are "not installed".** The service kept the `PATH` of
  the shell that installed it; if you installed a CLI later, run `install-service` again.
- **The agent runs but cannot reach the server.** Agents never talk to Switch directly: they go
  through the controller's local relay. Check the controller's own log first.
- **The machine shows offline in Switch after a reboot (Linux).** Lingering is off, so the user
  service only runs while you are logged in: `sudo loginctl enable-linger $USER`.

## Uninstall

```bash
switch-agent-controller uninstall-service   # stops and removes the service and the releases it installed; keeps the enrollment
npm uninstall --global switch-agent-controller
rm -rf ~/.local/state/switch/agent-controller   # Linux: the data directory, including the credential
```

On Windows: `npm uninstall --global switch-agent-controller` and delete
`%LOCALAPPDATA%\Switch\agent-controller`. To stop the server from expecting the machine,
remove it on the Machines page too.
