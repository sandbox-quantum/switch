# Run agents with the agent controller

_Install the headless controller on a machine of your own, enroll it, and keep it healthy_

The agent controller is a headless program that runs the Switch agents you place on a machine, and reports their status back to Switch. Run one per machine. Where [Switch Console](official/deploy/connect-agents/switch-console.md) runs agents on the computer in front of you, the controller runs them on a server with nobody signed in — it is installed as a service that starts again on its own, and it keeps running after you close your laptop.

You place agents on the machine from the Gateway's **Machines** page. The controller pulls that assignment, starts each agent, and keeps Switch told what each one is doing.

The machine holds no Switch credential for any agent. The controller holds one connection to Switch for all of them, and each agent reaches Switch through a loopback relay the controller runs, with a token only that relay accepts.

**Note**

Machines and managed agents are behind a feature flag. The server has to be started with `agent_management` in `FEATURE_FLAGS_ENABLED`, or the **Machines** page reports that agent management is not enabled.

## What you need

**A machine that stays up.** A VM, a server, or a spare computer. It has to reach your Switch server's API address; nobody has to be able to reach it.

- **Operating system:** macOS, Linux, or Windows 10/11. The one-line installer below runs on Linux and macOS only. On Windows the controller is meant to run under Switch Console, which starts and stops it — `install-service` refuses there.
- **Node 22.13 or later.** The controller keeps its state in Node's built-in SQLite, which older versions don't have.
- **The provider CLI of every agent you plan to run**, installed on `PATH` and signed in as the user the controller runs as: `claude`, `codex`, `opencode`, `agent` or `cursor-agent` for Cursor, and `agy` for Antigravity (an older `antigravity-acp` is still used where it is the only one installed). An API key in the controller's environment file counts instead of a sign-in — see [Sign the providers in on the machine](#sign-the-providers-in-on-the-machine).
- **A Switch server with agent management on**, as above. If Switch sits behind a proxy or an ingress, `/v1` has to reach switch-core.

The server address you enroll against must be `https`. Plain `http` is accepted only for a loopback server, and the URL must carry no credentials, query or fragment.

## Install the controller

Open the Gateway, select **Machines**, then **Add machine**. The dialog issues a one-time enrollment code and shows the command that installs the controller, enrolls the machine with that code, and starts it as a service. It takes this shape:

```sh
curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh \
  | sh -s -- --server https://switch.example.com --code <code>
```

Copy the command from the dialog rather than composing your own: it carries the code, and `--server` is already the API address your server reports. If the machine reaches Switch at some other address, change it to that one.

The installer takes `--name` and `--description` for the machine, `--data-dir` to keep the controller's state somewhere other than the default folder, `--no-service` to enroll without installing the service, and `--version x.y.z` to install a release other than the newest. With neither `--server` nor `--code` it only installs.

It installs with npm, into npm's global prefix. When that isn't writable by this user — which is usual where Node came from the system's packages — it installs into `~/.local` instead, without changing npm's settings, and says so if `~/.local/bin` isn't on your `PATH`. It installs only a release signed with a key built into it, and runs no npm install scripts.

**Note**

The installer finishes by running `switch-agent-controller doctor`, so you see what the machine is still missing before you leave it.

## Enroll the machine

An enrollment code is single use and valid for ten minutes. If the code has expired, open **Add machine** again for a new one.

On a machine where the controller is installed already:

```sh
switch-agent-controller enroll \
  --server https://switch.example.com \
  --code <code> \
  --name build-box \
  --description "The build box in the office"
```

- `--name` defaults to the machine's host name, and is at most 200 characters.
- `--description` says what the machine is for, at most 500 characters. Its owner reads it on the **Machines** page.
- `--data-dir` keeps the controller's state in a folder you name. One machine can carry two controllers this way, each with its own data directory.
- `--secret-store` says where the controller credential is kept: `keychain` (the default on macOS, the login keychain), `secret-service` (the desktop keyring on Linux), or `file` (the default elsewhere, a file only this user can read, in the data directory). Choose `secret-service` only where the keyring is unlocked whenever the controller starts, which a service started at boot usually isn't.

