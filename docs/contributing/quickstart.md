# Quickstart: from clone to first change

This is the short path from a fresh clone to a running Switch, an agent
answering in a room, and knowing where to make a change. Budget about 15
minutes once the prerequisites are installed. It was tested on macOS (Apple
Silicon); the commands are the same on Linux.

If something here does not match what you see, Switch changes fast — say so in
the issue you are working on rather than guessing.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) — runs the supporting stack
  (PostgreSQL and Mattermost).
- [uv](https://docs.astral.sh/uv/) — installs Python dependencies and runs
  switch-core.
- [just](https://github.com/casey/just) — the task runner (`brew install just`).
- Node 22+ and [pnpm](https://pnpm.io/) — for Switch Console and the gateway
  frontend.
- At least one agent provider CLI installed and signed in (Claude Code, Codex,
  OpenCode, Antigravity ACP or Cursor), so an agent has something to run.

## 1. Bring up the stack

```bash
just init-env            # generate .env with fresh random secrets
uv sync                  # install Python dependencies
just up                  # start PostgreSQL and Mattermost in Docker
just run                 # run switch-core on :8000 (leave this running)
```

`just init-env` writes a `.env` with freshly generated secrets and prints the
gateway admin login — do not copy `.env.example` by hand, its secret fields
ship blank on purpose. `just up` starts only the supporting services; you run
switch-core yourself with `just run` so you get hot reload.

## 2. Point Switch Console at your local server

In a second terminal, run Switch Console against this checkout, with its own
data directory so your other dev builds are left alone:

```bash
just gateway-install     # first time only: install Console/frontend deps
just local-cloud         # run switch-core as a stand-in for Switch Cloud (needs `just up`)
just local-cloud-console # run Switch Console pointed at http://localhost:8000
```

Create an account to sign in with (use the admin's default domain so it joins
the admin workspace):

```bash
just local-cloud-user ada@switch.local "Ada Lovelace" <password>
```

Sign in to Console with that account.

## 3. See an agent answer in a room

In Switch Console:

1. Add your local server if it is not already connected.
2. Onboard an agent for a provider you are signed in to.
3. Create a room and add the agent.
4. Send a message that addresses the agent and wait for its reply.

If the agent does not answer, check that its provider CLI is installed and
signed in as the user running Console, and that `just run` is still up.

## 4. Where things live

| Path | What it holds |
|---|---|
| `core/` | The backend — a self-contained Python project (`switch_core`) and its tests |
| `console/` | Switch Console, the desktop app (Electron, Node/pnpm) |
| `gateway/` | The operator dashboard frontend (Node/Vite) |
| `docs/` | `official/` is synced from the docs repo (do not edit); `old/` and `contributing/` are repo-authored |

## 5. Run the tests

```bash
just check               # lint and format check (CI mode)
just typecheck           # mypy
just test                # the backend suite (pytest); `just test -k name` for one test
```

The store tests run against a real PostgreSQL from `just up`, not mocks or
SQLite, so keep the stack running. Switch Console has its own checks under
`console/` (its pnpm scripts).

## 6. Before you open a pull request

- Run `just check`, `just typecheck` and `just test`.
- Keep one change per branch and stage only the files you meant to.
- Sign the CLA on your first PR (the bot comments with the link).

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full detail on each step.
