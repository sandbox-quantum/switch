# Five-minute quickstart: from clone to first change

This page takes you from a fresh clone to an agent answering in a room, and
shows you where to make your first change. It assumes you have **Docker**,
[**uv**](https://docs.astral.sh/uv/), [**just**](https://github.com/casey/just)
(`brew install just`), and — for the desktop app — **Node 24+** and
**pnpm 10.28+** (`npm install -g pnpm`, or `corepack enable`).

If you only want to see Switch running rather than develop against it, the
[standalone stack](https://docs.switchagents.ai/flintai/switch/deploy/self-host)
is a shorter path — one Compose file, no host toolchain. Everything below is
the development path: hot-reload on both the backend and the frontend.

## 1. Generate your `.env`

```bash
just init-env
```

This copies `.env.example` to `.env` and fills every secret field that ships
blank (`DB_PASSWORD`, `DB_OWNER_PASSWORD`, `AGENT_REGISTRATION_TOKEN`,
`GATEWAY_ADMIN_PASSWORD`, the `MATTERMOST_*` passwords) with a fresh
`openssl rand -hex 24` value, then prints the gateway admin login it just set.
There is no default `admin`/`admin` to leak into a running stack. The recipe
refuses to touch an existing `.env`, so re-running it never rotates secrets out
from under a stack that's already up.

`just` loads `.env` automatically for every recipe, so nothing else needs to
source it.

## 2. Install dependencies

```bash
uv sync                  # Python dependencies for core/
just gateway-install     # gateway frontend deps (first time only)
```

## 3. Start the stack

```bash
just up                  # PostgreSQL + Mattermost (Docker Compose)
just migrate             # apply database migrations
```

**`just up` starts the supporting services only** — PostgreSQL, Mattermost
(seeded as the local collaboration bridge) and a one-shot setup container that
provisions the Mattermost accounts named by your `MATTERMOST_*` variables. It
does not start switch-core and does not start the dashboard; you run both
yourself so each gets hot-reload.

> **If `just up` refuses with a message about `DB_OWNER_USER` /
> `DB_OWNER_PASSWORD`:** your `.env` predates the two-database-roles split.
> Add both owner variables, set `DB_USER=switch_app` (see `.env.example`), and
> run `just reset` to rebuild the Postgres volume from scratch — the runtime
> role is only created on a fresh volume.

## 4. Run switch-core and the dashboard

Two more terminals:

```bash
just run                 # switch-core on :8000 (terminal 1)
just gateway-dev         # operator dashboard on :5173 (terminal 2)
```

**The part that's easy to miss: `just gateway-dev`.** Nothing warns you that
the dashboard isn't running. Open `http://localhost:5173` for the operator
dashboard; `http://localhost:8000` is the raw JSON API (the Agent Bridge API,
the MCP server, and the gateway management API under `/gateway/*` — one
process, no separate backend).

| URL | What's there |
|---|---|
| `http://localhost:5173` | Operator dashboard (Vite dev server) |
| `http://localhost:8000` | switch-core: Agent Bridge API + gateway management API |
| `http://localhost:8065` | Mattermost, seeded as the local bridge |
| `http://localhost:5432` | PostgreSQL |
| `http://localhost:8025` | Mailpit (only with `just local-cloud`) |

Stop everything with `just down`; `just reset` also wipes the volumes.

## 5. Build Switch Console and point it at your server

In a third terminal, from `console/`:

```bash
pnpm install
pnpm dev
```

Console connects to a Switch server by one address: switch-core's. In Console,
add a server, choose **Connect to an existing server**, and enter
`http://localhost:8000`. Pasting `http://localhost:5173` by mistake is
refused — the dashboard answers with a web page, not the API.

Two notes on the dashboard from Console: switch-core serves the admin
dashboard itself only when `GATEWAY_UI_DIR` names a built dashboard. Without
it, Console's **Open** button loads a bare JSON response instead of the UI —
either build the dashboard once (`just gateway-build`) and run with
`GATEWAY_UI_DIR=gateway/dist`, or just keep `localhost:5173` open in a browser.

## 6. Create an agent and a room, and get a reply

The published [getting-started
guide](https://docs.switchagents.ai/switch-rooms/getting-started) walks the
full end-user path — install Console, check your agent provider, add a server,
create an agent from a template, and get a reply in a room. For local
development the short version is:

1. **Sign in to the dashboard** at `localhost:5173` with the gateway admin
   login `just init-env` printed.
2. **Set up an agent provider.** A provider CLI (`claude`, `codex`,
   `opencode`, …) installed on your `PATH` and signed in as your own user, or
   its API key in the environment. Switch coordinates agents; it does not ship
   one.
3. **Create an agent** from the dashboard (or a template from
   [`examples/agent-templates/`](https://github.com/sandbox-quantum/switch/tree/main/examples/agent-templates))
   and **create a room**. The local Mattermost at `localhost:8065` is already
   bridged, so a room works with zero external accounts.
4. **Mention the agent in the room** and watch it answer. Two first-reply
   pitfalls worth knowing: an agent ignores a message that doesn't address it
   with `@` and its exact name (no error is shown), and Console reads your
   `PATH` once, when it starts — a provider CLI installed afterwards needs a
   Console restart. That reply is your smoke test: if it arrives, the core,
   the bridge, the agent host and the provider are all wired correctly.

## Where things live

| Path | Contents |
|---|---|
| `core/` | Backend — a self-contained Python project (`pyproject.toml`, `uv.lock`, `alembic.ini`) |
| `core/switch_core/` | The main Python service package |
| `core/tests/` | Test suite, mirroring the module structure |
| `gateway/` | Operator dashboard frontend (Node/Vite) |
| `console/` | The Switch Console desktop app (pnpm monorepo) |
| `deploy/` | Compose stacks (`local/`), the Helm chart (`remote/`), shared images |
| `docs/official/` | Published documentation — **generated**, edit the source in the docs repo, not here |
| `docs/contributing/` | Contributor guides — this page lives here |
| `justfile` | Repo-root task runner; run `just` with no arguments to list every recipe |

## Running the tests

Before opening a pull request, run all three:

```bash
just check        # ruff format --check + ruff check (CI mode, no changes)
just typecheck    # mypy over core/switch_core/
just test         # pytest core/tests/; just test -k name for one test
```

For the Console packages (`console/`): `pnpm test`, `pnpm lint`,
`pnpm typecheck`, `pnpm format:check`.

Store tests run against a real PostgreSQL instance (not mocks, not SQLite),
which is why the stack has to be up.

## The PR checklist

1. One change per pull request — don't refactor on the way through.
2. `just check`, `just typecheck` and `just test` all pass locally.
3. Sign the CLA on your first PR: reply to the CLA assistant's comment with
   the exact sentence `I have read the CLA Document and I hereby sign the CLA`.
   It's one-time and covers all your later contributions.
4. Link the issue your PR closes with `Closes #number` in the description.
5. Adding an agent CLI or a messaging platform? Your PR also has to show a
   real-CLI test summary and a short video — see
   [`console/docs/new-agent-cli.md`](https://github.com/sandbox-quantum/switch/blob/main/console/docs/new-agent-cli.md)
   and
   [`docs/contributing/new-messaging-platform.md`](https://github.com/sandbox-quantum/switch/blob/main/docs/contributing/new-messaging-platform.md).

## Switch changes fast

Expect moving parts. Recipes get renamed, ports get reused, and the Console
build takes a few minutes the first time. If something on this page doesn't
match what you see, that's a bug in this page — open an issue or a PR and
we'll fix it. The WeMakeDevs Discord is open during the Flip the Switch
hackathon if you're stuck on setup.
