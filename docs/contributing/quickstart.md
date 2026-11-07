# Quickstart for new contributors

From a fresh clone to an agent answering you in a room, and on to your first
change. Plan on about 15 minutes, most of it downloads.

This is the short path. [`CONTRIBUTING.md`](../../CONTRIBUTING.md) has the
rules for getting a change merged, and
[`docs/old/LOCAL_DEVELOPMENT.md`](../old/LOCAL_DEVELOPMENT.md) explains every
port and setting used below.

> **Switch changes fast.** Recipes, ports and Console screens move often. If a
> step here doesn't match what you see on current `main`, say so in the issue
> you're working on (or open one) rather than working around it quietly — the
> guide is probably what's out of date.

## 1. Install the prerequisites

| Tool | Why | Check |
| --- | --- | --- |
| [Git](https://git-scm.com/) | Clone the repo | `git --version` |
| [Docker](https://docs.docker.com/get-docker/) with Compose | Runs PostgreSQL and Mattermost | `docker compose version` |
| [uv](https://docs.astral.sh/uv/) | Python 3.12+ and switch-core's dependencies | `uv --version` |
| [just](https://github.com/casey/just) | Runs every recipe in the `justfile` | `just --version` |
| `bash` and `openssl` | The `justfile` recipes are bash scripts; `just init-env` uses `openssl` to make secrets | `bash --version`, `openssl version` |
| [Node](https://nodejs.org/) (the version in `console/.nvmrc`) and pnpm | Switch Console and the gateway dashboard | `node -v`, `pnpm -v` |
| An agent CLI, signed in | Something to answer in the room: Claude Code, Codex, OpenCode, Cursor or Antigravity | e.g. `claude --version` |

For pnpm, `corepack enable` picks up the version pinned in
`console/package.json`.

**On Windows**, do everything in **WSL2** (Ubuntu) or in **Git Bash**:
PowerShell has no `bash`, and the recipes need it. See [Windows notes](#windows-notes)
before you clone.

## 2. Clone and configure

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch
just init-env            # writes .env with fresh random secrets
uv sync --project core   # installs switch-core's Python dependencies
```

`just init-env` prints the **gateway admin login** it generated. Keep it:
it's how Switch Console signs in to your local server. You can read it again
later from `GATEWAY_ADMIN_EMAIL` / `GATEWAY_ADMIN_PASSWORD` in `.env`. The
recipe refuses to overwrite an existing `.env`.

> Don't use `cp .env.example .env`: the example ships every secret blank on
> purpose, and `just init-env` is what fills them.

## 3. Start the server

Three terminals, each from the repo root:

```bash
# terminal 1 — PostgreSQL and Mattermost in Docker, then the schema
just up
just migrate

# terminal 2 — switch-core on http://localhost:8000 (leave it running)
just run

# terminal 3 — the operator dashboard on http://localhost:5173 (optional)
just gateway-install     # first time only
just gateway-dev
```

`just run` does not apply migrations; run `just migrate` again whenever you
pull a change that adds one. Opening `localhost:8000` in a browser shows JSON,
not a UI — the dashboard is on `:5173`.

## 4. Run Switch Console from source

In a fourth terminal:

```bash
cd console
pnpm install
pnpm run dev
```

The first `pnpm install` downloads Electron and takes a few minutes. If you're
not changing the Console, the
[released app](https://github.com/sandbox-quantum/switch/releases/latest) works
just as well against your local server.

## 5. Connect the Console to your local server

1. In Switch Console, add a server and choose **Connect to an existing
   server**.
2. Enter **`http://localhost:8000`** — switch-core's address, not the
   dashboard's `:5173`. (If your Console build asks for two addresses, use
   `http://localhost:8000` as the API URL and `http://localhost:5173` as the
   Gateway URL.)
3. Sign in with the gateway admin login from step 2.
4. When asked to link your messaging account, pick your Mattermost user (see
   the next step). You can also do it later from the server's **Home** page.

## 6. Get an agent to answer in a room

1. **Sign in to Mattermost** at <http://localhost:8065> as `MATTERMOST_USER`
   with `MATTERMOST_USER_PASSWORD`, both from `.env`.
2. **Add an agent.** In Switch Console, open **Your Agents**, select the card
   with a plus, give it a name such as `hello`, set **Run location** to this
   computer, pick a working directory, choose your agent CLI, and select
   **Add agent**.
3. **Create a room.** Open **Your Rooms** → **Create room**, choose
   Mattermost, name it, and add your agent.
4. **Say hello.** In the new Mattermost channel, type `@hello` (pick it from
   the list) and ask for something only your machine knows, e.g. *"list the
   files in your working directory"*. The first reply can take up to a minute
   while the session starts.

If nothing comes back, run `!agents-status` in the channel. **✋ awaiting
input** means the agent is waiting for an approval — find it in the thread or
in the agent's session in Switch Console. The
[smoke test's table](../official/getting-started/smoke-test.md#when-a-step-doesnt-match)
covers the rest.

## 7. Find where to make a change

| Path | What's there | Test it with |
| --- | --- | --- |
| `core/switch_core/` | switch-core: the Agent Bridge API, gateway API, messaging bridges, connectors | `just test` (or `just test -k name`) |
| `console/` | Switch Console (Electron); app code in `console/apps/switch-console-desktop/src/`, shared packages in `console/packages/` | `cd console && pnpm -r run test` |
| `gateway/` | The operator dashboard (Vite) | `just gateway-test` |
| `docs/` | `contributing/` guides like this one; `official/` is generated, so edit the docs repository instead | — |

Focused guides: [adding an agent CLI](../../console/docs/new-agent-cli.md) and
[adding a messaging platform](new-messaging-platform.md). Connector issues link
to the "Adding a connector" section of
[`service-connections-v2.md`](../design/service-connections-v2.md).

## 8. Before you open a pull request

Run what CI runs for the part you touched:

```bash
# switch-core
just check && just typecheck && just test

# Switch Console
cd console && pnpm -r run lint && pnpm -r run typecheck && pnpm -r run test
```

Then:

- [ ] Put `Closes #<issue>` in the PR description, and fill in **What this
      changes** and **How it was tested** from the template.
- [ ] Say which OS you tested on.
- [ ] Sign the CLA: the bot comments on your first PR; reply with the exact
      sentence it asks for. You only do this once.
- [ ] Keep unrelated fixes in their own small PRs.

When you're done, `just down` stops the Docker services; `just reset` also
wipes their data.

## Windows notes

- **Line endings.** Git for Windows converts files to CRLF on checkout by
  default, which breaks shell scripts and the connection catalog. Clone with
  `git clone -c core.autocrlf=false https://github.com/sandbox-quantum/switch.git`,
  or clone inside WSL2.
- **Docker Desktop needs WSL2.** "Virtual Machine Platform is not enabled"
  means running these in an administrator PowerShell, then restarting
  Windows:

  ```powershell
  Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart
  ```

  If it still fails, turn on virtualization (Intel VT-x / AMD-V) in the BIOS;
  Task Manager → Performance → CPU shows whether it's on.
- **Agent CLI not found by the Console.** Claude Code's Windows installer puts
  `claude.exe` in `%USERPROFILE%\.local\bin`, which may not be on your `PATH`.
  Add it to the user `Path` variable, then quit and reopen Switch Console — it
  reads `PATH` only at startup.
- **No Docker at all?** You can still try Switch, though not this development
  setup: the released Switch Console's **Set up a server on this computer**
  runs without Docker, minus the built-in Mattermost, and you can connect
  Discord, Slack, Telegram or Teams instead.
