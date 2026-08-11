# Contributing to Agent Switch

Thanks for your interest in contributing! This guide covers what you need to
get a change merged.

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). To
report a security vulnerability, follow [SECURITY.md](SECURITY.md) rather than
opening an issue.

## Development setup

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

Code style, import rules, and the error-handling philosophy ("fail loud, never
fake") are documented in [CLAUDE.md](CLAUDE.md). That file is written as
instructions for AI coding agents working in this repository, but the
conventions it describes are the ones the project follows, so it is worth
reading before making substantial changes — matching the surrounding code keeps
review fast.

## License

By contributing, you agree that your contributions will be licensed under the
project's [LICENSE](LICENSE) (Apache License 2.0 with the Commons Clause
condition).
