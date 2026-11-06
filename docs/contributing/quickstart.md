# Contributor Quickstart

_From a fresh git clone to your first running change in 15 minutes._

Welcome! This guide is designed for new contributors and hackathon participants. It walks you through setting up a complete local development environment, running Switch Core, launching Switch Console, talking to an agent in a room, making a code change, and submitting a pull request.

---

## 1. Prerequisites

Make sure the following tools are installed on your workstation:

| Tool | Minimum Version | Installation / Verification |
|---|---|---|
| **Git** | 2.30+ | `git --version` |
| **Python** | 3.12+ (3.14 supported) | Managed automatically via `uv` |
| **uv** | 0.4+ | `curl -LsSf https://astral.sh/uv/install.sh \| sh` or `brew install uv` |
| **Docker** | Engine 24+ & Compose v2 | [Get Docker](https://docs.docker.com/get-docker/) |
| **Node.js & pnpm** | Node 22.13+, pnpm 10+ | `node -v` and `npm install -g pnpm` |
| **just** | 1.14+ | `brew install just`, `cargo install just`, or `winget install Casey.Just` |

> [!TIP]
> **Windows Note on Line Endings (CRLF):**
> Switch requires LF line endings for frontmatter and test fixtures. Before or immediately after cloning, configure:
> ```bash
> git config core.autocrlf false
> git add --renormalize .
> ```

---

## 2. Clone and Setup Environment

### Step 1: Clone the Repository

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch
```

### Step 2: Initialize Configuration with `just init-env`

Generate your local `.env` configuration with fresh, cryptographically secure secrets:

```bash
just init-env
```

> [!IMPORTANT]
> Always use `just init-env` instead of manually copying `.env.example`. This recipe initializes unique encryption keys, session secrets, and local tenant identities required by switch-core and the database.

### Step 3: Install Core Dependencies

Install Python dependencies in `core/` using `uv`:

```bash
uv sync
```

---

## 3. Start Supporting Services and Switch Core

Switch development uses a hybrid architecture: infrastructure (PostgreSQL and Mattermost) runs in Docker containers, while you run `switch-core` directly on your host for instant hot-reload and fast debugging.

### Step 1: Start Docker Infrastructure

```bash
just up
```

This starts:
- **PostgreSQL** on port `5432` (database: `switch`, user: `switch`)
- **Mattermost** on port `8065` (local collaboration bridge)

### Step 2: Run Switch Core

In your first terminal, launch the backend service:

```bash
just run
```

`switch-core` automatically applies database migrations and starts listening on **`http://localhost:8000`**. Check `http://localhost:8000/health` in your browser to confirm it is live.

---

## 4. Run Switch Console and Talk to an Agent

In a **second terminal**, start the Switch Console client:

```bash
cd console
pnpm install
pnpm -r --filter "./packages/**" run build
pnpm --filter @switch-console/desktop run dev
```

1. **Connect to Server:** When Console opens, point it to your local Switch server: `http://localhost:8000`.
2. **Create an Agent:** Navigate to **Agents** > **New Agent**. Select an available provider on your machine (e.g. Claude Code, Codex, or OpenCode).
3. **Open a Room:** Create a new Room, invite your agent, and type:
   ```text
   Hello! Are you ready to pair program?
   ```
4. **Observe Response:** The agent will receive your prompt, stream its thoughts, and reply in the room!

---

## 5. Where Things Live

| Directory | Language / Stack | Purpose |
|---|---|---|
| `core/switch_core/` | Python | Main service logic: addressing policies, rooms, MCP broker, connectors, and bridges. |
| `core/tests/` | Python / pytest | Backend unit, integration, and database test suites. |
| `console/packages/` | TypeScript / Node | Shared protocol packages (`shared`), agent providers (`agent-providers`), plugins, and headless controller (`agent-controller`). |
| `console/apps/` | TypeScript / Electron | Switch Console desktop application. |
| `gateway/` | TypeScript / Vite / React | Operator web dashboard for user management and room operations. |
| `deploy/` | Docker Compose / Helm | Deployment assets for local containers and production Kubernetes clusters. |

---

## 6. How to Test Your Changes

Before committing changes, run the automated test and lint suites:

### Backend Python Checks (`core/`)

```bash
# Run backend test suite
just test

# Run a specific test
just test -k test_addressing

# Check code formatting and linting
just check

# Automatically fix linting and formatting issues
just format

# Type check
just typecheck
```

### Frontend and Controller Checks (`console/`)

```bash
cd console

# Run tests across packages
pnpm -r run test

# Typecheck TypeScript packages
pnpm -r run typecheck

# Lint JavaScript and TypeScript
pnpm -r run lint
```

---

## 7. Pull Request Checklist

Before opening your pull request on GitHub:

- [ ] **Tests pass:** `just test` and relevant `pnpm` test suites pass with zero errors.
- [ ] **Lint and formatting:** `just check` reports clean formatting.
- [ ] **No committed secrets:** Never commit tokens, `.env` files, private keys, or personal tenant URLs.
- [ ] **Conventional commit messages:** Use clear prefix tags like `feat(core): ...`, `fix(agent-controller): ...`, or `docs: ...`.
- [ ] **Issue reference:** Link your PR to its issue using `Closes #1234` (replacing 1234 with your target issue number).

---

## Switch Changes Fast

> [!NOTE]
> Switch is an active open-source codebase with ongoing hackathons and daily releases. If you notice any command or file path that does not match current `main`, please ask in the relevant GitHub issue or submit a clarification PR!
