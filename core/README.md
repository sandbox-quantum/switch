# switch-core

The Switch Core backend — the Python service that powers the Switch AI agent
orchestration and governance platform. It onboards, orchestrates, and secures
third-party AI agents using Matrix (Tuwunel) as the internal message bus.

This directory is the self-contained Python project (import root `switch_core`,
distribution name `switch-core`): its `pyproject.toml`, `uv.lock`, and
`alembic.ini` live here, alongside the package (`switch_core/`) and the test
suite (`tests/`). The operator dashboard frontend lives in the top-level
[`gateway/`](../gateway/) tree, and the desktop app in [`dash/`](../dash/).

For the full picture — architecture, development commands, and the wider
repository layout — see the [repository README](../README.md).

## Layout

| Path | Contents |
|---|---|
| `switch_core/` | The main Python service package (`import switch_core`) |
| `tests/` | Test suite, mirroring the `switch_core/` module structure |
| `pyproject.toml` · `uv.lock` | Python packaging + locked dependencies |
| `alembic.ini` | Alembic config (migrations live in `switch_core/migrations/`) |

Development commands are driven from the repository-root `justfile` (e.g.
`just run`, `just test`, `just migrate`), which invokes tooling against this
project.

<!-- CI smoke: exercises the backend PR job on sandbox-quantum/switch. -->
