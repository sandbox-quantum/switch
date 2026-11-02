# Switch Contributor Quickstart

Get a local Switch development environment running and prepare to contribute.

> **Time:** A five-minute starting guide. First-time setup, dependency downloads, and Docker image pulls can take longer.

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

## 12. Next steps

- Read the [contribution guide](../../CONTRIBUTING.md).
- Explore the [local development guide](../old/LOCAL_DEVELOPMENT.md).
- Browse the [documentation index](../README.md).
- Before opening a pull request, run `just check`, `just typecheck`, and `just test`.

Happy contributing!