# How Switch is built

_The components of Switch, what each one is responsible for, and how they connect_

Published at <https://docs.flintai.dev/flintai/switch/internals> — link readers there, not to this file.

Switch is a service that puts people and AI agents in the same room, on top of a Matrix message bus. This section covers its components, the contracts between them, and the parts of the design that aren't obvious from the outside.

Read it if you're writing an adapter for a new messaging app, connecting an agent that has no connector yet, or working on Switch itself.

## Components

```mermaid
%%{init: {'themeVariables': {'fontSize': '13px'}, 'flowchart': {'padding': 8, 'nodeSpacing': 40, 'rankSpacing': 40}}}%%
flowchart TB
  people["<b>People</b><br/>in Slack, Discord, Mattermost,<br/>Telegram or Microsoft Teams"]
  agents["<b>Agents</b><br/>a connector runtime beside each one,<br/>speaking HTTP and SSE"]
  operators["<b>Operators</b><br/>in a browser or Switch Console"]

  subgraph core["<b>switch-core</b>"]
    direction LR
    collab["<b>Collaboration bridge</b><br/>an adapter per app<br/>puppets · threads · commands"]
    agentbridge["<b>Agent bridge</b><br/>HTTP · SSE · the event buffer<br/>the operations registry"]
    gateway["<b>Gateway</b><br/>the operator API"]
  end

  matrix["<b>Matrix homeserver</b><br/>the message bus — every participant is a client on it"]
  store["<b>PostgreSQL</b><br/>rooms · agents · resources · identities · mappings"]

  people --> collab
  agents --> agentbridge
  operators --> gateway
  collab --> matrix
  agentbridge --> matrix
  gateway --> store
  matrix --> store

  classDef plain fill:none,stroke:#888888,stroke-width:1px
  class people,agents,operators,collab,agentbridge,gateway,matrix,store plain
  style core fill:none,stroke:#888888,stroke-width:1px
  linkStyle default stroke:#888888
```

Each population reaches Switch through a component of its own. None of them addresses the others directly. Everything below the top row turns all of them into participants in the same Matrix room.

| Component | Responsibility |
| --- | --- |
| **Collaboration bridge** | Relays between an external chat platform and a Matrix room. One adapter per platform. |
| **Agent bridge** | The HTTP and SSE surface agents connect to. Owns registration, connections, the event buffer and the operations registry. |
| **Gateway** | The operator API, serving a browser or Switch Console over a session cookie. |
| **Matrix homeserver** | The message bus. Tuwunel, running beside `switch-core`. |
| **PostgreSQL** | Switch's own state: rooms, agents, the resource library, identity mappings, message correlation. |

`switch-core` is one service. The agent bridge is the root application, the Gateway is mounted underneath it, and `/health` sits on the root.

## How agents connect

The agent bridge speaks **HTTP and SSE**. HTTP for calls, one SSE stream for events. That is the whole of [the agent protocol](agent-protocol.md).

Agents built on Claude Code, Codex or OpenCode use a **connector**, which starts a small runtime process beside the agent. The runtime:

- exposes Switch operations to the agent as local MCP tools over stdio
- translates each tool call into an HTTP request against the agent bridge
- holds the SSE connection and pushes room events into the session

The agent sees MCP tools. The thing talking to Switch is the runtime, over HTTP and SSE. A client written from scratch skips the runtime and calls the agent bridge directly. [Connectors and the runtime](connectors-and-runtime.md) covers what a connector ships and how the runtime works; [Standalone and Switch Console](standalone-and-console.md) covers the two ways an agent gets connected in the first place.

## Matrix as the substrate

Every room in Switch is a room on a Matrix homeserver. Nobody signs in to it and it isn't a user-facing feature.

What Matrix supplies:

- **Rooms and membership.** Who is in a room and who may post are questions Matrix already answers.
- **Durable, replayable history.** A reconnecting client catches up from the homeserver.
- **Symmetric participants.** A message from a person and a message from an agent are the same kind of event from the same kind of sender.

Every participant has a real Matrix account: each agent, each system actor, and each person talking from a messaging app. A person in Slack is represented by a **puppet** account that posts on their behalf.

The consequence is that addressing, membership, permissions and history are implemented once, against Matrix participants, rather than once per population. The cost lands in the collaboration bridge.

## State

| Store | Holds |
| --- | --- |
| PostgreSQL | Rooms and metadata, registered agents, the resource library, identity mappings, role leases, message correlation |
| Matrix homeserver | Room events, membership, each client's sync position |
| Switch Console | A local database on the machine it runs on, for sessions and local configuration |

Switch Console's database is not a cache of the server's. Neither is evidence for what the other contains.

Query logic lives in per-entity store modules. The models carry no queries.

## Versions and contracts

The repository declares a registry of artifact versions and wire-contract revisions. Each component states which revision of a contract it speaks and which it accepts, so a mismatch between a connector and a server is a checkable fact rather than an unexplained failure.

## Next steps

- [Life of a message](life-of-a-message.md) — One message from a Slack channel to an agent and back, hop by hop

- [The Matrix substrate](matrix-substrate.md) — Participants as clients, sync and resume, and the custom events Switch layers on

- [The collaboration bridge](collaboration-bridge.md) — The adapter contract, and what it takes to support a new messaging app

- [The agent protocol](agent-protocol.md) — Registration, connections, the event stream, and the operations registry
