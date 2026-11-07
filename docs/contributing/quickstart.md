# Contributor quickstart: clone to first reply

Run Core from your checkout, connect Switch Console, get a real agent reply,
then make a small change. First-time downloads determine setup time; this is
a short walkthrough, not a promise of a five-minute installation.

**Switch changes fast.** If a command or screen differs, ask in the
[issue tracker](https://github.com/sandbox-quantum/switch/issues), including
your OS, `git rev-parse HEAD`, the failing step and its error. Remove secrets.

## Choose the execution environment

Use bash on Linux or macOS for Core. On Windows 11, use **Ubuntu in WSL2**
with Docker Desktop's integration enabled for that distribution. Clone into
the Linux filesystem, for example under `~/src`, rather than reusing a Windows
checkout. Native Windows Core currently imports the Unix-only `resource`
module; Git Bash does not solve that failure.

Run Console on your desktop. On Windows, build it in a **separate Windows
checkout of the same commit**, using Windows Node/pnpm and a Windows provider
CLI. Keep Python environments and `node_modules` separate across the two OSes.

## 1. Check tools, then clone

Install missing tools using their linked instructions before continuing.

| Tool | Requirement and check |
| --- | --- |
| [Git](https://git-scm.com/downloads) | `git --version` |
| [Docker with Compose](https://docs.docker.com/get-docker/) | `docker compose version`; `docker info` must reach the daemon |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | `uv --version`; manages Python **3.12+** for `core/` |
| [just](https://github.com/casey/just#installation) | `just --version` |
| bash, OpenSSL, curl | `bash --version`, `openssl version`, `curl --version` |
| [Node](https://nodejs.org/en/download), [pnpm](https://pnpm.io/installation) | `node --version`, `pnpm --version` in the Console terminal |
| Agent CLI | Install and authenticate one supported provider, such as Claude Code or Codex, on the machine running Console |

Console pins **Node 24.14.0** in `console/.nvmrc` and **pnpm 10.28.2** in
`console/package.json` (minimums: Node 24, pnpm 10.28). Gateway uses **npm**,
not pnpm; its Node range is `^22.12.0 || ^24.0.0 || >=26.0.0`. Node 24 covers
both. Check tools in each OS separately; a Windows executable on WSL's PATH
is not a Linux tool installation.

From bash (Ubuntu on Windows):

```bash
mkdir -p ~/src
cd ~/src
git clone -c core.autocrlf=false https://github.com/sandbox-quantum/switch.git
cd switch
git rev-parse HEAD
just init-env
uv sync --project core
```

Expect a new `.env` with generated secrets and a populated `core/.venv`.
`just init-env` prints your gateway admin login; keep it private. Recover it
from `GATEWAY_ADMIN_EMAIL` / `GATEWAY_ADMIN_PASSWORD` in `.env` if needed.
Do not copy `.env.example` manually: its secrets are blank. There is no root
Python project, so plain `uv sync` at the root fails.

**Windows Console prerequisite:** before starting Core, edit the new `.env`
to set `FEATURE_FLAGS_ENABLED=agent_management`. Generate a separate secret
with `openssl rand -hex 32` and paste it into `CONTROLLER_TOKEN_SECRET`.
Keep this value private; `just init-env` does not generate it. This enables
the existing managed-agent path required to run an agent on a Windows PC.
Linux/macOS Console can use the default, unmanaged path without these changes.

## 2. Start Core and check the bridge

Keep ports **5432** (PostgreSQL), **8065** (Mattermost), **8000** (Core), and
**8081** (Mattermost button callbacks) available. Stop only services you own;
do not start this stack over another contribution's running stack.

From the clone's root, in terminal A:

```bash
just up
just run
```

`just up` starts supporting containers, including one-shot database and
Mattermost setup; it does not start Core. Start `just run` promptly: setup
waits for Core for five minutes. Core applies migrations and runtime grants
on boot (`DB_MIGRATE_ON_BOOT=true`), then serves on `:8000`. No separate
`just migrate` is needed. Leave terminal A running. After Python edits,
stop Core with Ctrl+C and rerun `just run`; it does **not** hot-reload.

In terminal B, also at the clone's root:

```bash
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:8000/health/ready
docker compose -f deploy/local/docker-compose.yml --project-directory . logs --tail=40 setup
```

Expect `{"status":"ok"}` for liveness and HTTP 200 for readiness. Inspect setup
for successful Mattermost registration and owner-account linking; HTTP health
alone does not prove the bridge or agent works. If setup timed out or reports
`409 Bridge is not running`, rerun `just up` after Core is ready and recheck.
Keep logs private: review/redact them before attaching evidence.

For the operator dashboard, use terminal B:

```bash
just gateway-install
just gateway-dev
```

Expect Vite at **http://localhost:5173**; sign in with the gateway admin login
from `.env`. Leave this terminal running. Console and agents connect to
**http://localhost:8000**, not the dashboard's `:5173`.
