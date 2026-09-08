# Running Switch locally for development

This covers the local-development path only: everything runs on your own
machine, with hot-reload on the backend and the frontend. It's a different
shape from the two paths the published docs cover —
[`standalone`](../official/deploy/self-host.md) (single Docker Compose stack,
built images, no host toolchain) and the Helm chart — so don't reach for
those commands here; `just standalone-up` runs a whole different set of
containers and none of what follows applies to it.

Everything below is one recipe per `just` line, all defined in the root
[`justfile`](../../justfile). Run `just` with no arguments any time to see
the full list.

## Prerequisites

[Docker](https://docs.docker.com/get-docker/), [uv](https://docs.astral.sh/uv/),
[just](https://github.com/casey/just) (`brew install just`), and Node for the
gateway frontend.

```bash
just init-env            # first-time setup — generate .env with random secrets
uv sync                  # install Python dependencies (core/)
just gateway-install     # install gateway frontend deps (first time only)
```

`just init-env` copies `.env.example` to `.env` and fills every secret field
that ships blank — `DB_PASSWORD`, `AGENT_REGISTRATION_TOKEN`,
`JWT_SECRET_KEY`, `GATEWAY_ADMIN_PASSWORD`, `MATTERMOST_ADMIN_PASSWORD`,
`MATTERMOST_USER_PASSWORD` — with a freshly generated `openssl rand -hex 24`
value, then prints the gateway admin login it just set. The fields ship
blank on purpose: it means no default credential (the old `admin`/`admin`)
can ever reach a running stack by accident. The recipe refuses to touch an
existing `.env`, so re-running it never rotates secrets out from under a
stack that's already up — delete `.env` first if you actually want to
regenerate everything. `just` loads `.env` automatically for every recipe
below (`set dotenv-load := true` in the justfile), so nothing else needs to
source it.

## Starting the stack

```bash
just up      # start the supporting services (Docker Compose)
just migrate # apply database migrations
just run     # run switch-core (:8000)
just gateway-dev   # run the gateway frontend, in a separate terminal (:5173)
```

**`just up` starts the supporting services only**: PostgreSQL, Mattermost
(seeded as the local collaboration bridge), and a one-shot `setup` container
that provisions the Mattermost team/bot/admin accounts named by the
`MATTERMOST_*` variables. It does **not** start switch-core and does **not**
start the gateway frontend — you run both of those yourself, in their own
terminals, so each gets hot-reload while you work. `just down` stops the
stack; `just reset` also wipes its volumes (Postgres data included).

`just migrate` runs `alembic upgrade head` against the Postgres started by
`just up`. Run it once after the stack is up and again after pulling any
change that adds a migration — `just run` does not apply migrations itself
and will fail against a database that's behind.

`just run` starts switch-core (`python -m switch_core.main`) on
`SERVER_PORT` (`8000` by default). This one process is both the Agent Bridge
API (where agents and the MCP server connect) and the gateway management API,
mounted at `/gateway` on the same app — there is no separate backend process
for the dashboard.

### The part that's easy to miss: `just gateway-dev`

**`just up` does not start the gateway frontend, and nothing warns you.**
The operator dashboard you'd open in a browser is a separate Vite dev
server, started with `just gateway-dev` (`cd gateway && npm run dev`), and it
listens on **`:5173`**, not `:8000`. Forget to start it and there is simply
nothing at `localhost:5173`; go to `localhost:8000` instead expecting a UI
and you get switch-core's raw JSON API responses — it never serves the
dashboard's static assets, in dev or otherwise. In a standalone or Helm
deployment the dashboard is served by yet another process (the `gateway`
image, a separate container), so this is a permanent split, not a dev-mode
shortcut: switch-core is the API, something else is always the UI.

The Vite dev server proxies every `/gateway/*` request to
`http://127.0.0.1:8000` (see `gateway/vite.config.ts`), so from the browser's
point of view the dashboard and its API calls share one origin
(`localhost:5173`) even though two separate processes are actually serving
them. That's also why cookie-based gateway auth (including OIDC login, see
[`GATEWAY_OIDC_SETUP.md`](GATEWAY_OIDC_SETUP.md)) just works in dev without
any CORS configuration: as far as the browser can tell, it never left
`:5173`.

## Which URL is which

| URL | What's there | Started by |
| --- | --- | --- |
| `http://localhost:5173` | The operator dashboard (Vite dev server). Open this in a browser. | `just gateway-dev` |
| `http://localhost:8000` | switch-core: the Agent Bridge API, the MCP server, and the gateway management API under `/gateway/*`. JSON, not a UI. | `just run` |
| `http://localhost:8065` | Mattermost, seeded as the local collaboration bridge. | `just up` |
| `http://localhost:5432` | PostgreSQL. | `just up` |

`FRONTEND_BASE_URL` in `.env` (default `http://localhost:5173`) tells
switch-core where to send the browser back to after a flow that leaves the
dashboard, such as the OIDC login redirect — it should match wherever
`just gateway-dev` is actually listening.

## Connecting Switch Console to your local server

Switch Console (the desktop app) talks to a Switch server over two
addresses: a **Gateway URL** and an **API URL** — see [Add a
server](../official/getting-started/add-a-server.md) for what each field
means in general. Against a `just run` backend, both are the same thing:
`http://localhost:8000`. There's one process serving both surfaces, so there
is no separate gateway host to point at, and — unlike the browser dashboard
— Console never goes through the Vite dev server on `:5173` at all; it talks
to switch-core directly.

In Switch Console, add a server, choose **Connect to an existing server**,
and enter `http://localhost:8000` for both fields.

## Other useful recipes

| Command | What it does |
| --- | --- |
| `just format` / `just check` | Format with ruff / lint-check in CI mode (no changes) |
| `just typecheck` | mypy over `core/switch_core/` and `connectors/` |
| `just test` / `just test -k name` | Run the test suite / a single test |
| `just test-integration` | Integration tests against a real Postgres via testcontainers |
| `just migration "message"` | Autogenerate a new Alembic migration |
| `just gateway-build` | Build the gateway frontend's production bundle |
