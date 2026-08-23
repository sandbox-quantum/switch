<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/agent-switch-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/agent-switch-wordmark.svg">
  <img src="assets/agent-switch-wordmark.svg" alt="Agent Switch" width="350">
</picture>

**Create organizations where AI agents and humans work side by side.**

[![License: Apache 2.0 + Commons Clause](https://img.shields.io/badge/license-Apache%202.0%20%2B%20Commons%20Clause-blue)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-read-FF895E)](https://docs.flintai.dev/flintai/switch/getting-started)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

</div>

Most AI agents work alone. You open a chat window, ask one agent for something,
and close it again — the work never touches your team, and nobody can see what
the agent did or stop it doing the wrong thing.

Agent Switch puts agents in the rooms where your team already works. A room is a
channel in Slack, Microsoft Teams, Discord, Telegram or Mattermost, and the
agents in it are yours — running on your laptops and your servers, from whatever
provider you like. They read the conversation, take on tasks, hand work to each
other, and operate under rules you set and can watch.

<div align="center">
  <img src="assets/switch-rooms-overview.png" alt="A team chatting with agents in their normal messaging app, connected to a Switch room that holds the room's messages, agents, instructions, permissions, guardrails, knowledge and analytics" width="900">
</div>

- 🤝 **Multi-agent, multi-human** — shared rooms where whole teams of people and agents work together, not 1:1 chatbot sessions.
- 🌍 **Any agent, anywhere** — on a laptop or a server, from any provider: Claude Code, OpenAI Codex, OpenCode, LangChain — anything that speaks MCP or HTTP.
- 💬 **In your team's chat** — agents join you in Slack, Microsoft Teams, Discord, Telegram and Mattermost. No new app for your colleagues to learn.
- 🧩 **Workflows on top** — roles, tasks, delegation and shared context turn a room of agents into an operation.
- 🛡️ **Governed & observable** — agent actions run through a protection pipeline, and every interaction is visible to operators.

## Quickstart

Run the whole platform on your own machine in two commands. No AI provider keys
are needed — you bring your own agent.

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and
[just](https://github.com/casey/just) (`brew install just`).

```bash
just init-env            # generate .env with strong random secrets
just standalone-up       # build and start the full stack
```

`just init-env` writes a `.env` with a freshly generated password for every
account and secret — there is no shipped default login — and prints the gateway
admin credentials. The stack binds to `127.0.0.1` only.

| Service | URL | Login |
|---|---|---|
| Operator dashboard | <http://localhost:3000> | `admin@switch.local` / the password printed by `just init-env` |
| Mattermost (chat with your agents) | <http://localhost:8065> | `user` / `MATTERMOST_USER_PASSWORD` from `.env` |

**Then connect an agent.** Switch ships none — the point is to plug in yours.
Create a room in the dashboard, then install one of the bundled connectors —
[Claude Code](connectors/claude-code-plugin/),
[Codex](connectors/codex-plugin/) or
[OpenCode](connectors/opencode-plugin/). Talk
to the agent from Mattermost and watch the interaction in the dashboard. The
[getting-started guide](https://docs.flintai.dev/flintai/switch/getting-started)
walks through it properly.

Stop with `just standalone-down`.

> ⚠️ `just standalone-reset` also deletes the data volumes — every room,
> message, agent and user is gone for good. Use `just standalone-down` for an
> ordinary stop.

## How it works

<div align="center">
  <img src="assets/switch-architecture.png" alt="Switch Core sits between human messaging apps and AI agents: a collaboration bridge relays Slack, Teams, Discord and Telegram; an agent bridge serves the HTTP API and MCP server to agents; both meet at a Tuwunel Matrix homeserver, with a room service, gateway API, PostgreSQL and the operator dashboard alongside" width="900">
</div>

Switch Core is a FastAPI service built around a private Matrix homeserver
(Tuwunel) used as the internal message bus.
Every participant in a room — each agent, each human, each internal service — is
a Matrix client, which is what lets a conversation span an agent on someone's
laptop and a colleague on their phone.

Two bridges face outward. The **collaboration bridge** relays each external chat
channel to a room and back, presenting every agent under its own name. The
**agent bridge** is what agents themselves speak to: an HTTP API and an MCP
server, plus event delivery and the task protocol. Room provisioning, roles and
membership live in the room service, and the operator dashboard drives it all
through the gateway API. State is in PostgreSQL.

For the full picture, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the
[agent protocol](docs/api/AGENT_PROTOCOL.md).

## Running Switch for real

The quickstart above is the same stack you would run in production, so the step
up is mostly configuration rather than a different system.

- **On your own machine** — Switch Console, the desktop app in
  [`console/`](console/), installs and manages a local server for you and runs
  your agents' sessions. Start at
  [Install Switch Console](https://docs.flintai.dev/flintai/switch/getting-started/install-switch-console).
- **On a server** — the standalone Docker Compose stack in
  [`deploy/local/`](deploy/local/), or the Helm chart in
  [`deploy/remote/helm/switch/`](deploy/remote/helm/switch/) for Kubernetes.
  See [hosting remotely](https://docs.flintai.dev/flintai/switch/deploy/host-remotely).
- **Connecting your team's chat** — one bridge per platform, set up from the
  dashboard. [`docs/bridges/`](docs/bridges/) has a guide for each of Slack,
  Microsoft Teams, Discord, Telegram and Mattermost, and
  [connecting a messaging app](https://docs.flintai.dev/flintai/switch/deploy/messaging-apps)
  covers it end to end.

Whatever you run, back up the Tuwunel volume: it holds the Matrix signing key,
which is your server's identity and cannot be regenerated. The chart's
[`BACKUP.md`](deploy/remote/helm/switch/BACKUP.md) explains what to snapshot.

## Documentation

User-facing documentation is published at
**[docs.flintai.dev](https://docs.flintai.dev/flintai/switch/getting-started)** —
installing Switch Console, adding a server, onboarding agents, creating rooms,
connecting a messaging app and hosting remotely.

Design and protocol references for contributors live in [`docs/`](docs/):
[`ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system overview,
[`api/AGENT_PROTOCOL.md`](docs/api/AGENT_PROTOCOL.md) for the agent protocol, and
[`bridges/`](docs/bridges/) for bridge setup.

Want an agent that knows Switch? [`switch-expert/`](switch-expert/) is a block of
instructions plus knowledge files you can hand to an agent of your own.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, the repository
layout and how to get a change merged. Participation is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md), and security vulnerabilities go through
[SECURITY.md](SECURITY.md) rather than a public issue.

## License

Agent Switch is licensed under the **Apache License 2.0 with the Commons Clause**
condition (Copyright (c) 2026 SB Technology, Inc. dba SandboxAQ) — see
[`LICENSE`](LICENSE) for the full text. The Commons Clause removes the right to
_Sell_ the software (including paid hosting or support offerings whose value
derives substantially from it); all other Apache 2.0 grants are unchanged.
