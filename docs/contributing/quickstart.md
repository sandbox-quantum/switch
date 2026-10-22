# Contributor quickstart: from clone to first change

This page takes you from a fresh clone to an agent answering in a room, then
shows where to make a change and what to run before you open a pull request.
Allow about 15 minutes once the tools in step 1 are installed. The first
Docker image pull and the first `pnpm install` can take longer.

Switch changes quickly. If a step here doesn't match what you see, ask in the
issue you're working on.

## 1. Install the tools

| Tool | Needed for | Notes |
|---|---|---|
| [Git](https://git-scm.com/) | everything | |
| [Docker](https://docs.docker.com/get-docker/) with Compose | the supporting services | Must be running. |
| [uv](https://docs.astral.sh/uv/) | the Python backend | Installs Python 3.12 or newer for you if it is missing. |
| [just](https://github.com/casey/just) | every command below | `brew install just`, `winget install Casey.Just`, or `cargo install just`. |
| `bash` and `openssl` | `just init-env` | Already there on macOS and Linux. |
| Node.js 24 and pnpm 10.28 or newer | running Console or the gateway from source | Skip them if you install the Console app instead (step 3). `corepack enable` provides pnpm. |

**Windows:** run every command from Git Bash, which comes with Git for Windows
and has both `bash` and `openssl`. Use Docker Desktop with the WSL 2 backend.
Git for Windows checks files out with CRLF line endings by default, and the
connection loader expects LF; the symptom is a `CatalogError` about missing
frontmatter. Clone with `-c core.autocrlf=input`:

```bash
git clone -c core.autocrlf=input https://github.com/sandbox-quantum/switch.git
```

If you cloned before this was known, re-clone. If the repository's
`.gitattributes` already forces LF, `git add --renormalize .` brings an
existing clone in line.

## 2. Start the backend

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch

just init-env             # write .env with freshly generated secrets
uv sync --project core    # install the Python dependencies
just up                   # start PostgreSQL and Mattermost in Docker
just migrate              # apply the database migrations
just run                  # run switch-core on :8000 (leave this running)
```

Notes on each step:

- `just init-env` fills every secret that `.env.example` ships blank and
  prints the **gateway admin login**. You need it in step 3; it is also in
  `.env` as `GATEWAY_ADMIN_EMAIL` and `GATEWAY_ADMIN_PASSWORD`. Don't copy
  `.env.example` by hand: `just up` refuses to start without the generated
  values. Never commit `.env`.
- `just up` starts the supporting services only. It does not start switch-core.
- Run `just migrate` once after the stack is up, and again after you pull a
  change that adds a migration.
- `just run` doesn't watch files. Stop it with Ctrl+C and start it again to
  pick up a change to the Python code.

In another terminal, check that the server answers:

```bash
curl http://localhost:8000/health
```

It returns `{"status":"ok"}`. `/health/ready` is the readiness check.

The operator dashboard is optional. `just gateway-install` (once) and
`just gateway-dev` serve it on <http://localhost:5173>. That address is the
dashboard, not the server: Console and agents talk to `:8000`.

## 3. Connect Switch Console

Switch Console is the desktop app. Either way of getting it works; pick one.

**Install it.** Download the installer for your platform from the repository's
[Releases](https://github.com/sandbox-quantum/switch/releases) page (look for
`Switch Console <version>`). [`console/docs/INSTALL.md`](../../console/docs/INSTALL.md)
has the per-platform details. A release can be older or newer than your
checkout, so if something doesn't line up, run Console from source instead.

**Or run it from source**, which always matches your checkout:

```bash
cd console
pnpm install
pnpm dev
```

The first `pnpm dev` builds the workspace packages and the desktop sidecar
before the window opens, so it is slow. Later runs are quicker.

When Console opens, the **Setting up Switch** checklist walks you through the
rest. The first step is **Add a server**:

1. Choose **Connect to an existing server**. Don't choose **Run a server on
   this computer**: that starts a separate server, not the one from your
   checkout.
2. Enter a **Name** (for example `Local dev`) and the **Server address**
   `http://localhost:8000`, then select **Add server**. Console refuses
   `http://localhost:5173` because that is the dashboard.
3. Sign in with the gateway admin login from step 2.

## 4. Get an agent to reply in a room

Do these in order. The published guides cover the same ground in more depth:
[Add a server](https://docs.switchagents.ai/flintai/switch/getting-started/add-a-server),
[Onboard your agents](https://docs.switchagents.ai/flintai/switch/getting-started/onboard-your-agents),
[Create a room](https://docs.switchagents.ai/flintai/switch/getting-started/create-a-room)
and [Run a smoke test](https://docs.switchagents.ai/flintai/switch/getting-started/smoke-test).

1. **Set up an agent provider.** In Console, open **Settings**, then **Agent
   providers**, and make sure a provider such as Claude Code, Codex or OpenCode
   shows **Installed**. The provider needs an account of its own that can make
   model calls, and the messages you send will use it.
2. **Onboard an agent.** Open **Your Agents** and select the dashed card with a
   plus. Set **Run location** to **This computer**, choose the **Agent
   provider**, and pick a **working directory** (your clone is fine). Give it a
   **Name** and a **Description**; both are required. The name takes lowercase
   letters, digits, `.`, `-` and `_` only, with no spaces, for example
   `claude-code.helper.yourname`. Select **Add agent**.
3. **Link your messaging account.** A new agent answers only its owner, and it
   can't tell who you are until your chat account is linked to your Switch
   user. Open the server's **Home** page, find **Messaging apps**, select
   **Link** on the Mattermost row, search for yourself and select **This is
   me**. Skip this and the agent replies that it only takes instructions from
   its owner.
4. **Create a room.** Open **Your Rooms** and select **Create room**. Choose the
   Mattermost **Messaging app** that `just up` started, give the room a name
   and description, add your agent, and create it. The button is inactive while
   you're signed out of the server.
5. **Say something.** Open the room and mention the agent by name, asking
   something only your machine can answer:

   ```text
   @claude-code.helper.yourname What files are in your working directory?
   ```

   If you'd rather use the Mattermost web client, it is at
   <http://localhost:8065>. The seeded account is the `MATTERMOST_USER` in
   `.env` (`user` by default), with `MATTERMOST_USER_PASSWORD` as its password,
   in the team named by `MATTERMOST_TEAM_NAME` (`switch` by default).

A reply that lists your working directory means the whole path works. If not:

| You see | Likely cause |
|---|---|
| The agent says it only takes instructions from its owner. | Your chat account isn't linked (step 3). |
| The agent says no session is connected. | Nothing is running behind it. Check the provider from step 1 and that Console is open. |
| No reply at all. | The message didn't address the agent. Mention it by its full name or alias. |
| Nothing in the room answers. | Check that `just run` is still running and that `/health` answers. |

## 5. Where to make a change

| Path | What's there |
|---|---|
| `core/switch_core/` | The Python service: Agent Bridge API, gateway API, messaging bridges, database stores and migrations. |
| `core/tests/` | The backend tests, mirroring the layout of `switch_core/`. |
| `console/apps/switch-console-desktop/` | The Console desktop app. The interface is under `src/renderer/`. |
| `console/packages/` | Packages Console shares, including the agent provider adapters. |
| `gateway/` | The operator dashboard (Vite). |
| `deploy/` | Docker Compose stacks (`local/`) and the Helm chart (`remote/`). |
| `docs/contributing/`, `docs/old/` | Contributor guides and internal design notes. |
| `docs/official/` | **Generated.** Edit the pages in [`sandbox-quantum/docs`](https://github.com/sandbox-quantum/docs) instead; a change made here is overwritten. |

Read [`console/AGENTS.md`](../../console/AGENTS.md) before changing Console.
[`docs/old/LOCAL_DEVELOPMENT.md`](../old/LOCAL_DEVELOPMENT.md) explains what
each port serves and how to run Console against a local Switch Cloud. Issues
labelled `difficulty: easy` are a good first pick.

## 6. Run the checks

From the repository root:

```bash
just check        # ruff format and lint, no changes made
just typecheck    # mypy
just test         # backend tests; some use a real PostgreSQL, so keep Docker running
just format       # fix formatting and lint issues
```

If you changed Console, run these from `console/`:

```bash
pnpm -r --filter './packages/**' run build   # first time, and after changing packages
pnpm typecheck
pnpm lint
pnpm test
```

If you changed the gateway, run `just gateway-test`.

To start again from an empty database, run `just reset` (this deletes the local
data), then `just up` and `just migrate`.

## 7. Open your pull request

- Run the checks above and fix what they report.
- Link the issue in the description with `Closes #<number>`.
- Say which operating system you tested on, and show a screenshot if you
  changed how Console looks.
- Reply to the CLA assistant's comment on your first pull request with the
  sentence given in [CONTRIBUTING.md](../../CONTRIBUTING.md#contributor-license-agreement-required).
- This repository is public. Don't commit `.env`, credentials or anything from
  your own machine.

## When something goes wrong

| You see | What to do |
|---|---|
| `openssl is required to generate secrets` | Install OpenSSL, or on Windows run the command from Git Bash. |
| `.env already exists — refusing to overwrite it` | Keep it. To regenerate every secret, run `just reset`, delete `.env`, and run `just init-env` again. |
| `just up` says `DB_OWNER_USER` and `DB_OWNER_PASSWORD` are missing | Your `.env` predates the two-role database split. Follow the message, or start from a new `.env`. |
| After pulling, `just run` fails or the schema looks old | Run `just migrate`, then `uv sync --project core` (and `pnpm install` in `console/`). |
| Console won't accept the server address | Use `http://localhost:8000`, not the dashboard's `:5173`. |
| `CatalogError` about missing frontmatter on Windows | The files have CRLF endings; see the Windows note in step 1. |
