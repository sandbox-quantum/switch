# Quickstart for new contributors

One path from a clone to a change you can see: Switch running on your machine,
Switch Console pointed at it, and an agent answering you in a room.

There are other ways to do most of the steps below. This page gives you one of
them, so you have nothing to choose between. Once it works, read
[`docs/old/LOCAL_DEVELOPMENT.md`](../old/LOCAL_DEVELOPMENT.md) for the fuller
account.

**Switch changes fast.** Recipes, ports and screens move between releases, and
a page like this goes out of date before anyone notices. If a step does not
match what you see, that is worth reporting rather than working around: open an
issue at
[github.com/sandbox-quantum/switch/issues](https://github.com/sandbox-quantum/switch/issues),
or say so on the issue you are working from. Say which step, what you ran, and
what happened instead.

## Before you start

Install these first. The versions are the ones the repository pins.

| Tool | Version | Where the version comes from |
| --- | --- | --- |
| [Docker](https://docs.docker.com/get-docker/) | Any current release, with Compose | `deploy/local/docker-compose.yml` |
| [uv](https://docs.astral.sh/uv/) | Any current release | — |
| [just](https://github.com/casey/just) (`brew install just`) | Any current release | — |
| Python | 3.12 or later | `requires-python` in `core/pyproject.toml` |
| Node.js | 24.14.0 | `console/.nvmrc` |
| pnpm | 10.28.2 | `packageManager` in `console/package.json` |

You do not need to install Python yourself — uv uses a suitable interpreter if
your machine has one and fetches a matching one if it does not.

Install `just` before you start, and check it with `just --version`. Nothing
below warns you about it in order: `uv sync --project core` is not a `just`
recipe, so it succeeds, and you only find out at `just gateway-install`, which
stops with `bash: just: command not found`.

Node 24.14.0 covers both frontends: Switch Console needs it, and the gateway
accepts it (`engines` in `gateway/package.json`). Switch Console uses pnpm; the
gateway uses npm, which ships with Node.

For the last step — an agent that actually replies — you also need one agent
provider CLI installed and signed in: Claude Code, Codex or OpenCode. Switch
starts the provider you already use under your own credentials; it ships no
agent of its own. Switch Console can install the CLI for you, but not the
account.

## 1. Clone the repository and install dependencies

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch
just init-env
uv sync --project core
just gateway-install
```

`just init-env` copies `.env.example` to `.env` and fills every secret field —
they ship blank, so no default credential can reach a running stack. It prints
the gateway admin login it generated. Keep that terminal, or read
`GATEWAY_ADMIN_EMAIL` and `GATEWAY_ADMIN_PASSWORD` out of `.env` later. The
recipe refuses to touch an `.env` that already exists, so it never rotates
secrets under a running stack.

**`uv sync` on its own does not work here.** The Python project lives in
`core/`, and there is no `pyproject.toml` at the repository root, so a plain
`uv sync` fails with `No pyproject.toml found in current directory or any
parent directory`. Use `--project core`, which is what every `just` recipe
does. Some older pages still say plain `uv sync`; that is
[issue #1357](https://github.com/sandbox-quantum/switch/issues/1357).

`just gateway-install` runs `npm install` in `gateway/`. It is a first-time
step only.

## 2. Start the stack

Two terminals, both at the repository root.

```bash
just up     # terminal 1: Postgres and Mattermost, in Docker
just run    # terminal 2: switch-core on :8000
```

`just up` starts the **supporting services only** — PostgreSQL, Mattermost, and
a one-shot `setup` container. It does not start switch-core and it does not
start the gateway frontend. You run those yourself so each reloads as you edit.

**You do not need `just migrate` here.** `just run` applies migrations at
startup: `DB_MIGRATE_ON_BOOT` defaults to `true`
(`core/switch_core/config.py`), so `main()` migrates before it serves. Watch
for `Database migrations applied as postgres` in its log. `just migrate` still
exists for running them by hand, and a deployment that migrates in a separate
step turns `DB_MIGRATE_ON_BOOT` off. Some older pages say `just run` does not
migrate and will fail against a database that is behind; that is also
[issue #1357](https://github.com/sandbox-quantum/switch/issues/1357).

Start `just run` soon after `just up`. The `setup` container registers the
local Mattermost as a collaboration bridge by calling switch-core's gateway
API, so it waits for switch-core to answer on `:8000` before it can finish. It
retries for five minutes. If it gave up, run `just up` again once switch-core
is serving.

Stop the stack with `just down`. Use `just reset` to also wipe the volumes and
start from an empty database.

## 3. Open the gateway

The gateway is the operator dashboard. It is a separate Vite dev server, and
nothing starts it for you.

```bash
just gateway-dev    # terminal 3: the dashboard on :5173
```

Open `http://localhost:5173` and sign in with the `GATEWAY_ADMIN_EMAIL` and
`GATEWAY_ADMIN_PASSWORD` from your `.env`.

Which address is which:

| URL | What is there | Started by |
| --- | --- | --- |
| `http://localhost:5173` | The operator dashboard. Open this in a browser. | `just gateway-dev` |
| `http://localhost:8000` | switch-core: the Agent Bridge API, the MCP server, and the gateway management API under `/gateway/*`. JSON, not a UI. | `just run` |
| `http://localhost:8065` | Mattermost, seeded as the local messaging app. | `just up` |
| `127.0.0.1:8081` | Not a page: where the Mattermost bridge takes callbacks. Nothing else may hold this port. | `just run` |

Going to `http://localhost:8000` in a browser expecting a dashboard gets you
raw JSON. That is a development default, not how a deployed server works.

**Port 8081 has to be free**, and nothing tells you so until the bridge dies.
If something else on your machine already has it, `just run` still starts and
answers on `:8000`, but the bridge crashes behind it:

```
OSError: [Errno 48] error while attempting to bind on address ('0.0.0.0', 8081)
```

and agents never see anything you type in Mattermost. Either free the port, or
put `COLLABORATION_CALLBACK_PORT=8091` in your `.env` and restart `just run`.
Moving it costs you the buttons on approval cards — the address Mattermost
calls back on is fixed at `8081` in `deploy/local/docker-compose.yml` — but
mentions and replies, which is what this page needs, work either way.

## 4. Build and run Switch Console

Switch Console is the desktop app contributors and users manage agents from. It
is a pnpm workspace under `console/`, with its own root.

```bash
cd console
pnpm install
pnpm run dev
```

`pnpm run dev` builds the workspace packages once, then runs the package watch
builds and the Electron app together. The first run takes a while; later ones
do not.

Run it from a terminal you are sitting at, not through `nohup` or a detached
shell. On macOS, Console stores your session in the system keychain, and a
process the window server does not own cannot create that keychain item or
raise the dialog that asks you to allow it.

The first screen asks **How do you want to run Switch?**, with **On this
computer** already selected. Do not take it: that installs a second server and
leaves the one you just started with `just up` and `just run` unused. Choose
**Join an existing server**, select **Continue**, and enter
`http://localhost:8000` — switch-core's address, not the dashboard's. If you
paste `http://localhost:5173` by mistake, Console refuses it when you save,
because that address answers with a web page rather than the API. Sign in with
the same gateway admin login you used in step 3.

If the sign-in button appears to do nothing, look for a macOS keychain prompt
behind the window and allow it. Console signs you in and then stores the
session, so the server accepts the login (`POST /gateway/auth/login` returns
200 in `just run`'s log) while the app shows you nothing. The failure is
`Secure secret storage is unavailable on this system.`

## 5. Create an agent and a room, and get a reply

All of this is in Switch Console, against the server you just added.

1. **Check your agent provider.** Open **Settings**, then **Agent providers**,
   and confirm your provider reads **Installed**. Install it from there if it
   does not.
2. **Create an agent.** In the sidebar, select **Your Agents**, then the card
   with a plus on it. Leave the run location local, pick your provider, and
   choose a working directory the agent may read — your clone of this
   repository is a reasonable choice. Names take lowercase letters, digits,
   `.`, `-` and `_`, and must start with a letter or a digit; the convention is
   `provider.job.owner`, so `claude-code.quickstart.yourname` fits. A
   **Description** is required too. Leave everything else alone.
3. **Create a room.** Select **Your Rooms**, then **+ New Room** in the list
   below it. Choose the Mattermost that `just up` started as the messaging
   app, name the room, add the agent you just created, and select **Create
   room**.
4. **Open the room in Mattermost.** Go to `http://localhost:8065` and sign in
   as the `MATTERMOST_USER` and `MATTERMOST_USER_PASSWORD` from your `.env`.
   That account is linked to the gateway admin by `just up`'s `setup`
   container, which is what makes the agent treat you as its owner — a new
   agent answers only its owner by default.
5. **Ask the agent something.** Mention it by name and ask for something only
   its working directory could tell you, such as what a particular file
   contains. Switch starts a session for an agent that is addressed and has
   none running, so the first reply may take a moment.

A generic answer that could have come from anywhere means the agent is not
reading the directory you think it is. A reply saying no session is connected
means Switch answered on the agent's behalf; check that Switch Console is still
running.

## 6. Where things live

| Path | What it is |
| --- | --- |
| `core/` | The backend tree: a self-contained Python project with its own `pyproject.toml`, `uv.lock` and `alembic.ini` |
| `core/switch_core/` | The service package — config, the database layer, rooms, message delivery, and the agent, collaboration and resource bridges |
| `core/tests/` | The test suite, mirroring the `switch_core/` module structure |
| `gateway/` | The operator dashboard frontend (React, Vite, npm) |
| `console/` | Switch Console: a pnpm workspace with the Electron app in `apps/` and shared packages in `packages/` |

[Repository layout](../../CONTRIBUTING.md#repository-layout) in CONTRIBUTING
lists the rest. [`console/AGENTS.md`](../../console/AGENTS.md) is the developer
guide for working inside Switch Console, and
[`docs/official/internals/`](../official/internals/index.md) explains how
Switch works.

## 7. Run the tests

Backend, from the repository root:

```bash
just test                 # the suite
just test -k test_name    # one test
```

`just test` leaves out the integration and benchmark tests, which are slow and
need Docker. Run those with `just test-integration` and `just bench` when your
change touches what they cover.

Switch Console, from `console/`:

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

The gateway has `just gateway-test`.

## 8. Before you open a pull request

Run these from the repository root and make sure they pass:

```bash
just check       # ruff format --check and ruff check
just typecheck   # mypy over core/switch_core/
just test        # the backend suite
```

If you changed anything under `console/`, run that app's own checks too
(`pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`,
`pnpm run test` from `console/`).

Fill in the pull request template: what the change does, and what you ran to
test it. Delete the sections that do not apply to your change.

**Sign the CLA once.** Every contributor agrees to the
[Contributor License Agreement](../../CLA.md) before anything is merged. You do
not do this in advance: open your pull request, wait for the CLA assistant to
comment on it, and reply with the exact sentence it asks for:

> I have read the CLA Document and I hereby sign the CLA

Your signature is recorded automatically and covers everything you contribute
afterwards. If you contribute on behalf of a company, your employer can sign
the Corporate CLA instead — see
[Contributor License Agreement](../../CONTRIBUTING.md#contributor-license-agreement-required)
in CONTRIBUTING.

## Next steps

- [CONTRIBUTING](../../CONTRIBUTING.md) — the full command list, the repository
  layout, and how a change gets merged
- [`docs/old/LOCAL_DEVELOPMENT.md`](../old/LOCAL_DEVELOPMENT.md) — the longer
  version of this setup: every port, the two database roles, and running
  switch-core as a stand-in for Switch Cloud
- [Adding support for a new messaging platform](new-messaging-platform.md) and
  [Adding support for a new agent CLI](../../console/docs/new-agent-cli.md) —
  two well-marked first contributions
