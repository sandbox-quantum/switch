# Quickstart: from clone to your first change

This page gets Switch running from a clone of this repository, connects Switch Console
to it, has an agent answer you in a room, and shows you where to make a change. It takes
about fifteen minutes on a machine that already has Docker. Every command below was run
on current `main` on Debian 13 and on Windows 11; where the two differ, the page says so.

Switch moves fast: several merges land every day, and a command or a screen can change
between the day this page was written and the day you read it. When something here does
not match what you see, say so in the issue you are working on, or open one, and tell
us the OS and the commit (`git rev-parse --short HEAD`).

- [What you need](#what-you-need)
- [1. Clone and create your `.env`](#1-clone-and-create-your-env)
- [2. Install the dependencies](#2-install-the-dependencies)
- [3. Start the stack](#3-start-the-stack)
- [4. Connect Switch Console and get a reply](#4-connect-switch-console-and-get-a-reply)
- [5. Where things live](#5-where-things-live)
- [6. Make a change and run the tests](#6-make-a-change-and-run-the-tests)
- [7. Open the pull request](#7-open-the-pull-request)
- [If something does not match](#if-something-does-not-match)

## What you need

| Tool | Why | Install |
|---|---|---|
| [Docker](https://docs.docker.com/get-docker/) | Runs PostgreSQL and Mattermost for you (`just up`) | Docker Desktop on macOS and Windows; Docker Engine on Linux |
| [uv](https://docs.astral.sh/uv/) | Runs switch-core, the Python backend, with the right Python and packages | `curl -LsSf https://astral.sh/uv/install.sh \| sh` (macOS/Linux) · `powershell -c "irm https://astral.sh/uv/install.ps1 \| iex"` (Windows) |
| [just](https://github.com/casey/just) | The task runner every command below goes through | `brew install just` (macOS) · `winget install Casey.Just` (Windows) · [other options](https://github.com/casey/just#installation) |
| Node.js 22.12 or newer | The gateway dashboard (`just gateway-dev`) | [nodejs.org](https://nodejs.org) (LTS) |
| Git | To clone and to send your change | [git-scm.com](https://git-scm.com) |
| [Switch Console](https://github.com/sandbox-quantum/switch/releases/latest) | The desktop app you will point at your local server | Installer for your platform from the latest release |
| An agent CLI, signed in | The agent that answers you: Claude Code, Codex or OpenCode | Any one of them; OpenCode works with free API keys |

You do not need to build Switch Console from source to contribute to the backend or the
docs: the released app connects to a local server just fine (see
[Building Switch Console from source](#building-switch-console-from-source) if you are
changing the Console itself).

> **Windows.** Run everything below in **Git Bash** (the shell that comes with Git for
> Windows), not in PowerShell or `cmd`: several `just` recipes are bash scripts
> (`#!/usr/bin/env bash`). From PowerShell, `just init-env` stops with
> `error: could not find `cygpath` executable to translate recipe `init-env` shebang interpreter path: program not found`.
> Open a new Git Bash window after installing `just` so it is on the `PATH`.
>
> **Windows, line endings.** Git for Windows defaults to `core.autocrlf=true`, which checks
> files out with CRLF line endings, and the connector catalog loader matches `SKILL.md`
> frontmatter as raw bytes, so `just run` stops at import time with
> `CatalogError: Connection airtable SKILL.md needs frontmatter with name: airtable and a description.`
> The fix is a `.gitattributes` with `* text=auto eol=lf` (PR #1016). Until it is merged, or
> if you cloned before it landed, re-check your clone out with LF endings:
>
> ```bash
> git config core.autocrlf false && git rm -q --cached -r . && git reset --hard
> ```
>
> (or `git add --renormalize .` once `.gitattributes` exists, or a fresh clone afterwards).

## 1. Clone and create your `.env`

```bash
git clone https://github.com/<your-user>/switch.git   # your fork
cd switch
just init-env
```

`just init-env` copies `.env.example` to `.env` and fills every secret with a fresh
random value, then prints the admin login you will use in step 4:

```
✅ Wrote .env with freshly generated secrets.
   Gateway admin login: admin@switch.local / 3117b0d5b263b28cfbd7f585328a8b050949985250acbb09
   The stack binds to 127.0.0.1 only (set SWITCH_BIND_ADDR to expose it).
```

Keep that password somewhere: it is not shown again (it is `GATEWAY_ADMIN_PASSWORD` in
your `.env` if you lose it). Run `just init-env` a second time and it refuses, on purpose:
`✋ .env already exists — refusing to overwrite it.` Delete `.env` first if you really
want new secrets.

Run `just` on its own at any time to list every recipe.

## 2. Install the dependencies

```bash
uv sync --project core      # Python packages for switch-core
just gateway-install        # npm packages for the dashboard
```

The Python project lives in `core/`, not at the repository root, so `uv sync` needs
`--project core` (a plain `uv sync` at the root answers
`No pyproject.toml found in current directory or any parent directory`). `just run` and
`just test` pass `--project core` for you.

On a first run, `uv sync` downloads a Python interpreter and the packages (a minute or
two); `just gateway-install` took about ten seconds.

## 3. Start the stack

You run three things, in three terminals:

```bash
just up            # 1. PostgreSQL and Mattermost, in Docker, in the background
just run           # 2. switch-core, the backend, on http://localhost:8000
just gateway-dev   # 3. the dashboard, on http://localhost:5173
```

`just up` builds and starts the supporting services with Docker Compose and returns;
`just down` stops them and `just reset` also wipes their data. The first run pulls two
images and builds a small setup image (about two minutes on Windows 11 with Docker
Desktop; a few seconds afterwards) and ends with:

```
 ✔ Container switch-postgres-1    Healthy
 ✔ Container switch-init-db-1     Exited
 ✔ Container switch-mattermost-1  Started
 ✔ Container switch-setup-1       Started
```

`switch-setup` then signs in to switch-core once it is up and connects the local
Mattermost for you, so you do not configure it by hand.

`just run` applies the database migrations (a long list of `Running upgrade …` lines on a
fresh database), seeds the admin user and listens:

```
INFO  [__main__] Seeded admin user: admin@switch.local
INFO  [__main__] Switch is running on http://0.0.0.0:8000
INFO  [uvicorn.error] Application startup complete.
```

From start to `Application startup complete` took four seconds on Debian 13 (Postgres on
the same machine) and about thirty seconds on Windows 11 with Postgres in Docker Desktop.
On Windows the firewall asks once whether Python may accept connections.
Leave it running. It does **not** reload on its own when you change Python code
(`uvicorn.Config` in `core/switch_core/main.py` is started without `reload`): stop it
with Ctrl-C and run `just run` again after a backend change. The dashboard from
`just gateway-dev`, on the other hand, hot-reloads. One `ERROR` line about
`@switch-admin:localhost … is a member of no room` is normal on a fresh server.

`just gateway-dev` starts the dashboard's dev server:

```
  VITE v6.4.3  ready in 220 ms
  ➜  Local:   http://localhost:5173/
```

Open **http://localhost:5173** in a browser and sign in with the admin login from step 1.
Two addresses, one server: `:8000` is switch-core (the API; it answers JSON, not a page),
`:5173` is the dashboard, which proxies its API calls to `:8000`.

## 4. Connect Switch Console and get a reply

Switch Console connects to a server by one address: switch-core's, **`http://localhost:8000`**
(not `:5173`; Console refuses that one, because it answers with a web page rather than
the API).

1. Open Switch Console (0.40.1 at the time of writing). Click the server name at the top
   of the sidebar → **Add a Switch server** → **Connect to an existing server** ("Point
   Switch Console at a Switch server someone else runs, by its address").
2. Give it a name (say `Dev server`), enter `http://localhost:8000` as **Server address**,
   **Add server**, then sign in with `admin@switch.local` and the password from step 1.
   Console notices the Mattermost that `switch-setup` connected and shows it as linked;
   **Done**.
3. Create an agent: **Your Agents → +** (the dashed tile). Name it, pick a working
   directory, and choose the CLI you have signed in under **Agent provider**. The form
   says `This server does not have agent management turned on, so this Console runs the
   agent` — expected on a dev server, see below.
4. Create a room: **Your Rooms**, create one, add the agent, and send it a message such as
   `Say hello and tell me which model you are.`

The reply arrives in the room, and the same room shows up in the dashboard at
`http://localhost:5173` under Rooms. That round trip (Console → switch-core → agent →
switch-core → room) is what most changes to Switch touch.

Two things a dev server from `.env.example` does **not** have on, because
`FEATURE_FLAGS_ENABLED` is empty by default: **agent management** (machines running
the headless agent controller, the Machines page) and **switch-buddy** (the assistant
Console creates on its own local server). Turn them on only when you work on them:
`FEATURE_FLAGS_ENABLED=agent_management,switch_buddy` plus a `CONTROLLER_TOKEN_SECRET`
in `.env`, then restart `just run`. The comments in `.env.example` list every flag.

## 5. Where things live

| Path | What is there | Run its tests with |
|---|---|---|
| `core/switch_core/` | switch-core, the Python backend: the agent bridge, rooms, messaging platforms, connectors, the gateway management API | `just test` (pytest, needs the Postgres from `just up`) |
| `core/tests/` | The backend test suite, mirroring `switch_core/` | `just test -k <name>` for one test |
| `gateway/` | The operator dashboard (React + Vite) | `just gateway-test` |
| `console/` | Switch Console, an Electron app in a pnpm workspace: `apps/switch-console-desktop/` is the app, `packages/` the libraries it shares with the agent controller | `pnpm test` inside `console/` |
| `console/packages/agent-controller/` | The headless agent controller (`switch-agent-controller`) | `pnpm test` inside that folder |
| `deploy/` | Docker Compose stacks (`local/`) and the Helm chart (`remote/`) | — |
| `docs/` | `contributing/` (pages like this one), `old/` (internal references); `official/` is generated from another repository: do not edit it | — |
| `examples/` | Agent templates (`.template.yaml`) and sample agents | — |
| `justfile` | Every command on this page | `just` lists them |

For how the pieces talk to each other, read `docs/official/internals/index.md`
(read-only here, edited elsewhere) and `docs/old/LOCAL_DEVELOPMENT.md` for the ports and
processes of the dev setup.

## 6. Make a change and run the tests

Work on a branch of your fork:

```bash
git checkout -b my-change
# edit…
just format        # ruff: format and autofix
just check         # ruff: the same checks CI runs ("All checks passed!")
just typecheck     # mypy
just test          # the backend suite; `just test -k name` for one test
```

`just test` needs the PostgreSQL from `just up`: store tests run against a real database,
not mocks. The full suite is large (around ten thousand tests); while iterating, run the
one you are working on with `-k`, as in `just test -k test_config_feature_flags -q`
(`3 passed, 9782 deselected` in about twenty seconds).

For a change in `gateway/`, `just gateway-test`; in `console/`, `pnpm test` from the
package you changed. For a docs-only change, there is nothing to run: check the Markdown
renders and the links resolve.

## 7. Open the pull request

1. Commit and push the branch to your fork, then open a pull request against
   `sandbox-quantum/switch` `main`.
2. In the description, say what changed and why, link the issue (`Closes #123`), and
   name the OS you tested on.
3. The first time, a bot asks you to sign the Contributor License Agreement: reply to the
   PR with the exact sentence it quotes (`I have read the CLA Document and I hereby sign the CLA`).
   You sign once; it covers every later contribution.
4. Before asking for review, `just check`, `just typecheck` and `just test` pass locally,
   as [CONTRIBUTING.md](../../CONTRIBUTING.md#testing) asks.

Adding an agent CLI or a messaging platform has its own checklist:
[console/docs/new-agent-cli.md](../../console/docs/new-agent-cli.md) and
[docs/contributing/new-messaging-platform.md](new-messaging-platform.md).

## If something does not match

- **`uv sync` says `No pyproject.toml found`.** You ran it at the repository root; use
  `uv sync --project core`.
- **`just up` complains about `DB_OWNER_USER` / `DB_OWNER_PASSWORD`.** Your `.env`
  predates the two database roles. Run `just init-env` on a fresh `.env`, or add both
  variables as `.env.example` shows, then `just reset` so the volume is rebuilt.
- **`localhost:5173` shows nothing.** `just gateway-dev` is not running; `just run` alone
  serves the API at `:8000` only.
- **Console refuses the server address.** You pasted `:5173`; use `http://localhost:8000`.
- **Windows: `just run` stops with `CatalogError: Connection airtable SKILL.md needs
  frontmatter …`, or tests fail on `SKILL.md` files.** CRLF line endings in your clone; see
  the line-endings note under Prerequisites.
- **Windows: `just` says `could not find cygpath`.** You are in PowerShell or `cmd`; run it
  from Git Bash.
- **Windows: Console's agent form says every provider is `Not supported here`, and
  Settings → Agent providers shows `CLI not installed` under a CLI it also reports as
  `Installed`.** Seen with Console 0.40.1 and an OpenCode installed by npm
  (`%APPDATA%\npm\opencode.cmd`): the console's own check finds the CLI, but the embedded
  controller that would run the agent does not, even after choosing the `.cmd` under
  **⋯ → Change source** and restarting Console. The server side of this page is unaffected;
  create the agent from a macOS/Linux Console, or from a CLI installed as a native
  executable, until this is fixed.
- **Something else.** Say so in the issue you are working on, with your OS and
  `git rev-parse --short HEAD`. Switch changes fast and this page will be behind now and
  then; a note from you is how it gets fixed.

### Building Switch Console from source

Only needed when you change the Console itself. It is a pnpm workspace and needs
**Node 24 or newer** and **pnpm 10.28 or newer** (`console/package.json` `engines`):

```bash
cd console
pnpm install
pnpm run dev      # builds the shared packages, then starts the Electron app with hot reload
```

`console/AGENTS.md` has the developer notes for the app.
