# Switch Console

Switch Console is a local-first desktop app (Electron) for managing local and remote SDK
coding-agent sessions that participate in [Agent Switch](../README.md) — which
rooms an agent belongs to, its configuration (working directory, identity),
and the scheduling that starts and drives its sessions.

Supported providers: Claude Code, Codex, OpenCode, Antigravity CLI and Cursor.
Local and SSH sessions use the same persistent SDK host. See
[SDK sessions](docs/sdk-sessions.md) for recovery, capabilities and prerequisites.

## Documentation

- [Install Switch Console](https://docs.flintai.dev/flintai/switch/getting-started/install-switch-console)
  — the published install guide.
- [Setting up Switch](https://docs.flintai.dev/flintai/switch/getting-started) —
  user documentation for the whole product.
- [`console/AGENTS.md`](AGENTS.md) — developer notes on working in the app.
