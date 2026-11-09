# Quickstart for contributors

From a fresh clone to an agent answering you in a room, then to your first
change. It takes about 15 minutes once the prerequisites are installed.

Switch changes fast. If a step here doesn't match what you see, say so in the
issue you're working on (or open one): the docs are probably behind the code,
and that report is useful in itself.

This page is the short path. The fuller account of each step, every port and
every recipe is in [LOCAL_DEVELOPMENT.md](../old/LOCAL_DEVELOPMENT.md).

## Which machine

switch-core runs on **Linux and macOS**. On **Windows, use WSL 2** (Ubuntu is
fine) and run every command below inside it, from a clone in the Linux file
system (`~/switch`, not `/mnt/c/...`):

- switch-core imports Python's `resource` module, which exists only on Unix,
  so on native Windows `just run` and `just test` stop with
  `ModuleNotFoundError: No module named 'resource'`.
- The `just` recipes are bash scripts, and `just init-env` needs `openssl`.
- A Windows checkout can turn `\n` line endings into `\r\n`, which some
  files that tests read do not accept.

Switch Console is the exception: it is a desktop app, so on Windows build and
run it natively, from a Windows checkout (see [step 4](#4-run-switch-console)).

## 1. Install the prerequisites

| Tool | Used for | Check |
|---|---|---|
| [Docker](https://docs.docker.com/get-docker/) with Compose (on Windows, Docker Desktop with WSL integration on) | Postgres and Mattermost | `docker compose version` |
| [uv](https://docs.astral.sh/uv/) | Python and switch-core's dependencies | `uv --version` |
| [just](https://github.com/casey/just) | Every task in this repo | `just --version` |
| [Node.js](https://nodejs.org/) 24 or later, and [pnpm](https://pnpm.io/) 10.28 or later | Switch Console and the gateway dashboard | `node --version`, `pnpm --version` |
| git, bash and openssl | Cloning, and the `just` recipes | already on Linux and macOS |

uv installs the Python version switch-core needs by itself.

## 2. Clone and configure

```bash
git clone https://github.com/<your-user>/switch.git   # your fork
cd switch
just init-env     # writes .env with fresh random secrets
uv sync --project core
```

`just init-env` copies `.env.example` to `.env`, fills in every password and
key, and prints the gateway admin login. Keep that login. The recipe refuses to
overwrite an existing `.env`; delete it first if you really want new secrets.

## 3. Start the server

```bash
just up     # Postgres and Mattermost, in Docker
just run    # switch-core on http://localhost:8000; leave it running
```

`just up` starts only the supporting services. switch-core is the process
`just run` starts, and it migrates the database itself when it boots. It is
ready when the log stops scrolling and `http://localhost:8000` answers with
JSON; there is no web page there.

For the operator dashboard, in a second terminal (optional for this
quickstart):

```bash
just gateway-install   # first time only
just gateway-dev       # http://localhost:5173
```

Sign in there with the gateway admin login from step 2.

Mattermost, the local messaging app, is at `http://localhost:8065`. Sign in
with `MATTERMOST_USER` and `MATTERMOST_USER_PASSWORD` from `.env` to chat as
a normal user.

## 4. Run Switch Console

```bash
cd console
pnpm install
pnpm run dev
```

The first build takes a few minutes. When the app opens, add a server, choose
**Connect to an existing server**, and enter `http://localhost:8000` (not
`:5173`, which Console refuses). Sign in with the gateway admin login.

On Windows, Console runs natively and still reaches the server in WSL 2 at
`http://localhost:8000`, because WSL forwards `localhost` to Windows by
default.

## 5. See an agent answer in a room

You need one agent CLI installed and signed in on your machine: Claude Code,
Codex, OpenCode, Cursor CLI or Antigravity. Then, in Switch Console:

1. Create an agent on that CLI
   ([Set up agent providers](../official/getting-started/set-up-agent-providers.md),
   [Onboard your agents](../official/getting-started/onboard-your-agents.md)).
2. Create a room, choosing Mattermost as its messaging app, and add the agent
   to it
   ([Create a room](../official/getting-started/create-a-room.md)).
3. In Mattermost, write `@<agent-name> hello` in that room's channel. The
   agent's session starts and it replies in the channel.

If nothing comes back, the `just run` terminal and the agent's session in
Console usually say why. [Smoke test](../official/getting-started/smoke-test.md)
walks through what a working setup looks like.

## 6. Find where to make your change

| Path | What lives there |
|---|---|
| `core/switch_core/` | The server (Python): rooms, message delivery, the Agent Bridge, the messaging bridges, connectors |
| `core/tests/switch_core/` | Its tests, mirroring the package layout |
| `console/` | Switch Console (Electron, TypeScript), and the agent providers in `console/packages/agent-providers/` |
| `gateway/` | The operator dashboard (Vite, TypeScript) |
| `docs/` | `official/` is synced from the docs repository, so edit it there, never here. The other folders are notes for contributors. |

Guides for the common kinds of contribution:

- a new agent CLI: [Adding support for a new agent CLI](../../console/docs/new-agent-cli.md)
- a new messaging platform: [Adding support for a new messaging platform](new-messaging-platform.md)
- a new connector: [Adding a connector](../design/service-connections-v2.md#adding-a-connector)

`CLAUDE.md` and `console/AGENTS.md` describe how the code is organized, and the
rules it follows, in more depth.

## 7. Check your change

For the server, from the repository root:

```bash
just format      # fix formatting and imports
just check       # what CI checks
just typecheck
just test        # needs `just up`: store tests use the real Postgres
just test -k some_test_name   # one test
```

For Switch Console, from `console/`:

```bash
pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test
```

For the dashboard: `just gateway-test`.

## 8. Open the pull request

- Work on a branch in your fork, and open the pull request against `main`.
- Fill in the template: **What this changes** and **How it was tested**. Delete
  the sections that don't apply to your change.
- Reference the issue (`Fixes #123`) so it closes when the pull request merges.
- The CLA bot comments on your first pull request. Reply with the sentence it
  asks for (see [CONTRIBUTING.md](../../CONTRIBUTING.md#contributor-license-agreement-required)).
- This repository is public, so keep credentials, internal hostnames and
  personal data out of code, tests, screenshots and the pull request.

To stop everything: `Ctrl+C` in the `just run` and `pnpm run dev` terminals,
then `just down`. `just reset` also wipes the database.