The machine appears on the **Machines** page once its controller reports. Change its name or description later from that page, or on the machine:

```sh
switch-agent-controller set-info --name build-box --description "Now the release box"
```

`--description ""` clears the description. `set-info` uses the controller's own credential, so it works only where that credential is in the data directory.

## Run it as a service

```sh
switch-agent-controller install-service
```

The service runs as the user who installs it, and keeps the `PATH` of the shell that installed it — so the provider CLIs you could find then are the ones the service finds. It starts at once and again at each login.

- **On Linux** it is a systemd user unit, `~/.config/systemd/user/switch-agent-controller.service`. Read its log with `journalctl --user -u switch-agent-controller -f`.
- **On macOS** it is a launchd agent, `~/Library/LaunchAgents/com.switch.agent-controller.plist`, logging to `controller.log` in the data directory.

On Linux, without lingering, the service stops when you log out and starts again at your next login — `install-service` says so when lingering is off. To keep it running and start it at boot, turn lingering on for the user:

```sh
sudo loginctl enable-linger <user>
```

A data directory other than the default gets a service name carrying a hash of its path, so two controllers on one account each get their own.

Pass `--env-file <path>` to give the agents an environment — see [Sign the providers in on the machine](#sign-the-providers-in-on-the-machine). The file is read when the service starts, so restart the service after changing it.

To remove it:

```sh
switch-agent-controller uninstall-service
```

That stops and removes the service, and the releases it installed for itself. The enrollment and the rest of the data directory are kept.

**Note**

`install-service` refuses on Windows, and on Linux where the user has no systemd user manager — some containers and minimal VMs. Run `switch-agent-controller run` under your own supervisor instead, restarting it on exit codes `1` and `7` only. With systemd that is `Restart=on-failure` and `RestartPreventExitStatus=2 3 4 5 6`.

## Keep it healthy

Three commands tell you what the machine is doing, and keep it current.

### status

```sh
switch-agent-controller status
```

Reads local state only, and makes no network call. It prints the data directory, the controller's id and name, the server it enrolled against, where the credential is kept, the relay's last port, and the assignment as the controller last pulled it: each agent's provider, its desired state, the revision the machine has applied, and what that agent's process is doing.

### doctor

```sh
switch-agent-controller doctor
```

Checks what the machine needs to run agents and says what to do where it falls short: the Node version, the platform, enrollment, the credential, the server (by exchanging the credential, so a proxy that doesn't send `/v1` to switch-core shows up here), the shared-host bundle, each provider CLI on `PATH` and its sign-in, the service, and whether a newer controller release exists. It exits `1` when any check fails.

Give it `--env-file <path>` to check the providers as the agents would see them, with the keys that file sets.

### update

```sh
switch-agent-controller update --check
switch-agent-controller update
```

`--check` only says whether a newer release is published. Without it, `update` installs the newest release and restarts the service if it is running. It installs only a signed release.

Mostly you won't run it. When Switch names a release for this controller, the controller installs it itself: it waits until no session on the machine is in the middle of a turn, checks the package against the SHA-256 Switch gave and against a release signature, installs it, and exits `7` for its service to start it again on the new release. A failed attempt is reported and not retried for an hour.

To keep a machine on the release it has, set `SWITCH_CONTROLLER_SELF_UPDATE=off` in the controller's environment or in its environment file, or run it with `--no-self-update`. The controller then installs nothing and reports why when Switch names another release. `update` still installs by hand. Any value of that variable other than `on` or `off` stops the controller with a configuration error.

A controller that Switch Console runs never updates itself: Console replaces it.

## Shared and isolated agents

Each agent's definition says how its process runs on the machine. You choose it in the **Isolation** field when you add or edit a managed agent.

| Isolation | Where the agent runs | What follows |
| :-- | :-- | :-- |
| **Shared** (the default) | Inside the controller's own process | Stopping the controller stops the agent and its sessions. The next run starts them again from where each left off |
| **Isolated** | In a process of its own | It isn't stopped when the controller exits. It keeps retrying the controller's hub and picks up again once the controller is back |

Both hear their events on the same hub and make their calls to Switch through the same relay; the difference is only which process they run in. Changing an agent's isolation restarts it the other way. An agent that uses a provider login given to the machine runs isolated whatever its definition says.

### Where an agent's workspace lives

An agent's workspace is the same for both kinds.

- **An agent whose definition names no directory** works in `~/.switch/agents/<server>/<agent name>/`, under the home directory of the user the controller runs as. `<server>` is the server's address with anything but letters, digits, dots, hyphens and underscores replaced by a hyphen — `switch.example.com`, or `localhost-8000` for a local server. The controller creates a missing folder there.
- **An agent whose definition names a directory** works in that absolute path. Below the workspaces folder above, a missing directory is created. Anywhere else it must already exist and be a directory, or the agent fails with `definition_invalid`.

The sessions an agent runs keep their own state under `~/.local/state/switch/sdk-sessions/`, as they do under Switch Console.

**Note**

On Linux, a controller can be set up to run every agent as a Linux user of its own, each seeing only its own directory. That setup is run once as root and changes where workspaces live. It is covered in the controller's own README in the Switch repository.

## Sign the providers in on the machine

An agent can only run if its provider CLI is both installed and signed in **as the user the controller runs as**. There are three ways to get there.

**Sign in on the machine.** Log in as that user and run the provider's own login command: `claude auth login`, `codex login`, `opencode auth login`, `agent login` for Cursor, or the Antigravity CLI's own sign-in for `agy` (see [Google's install guide](https://antigravity.google/docs/install?tab=cli)). This is the machine's own login, and it is what the controller prefers.

**Put an API key in the environment file.** `run`, `install-service` and `doctor` take `--env-file <path>`, read as systemd reads `EnvironmentFile=`: one `NAME=value` per line, blank lines and `#` comments skipped, an optional `export ` prefix, and values in single or double quotes taken literally. Anything else is refused, naming the line.

```sh
# Claude Code on Vertex AI, signed in with `gcloud auth application-default login`
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=my-project
CLOUD_ML_REGION=us-east5
```

Sessions inherit only the provider variables Switch knows — API keys, base URLs, model overrides, and the Vertex AI, Bedrock and Google Cloud settings — plus the basics a CLI needs. The file is read once at start, so restart the service after you change it.

**Have the owner give the machine a login.** A machine with no login of its own for a provider can be given one from Switch Console, at any time after it is up. Enrollment makes a keypair and keeps the private half on the machine, so Switch stores and relays only ciphertext it cannot open. The controller fetches the login, checks the provider signs in with it, and reports the result; from then on that provider reads as signed in from a given login.

The machine's own login always comes first. A given login is used only for a provider the machine has none of its own for.

**Note**

After installing or signing in a CLI, you don't have to restart anything: open the **Machines** page and use **Re-check providers** on that machine. The controller looks the CLI up on a `PATH` it reads afresh and reports what it finds.

## Troubleshooting

Start with `switch-agent-controller doctor` on the machine. Most of what follows is a check it already makes.

Logging goes to stderr. Set the level with `SWITCH_CONTROLLER_LOG_LEVEL` — `debug`, `info`, `warn` or `error`, `info` by default.

### The machine never appears on the Machines page

The code may have expired: a code is valid for ten minutes and single use. Run `doctor` on the machine. If the **Server** check fails saying the address answered but not as the Switch API, Switch is behind something that isn't sending `/v1` to switch-core.

### Reason codes

An agent that is not running, a provider that is not ready, and an action that failed each carry a reason code on the **Machines** page, beside the state. These are the ones the controller reports.

| Code | What it means | What to do |
| :-- | :-- | :-- |
| `provider_not_installed` | The provider's CLI was not found on the `PATH` the controller sees, or the provider can't run on this platform | Install the CLI for the user the controller runs as, then re-check providers. Where agents run as Linux users of their own, install it outside the home directories, which those users cannot reach |
| `provider_login_missing` | The CLI is installed, but reports no usable sign-in | Sign it in as the user the controller runs as, give the key in the `--env-file`, or have the machine given a login |
| `provider_login_expired` | The login given to this machine no longer signs the provider in | Give the machine the login again from Switch Console |
| `definition_invalid` | The agent's definition can't be applied on this machine. The detail says which part: a provider this controller doesn't run, advanced settings a session can't start with, or a working directory that isn't absolute, doesn't exist, or isn't a directory | Fix the agent's definition on the **Machines** page. The agent starts on the next revision |
| `invalid_credential` | The agent's host stopped because Switch refused its credentials, or they belong to a different agent | Restart the agent |
| `taken_over` | Another client took this agent's room connection | Restart the agent to take it back |
| `capacity_exceeded` | Every agent user set up on this machine already runs an agent | Run the separate-users setup again with a larger `--agent-users` |
| `not_assigned` | A restart was asked for an agent this controller isn't assigned | Reload the **Machines** page: the agent has moved or been removed |
| `validation_error` | An operation named something the controller can't act on — a restart with no agent, a restart of an agent assigned as stopped, or a provider it doesn't run | Nothing on the machine. Retry the action from the Gateway |
| `operation_unsupported` | Switch asked for work this controller doesn't do. It runs agent restarts, provider re-checks, and taking up a login sealed to it | Update the controller if the operation is one a newer release should run |
| `internal` | The controller couldn't say more. An agent reported `crashed` with this reason has a host that is not running and recorded no failure | Read the detail on the page, then the controller's log |

### Exit codes

Useful when you run `switch-agent-controller run` under your own supervisor rather than the installed service.

| Code | Meaning | Restart it? |
| :-- | :-- | :-- |
| `0` | Stopped by SIGINT or SIGTERM, or the command finished | No |
| `1` | A failure that may pass: the network, the server, or a crash | Yes, with backoff |
| `2` | A configuration error that starting again unchanged cannot fix | No, not until the configuration changes |
| `3` | The server revoked this controller | No: enroll the machine again |
| `4` | Another instance of this controller took its stream over | No: two instances would take it from each other in turn |
| `5` | The server does not speak this controller's protocol | No: update the controller |
| `6` | The server knows no controller by this credential — it was replaced, or its key was deleted | No: enroll the machine again |
| `7` | It installed the release Switch names and exited so it can be started on it | Yes, at once |

Code `2` covers an unknown command or option, a server URL that isn't one or is plain `http` to something other than a loopback host, a data directory belonging to another controller or written by a newer one, a missing shared-host bundle, an unsupported platform, and a data directory holding no identity or no credential. The reason is the last line on stderr, prefixed `switch-agent-controller: `.

Once the controller is running, failures talking to Switch are retried inside the process and don't end it.

### An agent host that keeps failing

A shared agent's host that fails is started again on its own after 2, 4 and 8 seconds. A fourth failure within ten minutes is recorded, and that agent stays down until a new revision or an explicit restart. The other agents on the machine are unaffected.

## Next steps

- [Connect your agents with Switch Console](official/deploy/connect-agents/switch-console.md) — The other way to run an agent, and what Console keeps doing for it

- [Onboard a remote host](official/deploy/host-remotely.md) — Give Switch Console a machine to run agents and servers on over SSH

- [Set up agent providers](official/getting-started/set-up-agent-providers.md) — Install and sign in to the provider CLIs an agent needs
