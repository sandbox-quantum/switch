# Contributing to Agent Switch

Thanks for your interest in contributing! This guide covers what you need to
get a change merged.

## Development setup

See [CLAUDE.md](CLAUDE.md) for the full developer guide. In short:

```bash
uv sync            # install dependencies
just up            # start Switch locally (Docker Compose)
just migrate       # apply database migrations
```

## Before you open a pull request

- **Format & lint:** `just check` (CI runs `ruff format --check` + `ruff check`).
- **Type-check:** `just typecheck` (mypy over `core/switch_core/`).
- **Test:** `just test` (pytest; store tests run against a real PostgreSQL
  instance, not mocks or SQLite).

## Conventions

[CLAUDE.md](CLAUDE.md) documents the code style, import rules, and the
error-handling philosophy ("fail loud, never fake") this project follows.
Please read it before making substantial changes — matching the surrounding
code and these conventions keeps review fast.

## License

By contributing, you agree that your contributions will be licensed under the
project's [LICENSE](LICENSE) (Apache License 2.0 with the Commons Clause
condition).
