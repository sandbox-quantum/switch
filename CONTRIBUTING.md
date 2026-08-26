# Contributing to Agent Switch

Thanks for your interest in contributing! This guide covers what you need to
get a change merged.

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). To
report a security vulnerability, follow [SECURITY.md](SECURITY.md) rather than
opening an issue.

## Development setup

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/),
[uv](https://docs.astral.sh/uv/), and [just](https://github.com/casey/just)
(`brew install just`).

```bash
just init-env            # first-time setup — generate .env with random secrets
uv sync                  # install Python dependencies
just gateway-install     # install gateway frontend deps (first time only)
just up                  # start the supporting stack (Docker Compose)
just run                 # run switch-core locally (:8000)
just gateway-dev         # run the gateway frontend (separate terminal)
```

`just up` starts the **supporting services** in Docker — Tuwunel, PostgreSQL and
Mattermost. You run **switch-core** and the **gateway** yourself so you get
hot-reload while developing: `just run` (switch-core on `:8000`) and
`just gateway-dev` (the frontend), each in its own terminal. Stop the stack with
`just down`, or `just reset` to also wipe the volumes.

If you only want to see Switch running rather than develop against it, the
standalone stack in the [README](README.md#getting-started) is a shorter path.

## Common commands

Run `just` with no arguments to list every recipe. The most-used ones:

| Command | What it does |
|---|---|
| `just init-env` | Generate `.env` with freshly generated secrets (no default login) |
| `just up` / `just down` | Start / stop the local dev stack |
| `just reset` | Stop the stack and wipe volumes (incl. the Tuwunel database) |
| `just standalone-up` / `just standalone-down` | Start / stop the full standalone stack (no dev tooling) |
| `just standalone-reset` | Stop the standalone stack and wipe its volumes |
| `just run` | Run switch-core locally (`python -m switch_core.main`) |
| `just migrate` | Apply migrations (`alembic upgrade head`) |
| `just migration "msg"` | Autogenerate a new Alembic migration |
| `just format` | Format + autofix with ruff |
| `just check` | Lint/format check (CI mode, no changes) |
| `just typecheck` | Type-check with mypy |
| `just test` | Run the test suite (`pytest core/tests/`); `just test -k name` for one test |
| `just gateway-dev` / `just gateway-build` | Run / build the gateway frontend |

## Repository layout

| Path | Contents |
|---|---|
| `core/` | Backend tree — a self-contained Python project (`pyproject.toml`, `uv.lock`, `alembic.ini`) holding the service package and tests |
| `core/switch_core/` | The main Python service package (import root `switch_core`, dist `switch-core`) |
| `core/tests/` | Test suite, mirroring the `switch_core/` module structure |
| `gateway/` | Operator dashboard frontend (Node/Vite) |
| `console/` | The Switch Console desktop app |
| `connectors/` | Agent connectors (`claude-code-plugin`, `codex-plugin`, `opencode-plugin`) |
| `deploy/` | Deployment assets — Docker Compose stacks (`local/`), the Helm chart (`remote/`) and shared images |
| `docs/` | `official/` — the published documentation synced into the repo (generated, edit the docs repository); `old/` — internal architecture, protocol and bridge references |
| `switch-expert/` | Instructions and knowledge for an agent that answers questions about Switch |
| `justfile` | Repo-root task runner (drives all code trees) |

[`docs/old/ARCHITECTURE.md`](docs/old/ARCHITECTURE.md) describes the service's internal
module structure and the key request flows.

## Testing

Tests live in `core/tests/switch_core/` and mirror the module structure. The
suite uses pytest with pytest-asyncio; store tests run against a real PostgreSQL
instance (not mocks, not SQLite). Run them with `just test`, or a single test
with `just test -k test_name`.

Before opening a pull request, run `just check`, `just typecheck` and
`just test`.

## Contributor License Agreement (required)

Every contributor must agree to a Contributor License Agreement before their
contributions can be merged. There are two paths — individual and corporate.

### Individual contributors

Agent Switch requires every contributor to sign the
[Contributor License Agreement](CLA.md). This is a one-time step handled
automatically:

1. Open your pull request as usual.
2. An automated CLA assistant comments on the PR with a link to the CLA and a
   status check.
3. Reply to the PR with the exact sentence:

   > I have read the CLA Document and I hereby sign the CLA

Your signature is recorded automatically and applies to all future
contributions — you only sign once.

### Corporate contributors

If you contribute on behalf of a company, your employer can sign the Corporate
CLA instead of each employee signing individually:

1. Download the [Corporate CLA](CCLA.pdf) and complete it: the corporation's
   details, the GitHub usernames of the employees authorized to contribute
   (Schedule A), and a signature from a person authorized to bind the company.
2. Email the completed, signed PDF to **legal@sandboxquantum.com**.
3. Once we record it, we add those GitHub usernames to the project's approved
   contributor list, so their contributions are recognized as covered — they do
   not each need to sign the individual CLA.

To add or remove authorized contributors later, the company emails an updated,
signed copy to the same address.

## License

By contributing, you agree that your contributions will be licensed under the
project's [LICENSE](LICENSE) (Apache License 2.0 with the Commons Clause
condition).
