# Contributor quickstart: clone to first reply

Run Core from your checkout, connect Switch Console, get a real agent reply,
then make a small change. Allow extra time for first-time downloads and
provider sign-in; setup time depends on your machine and connection.

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

Optional: for the operator dashboard, use terminal B:

```bash
just gateway-install
just gateway-dev
```

Expect Vite at **http://localhost:5173**; sign in with the gateway admin login
from `.env`. Leave this terminal running. Console and agents connect to
**http://localhost:8000**, not the dashboard's `:5173`.

## 3. Build Console and join this server

Use a third, interactive desktop terminal. On Windows, first clone into a
new directory from **PowerShell**, keeping LF endings:

```powershell
git clone -c core.autocrlf=false https://github.com/sandbox-quantum/switch.git switch-console-dev
cd switch-console-dev
git rev-parse HEAD
```

Compare that SHA with the WSL clone's SHA; if different, check out the WSL
SHA here before building. Linux/macOS readers use their existing clone.
From that clone's root (PowerShell on Windows, bash elsewhere):

```text
cd console
pnpm install --frozen-lockfile
pnpm run dev
```

`pnpm run dev` builds shared packages and the desktop sidecar, then starts
watches and Electron; no separate build command is needed. Expect the first
launch to take longer. See [Console development notes](../../console/AGENTS.md)
for individual build commands. Keep this terminal and Console open.

On first run choose **Join an existing server** → **Continue**. In an already
configured app, use the server picker → **Add a Switch server** →
**Connect to an existing server**. Enter a name and **Server address**
`http://localhost:8000`, then **Add server** and sign in with the gateway admin
login. **On this computer** on the first-run screen installs another server;
it does not connect to the Core process above.

## 4. Register an agent, then add it to a room

1. Open **Settings → Agent providers**. Confirm your CLI is installed and
   authenticated on Console's machine, with model access/quota. If installed
   after Console started, fully quit and reopen Console. An installed CLI is
   a provider, not yet a registered room participant.
2. Open **Your Agents** and select the dashed plus card. Choose **This
   computer** as **Run location**, your **Agent provider**, and a working
   directory on that computer (the Console checkout on Windows). If offered,
   select **Run managed agents on this computer** and wait for the controller.
   Give it a unique lowercase **Name**, for example `quickstart.yourname`,
   and a **Description**, then **Add agent**. It must appear in Your Agents.
3. Check **Home → Messaging apps** for your linked Mattermost account. Setup
   links the gateway admin to `MATTERMOST_USER`. If missing, use **Link**,
   select your account with **This is me**, then post the displayed confirmation
   code from that account as instructed. Wait until the link is confirmed:
   the default agent policy accepts instructions only from its owner.
4. Select **Your Rooms**, then **+ New Room** in the sidebar. Choose Mattermost as the messaging app,
   name the room `quickstart-yourname`, select your registered agent under
   **Participants**, then **Create room**.
5. Sign in at **http://localhost:8065** as `.env`'s **MATTERMOST_USER** with
   **MATTERMOST_USER_PASSWORD**, rather than the bridge's administrative user.
   Open the new channel and select the agent's actual mention from autocomplete:

   ```text
   @quickstart.yourname Read console/.nvmrc in your working directory and tell me its value. Do not modify files.
   ```

Expect the agent to start a session if necessary and reply **24.14.0** in the
room. A startup notification alone is not the provider's answer: check its
Console session for the matching prompt and file read. This proves more than
an HTTP health check. Approve any legitimate read request in the session.

## 5. Make your first change

From the clone's root, create a branch and make one useful clarification in
this guide, based on your walkthrough. Preview Markdown in your editor, then:

```bash
git switch -c docs/my-first-change
# Edit docs/contributing/quickstart.md, then check only your intended change:
git diff --check
git diff -- docs/contributing/quickstart.md
```

For code contributions, choose the relevant tree:

| Path | Responsibility and checks |
| --- | --- |
| `core/` | Python service and tests; from root: `just check`, `just typecheck`, `just test` (or `just test -k test_name`) |
| `console/` | Desktop app in `apps/`, shared agent packages in `packages/`; from `console/`: `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run test` |
| `gateway/` | Operator dashboard; from root: `just gateway-test`, `just gateway-build` (includes TypeScript checks) |
| `docs/` | Contributor guides/designs; preview Markdown and check links. `official/` is generated; edit its source repository instead |

Core database tests create a throwaway PostgreSQL through Testcontainers;
Docker must be reachable, but do not point tests at your development database.
Use the [contribution testing policy](../../CONTRIBUTING.md#testing) for the
pre-PR checks. A documentation-only edit needs command/link verification,
not thousands of unrelated code tests.

Before opening a PR, review the diff for secrets/unrelated files, reference
your issue, and fill in **What this changes** and **How it was tested** in the
[PR template](../../.github/PULL_REQUEST_TEMPLATE.md). Name your OS and starting
SHA; distinguish source checks from a real room reply. The CLA assistant asks
first-time contributors to reply with:

> I have read the CLA Document and I hereby sign the CLA

See the [CLA instructions](../../CONTRIBUTING.md#contributor-license-agreement-required)
for corporate contributions. Stop foreground processes with Ctrl+C, then
`just down` from the Core clone's root; it preserves Docker volumes.

## If a step fails

- **Missing tool:** return to step 1; check `just`, bash and OpenSSL in the
  same terminal used for `just init-env`. Docker must be reachable from WSL.
- **Existing `.env` / missing `DB_OWNER_*`:** keep it and its database intact.
  Compare with `.env.example` and the [two-role explanation](../old/LOCAL_DEVELOPMENT.md#two-database-roles-not-one).
  Do not replace live secrets or wipe volumes to complete this walkthrough;
  use a fresh clone only when the existing stack's ports are available.
- **CRLF/frontmatter error:** preserve the old checkout and clone into a new
  directory in WSL with `-c core.autocrlf=false` as above. The separate
  [Windows LF fix](https://github.com/sandbox-quantum/switch/pull/1016) is not
  part of this guide. `git add --renormalize .` stages files; it does not
  rewrite the working-tree bytes the loader reads.
- **Port conflict:** identify the existing service before stopping it. Core
  can pass health checks while a bridge fails to bind `8081`; check its log.
  Changing only `COLLABORATION_CALLBACK_PORT` leaves Mattermost's configured
  callback URL pointing at `8081`, so it is not a complete recovery.
- **Provider present, no reply:** keep Console running, confirm installation
  *and* authentication/controller availability, the registered agent in the
  room, its full mention, and the confirmed owner link. Check the agent's
  session for approvals or provider errors. See the [smoke test](../official/getting-started/smoke-test.md).
- **Sign-in accepted by Core but not Console:** check Console's error and the
  desktop keychain/secret-service prompt. Launch from an interactive desktop
  terminal; do not disable secure storage. [#1551](https://github.com/sandbox-quantum/switch/issues/1551)
  records the detached macOS launch symptom; this is not a verified WSL fix.
