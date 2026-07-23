# Contributing to Agent Switch

Thanks for your interest in contributing! This guide covers what you need to
get a change merged.

## Contributor License Agreement (required)

Agent Switch requires every contributor to sign a
[Contributor License Agreement](CLA.md) before their contributions can be
merged. This is a one-time step:

1. Open your pull request as usual.
2. An automated CLA assistant will comment on the PR with a link to the CLA and
   a status check.
3. Reply to the PR with the exact sentence:

   > I have read the CLA Document and I hereby sign the CLA

Your signature is recorded automatically and applies to all future
contributions — you only sign once.

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
