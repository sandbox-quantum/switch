# Switch Contributor Quickstart

Get a local Switch development environment running and prepare to contribute.

> **Time:** Allow around 15 minutes after prerequisites are installed. First-time dependency downloads and Docker image pulls can take longer.

## 1. Prerequisites

Install the following:

- [Git](https://git-scm.com/)
- [Docker Desktop](https://docs.docker.com/get-docker/) with Docker Compose
- [uv](https://docs.astral.sh/uv/)
- [just](https://github.com/casey/just)
- Bash and OpenSSL (required by the environment setup script)

On Windows, use Docker Desktop with its WSL 2 backend and make sure Git Bash and OpenSSL are available. Run the commands from PowerShell at the repository root.

The backend requires Python 3.12 or newer.

## 2. Clone the repository

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch
```

If you already cloned the repository, open a terminal at its root.

## 3. Configure the environment

Generate your local environment file and development secrets:

```bash
just init-env
```

This creates `.env` with randomly generated local secrets. It will not overwrite an existing `.env` file.

**Never commit `.env` or share its secrets.**

## 4. Install backend dependencies

The Python project is inside `core/`. From the repository root, run:

```bash
uv sync --project core
```

## 5. Start supporting services

Start PostgreSQL and Mattermost:

```bash
just up
```

Wait for the services to start successfully.

## 6. Apply database migrations

```bash
just migrate
```

Run migrations after starting the services and whenever you pull changes that introduce new database migrations.

## 7. Start Switch Core

```bash
just run
```

Switch Core runs at:

- API: `http://localhost:8000`

Keep this terminal open while developing.

At this point, your backend development environment is running.

## 8. Optional: Run the Gateway

The Gateway is the operator dashboard frontend. Open another terminal at the repository root:

```bash
just gateway-install
just gateway-dev
```

The Gateway development server runs separately, by default at:

- Gateway: `http://localhost:5173`

## 9. Optional: Run Switch Console

Switch Console is the desktop application. It is not required for backend development.

Requirements:

- Node.js `24.14.0` (see `console/.nvmrc`)
- pnpm `10.28.2`

Open another terminal:

```bash
cd console
pnpm install
pnpm run dev
```

The first launch builds workspace packages and the desktop sidecar before starting the application. It may take longer than subsequent launches.

In Console, add a server using:

```text
http://localhost:8000
```

### Create your first agent and room

1. In Switch Console, open **New agent**.
2. Enter an agent name and description.
3. Choose an available **Agent provider**. The provider CLI must be installed and signed in on the selected run location.
4. Set **Run location** to **This computer** and select your local Switch server.
5. Click **Add agent**.
6. Create a room using **New room**, enter a room name, and add your agent under **Participants**.
7. Send a message that @mentions your agent by name.

Agents answer only when someone @mentions them in a room. If the agent does not respond, check its provider installation, sign-in, and available provider quota.

To create an agent, first install and sign in to a supported agent CLI. See [Adding a new agent CLI](../../console/docs/new-agent-cli.md).

## 10. Useful commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `just up` | Start PostgreSQL and Mattermost |
| `just down` | Stop supporting services |
| `just reset` | Stop services and delete local database volumes |
| `just migrate` | Apply database migrations |
| `just run` | Start Switch Core |
| `just check` | Run formatting and lint checks |
| `just typecheck` | Run Python type checks |
| `just test` | Run backend tests |
| `just gateway-dev` | Start the Gateway development server |
| `just gateway-build` | Build the Gateway frontend |

When working on Switch Console, run these from `console/`:

| Command | Purpose |
| --- | --- |
| `pnpm run test` | Run Console workspace tests |
| `pnpm run lint` | Run Console lint checks |
| `pnpm run typecheck` | Run Console type checks |
| `pnpm run format` | Format Console workspace code |

**Warning:** `just reset` deletes local database volumes and local development data.

## 11. Troubleshooting

### Docker services do not start

- Make sure Docker Desktop is running.
- On Windows, check that the WSL 2 backend is enabled.
- Inspect logs with:

```bash
docker compose -f deploy/local/docker-compose.yml logs
```

### Environment setup fails

- Check that Bash and OpenSSL are available in your PATH.
- Run `just init-env` from the repository root.
- If `.env` already exists, inspect it before deciding whether to replace it.

### Database or migration errors

- Make sure `just up` completed successfully.
- Check the database credentials in `.env`.
- Run `just migrate` before starting the backend.
- Remember that `just run` does not apply migrations automatically.

### Console cannot connect

- Make sure Switch Core is running.
- Add `http://localhost:8000` as the server address.
- Check server connectivity before troubleshooting agent CLI authentication.

## Repository map

| Path | What lives here |
| --- | --- |
| `core/` | Python backend and tests |
| `console/` | Switch Console desktop application |
| `gateway/` | Operator dashboard frontend |
| `deploy/` | Local Docker Compose and deployment assets |
| `docs/` | Project documentation |
| `justfile` | Common development commands |

## Before opening a pull request

- Run `just check`, `just typecheck`, and `just test` from the repository root.
- If you changed Console, run the relevant checks from `console/`.
- Include a clear description of the change, related issue, and screenshots when they help explain UI changes.
- Complete the Contributor License Agreement (CLA) when the automated PR check requests it. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Switch changes fast

Switch is actively evolving, so commands and UI labels may change. If a step in this guide no longer matches the current code, check the relevant documentation or ask in the related GitHub issue before proceeding.

## 12. Next steps

- Read the [contribution guide](../../CONTRIBUTING.md).
- Explore the [local development guide](../old/LOCAL_DEVELOPMENT.md).
- Browse the [documentation index](../README.md).


Happy contributing!