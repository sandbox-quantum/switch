# Contributor quickstart

This guide takes you from a fresh checkout to a running local Switch development
stack, a connected Switch Console, and the first useful change. It complements
[CONTRIBUTING.md](../../CONTRIBUTING.md); use the longer
[local development guide](../old/LOCAL_DEVELOPMENT.md) when you need the full
port map or local-cloud setup.

## Prerequisites

Install these before starting:

- Git.
- Docker Engine or Docker Desktop, with Compose v2.
- [uv](https://docs.astral.sh/uv/).
- [just](https://github.com/casey/just).
- Node.js 24 or later and pnpm 10.28.2 or later for Switch Console.
  The Console workspace pins pnpm through Corepack; enable it with
  `corepack enable` if your Node installation provides Corepack.

Check the versions before cloning:

```bash
git --version
docker compose version
uv --version
just --version
node --version
pnpm --version
```

## 1. Clone and prepare the environment

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch
just init-env
uv sync
just gateway-install
```

`just init-env` creates a local `.env` with fresh random secrets. It refuses
to overwrite an existing file. Keep `.env` private; never commit it or paste
its values into an issue or pull request.

## 2. Start the local services

```bash
just up
just migrate
```

`just up` starts the supporting Docker services, including PostgreSQL and
Mattermost. It does **not** start switch-core or the Gateway frontend. Run
those in separate terminals:

Terminal 1:

```bash
just run
```

Terminal 2:

```bash
just gateway-dev
```

Open the Gateway at <http://localhost:5173>. The Agent Bridge and management
API are served by switch-core at <http://localhost:8000>. The local Mattermost
instance is at <http://localhost:8065>.

## 3. Connect Switch Console

From a separate terminal:

```bash
cd console
corepack enable
pnpm install
pnpm dev
```

The first build can take several minutes. When the desktop app opens, add a
server, choose **Connect to an existing server**, and enter:

```text
http://localhost:8000
```

Do not enter the Gateway's Vite address (`http://localhost:5173`): Console
needs the Agent Bridge address, not the browser UI.

## 4. Get an agent to answer

Install and sign in to at least one supported agent CLI on the machine running
the agent (for example Claude Code, Codex, OpenCode, Cursor or Antigravity).
In Switch Console, create an agent using that provider, then add it to a room
that is connected to a messaging platform. Mention the agent in the room and
confirm that its reply appears. The exact sign-in and room setup depends on
the provider and chat platform; follow the relevant
[getting-started documentation](https://docs.switchagents.ai/switch-rooms/getting-started).

If you are using the local Mattermost bridge, open
<http://localhost:8065> and use the local account created from the credentials
in your private `.env`. Do not copy those credentials into project files.

## 5. Find the code and run checks

| Path | What lives there |
|---|---|
| `core/` | Python service, agent bridge, Gateway API and backend tests |
| `gateway/` | Operator dashboard (Vite) |
| `console/` | Desktop app, provider integrations and shared TypeScript packages |
| `deploy/` | Local and remote deployment assets |
| `docs/` | Published documentation mirror and internal design references |

Before opening a pull request, run the checks relevant to your change:

```bash
just check
just typecheck
just test
```

For Console changes, run the package's tests and type checks from `console/`
(for example, `pnpm test` and `pnpm typecheck`). For a focused package,
use pnpm's `--filter` option rather than running the entire workspace.

## 6. Open a pull request

- Keep the change focused and link the issue it addresses.
- Add or update tests for changed behavior.
- Run formatting, lint, type checks and the relevant test suites; include the
  exact commands and results in the PR description.
- Include screenshots or a short recording for user-facing changes.
- Do not commit `.env`, credentials, tokens, database files or local build
  output.
- Follow the project's [Code of Conduct](../../CODE_OF_CONDUCT.md) and
  [Contributor License Agreement](../../CLA.md). The CLA bot explains the
  one-time signing step after you open your first PR.

## Troubleshooting

- **Docker cannot start:** confirm the Docker daemon is running and that your
  account can use it.
- **PostgreSQL is not ready:** check `docker compose ps`, then inspect the
  local service logs before retrying `just migrate`.
- **Console cannot reach Switch:** use `http://localhost:8000`, not port
  `5173`; check that `just run` is still running.
- **A command differs from this guide:** Switch changes quickly. Check the
  current `justfile`, package scripts and linked docs, then ask in the issue
  before guessing at a replacement command.

The command sequence above was cross-checked against the current repository
scripts and local-development guide. It has not been independently timed on a
clean machine; report your OS and any setup differences when you validate it.
