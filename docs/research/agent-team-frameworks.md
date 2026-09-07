# Agent-team frameworks and templating patterns

Market research for CHOO-2620. Groundwork for articulating Switch's framework model: what a room template and an agent template should be, read against how other systems express and reuse the shape of an agent team.

> **Status: draft in progress.** Section 1 (the internal grounding) is written. Sections 2–7 are being filled from primary sources.

## 0. Recommendation

_Opinion up front, since opinion is the deliverable. Written last, once the evidence is in._

## 1. Where Switch is today

Read from the code (`core/switch_core/db/models.py`, `room_service.py`, `rooms_yaml.py`), not the pitch.

### The primitives

- **Room** — a chat channel with a briefing. The fields that carry weight: `instructions` (the briefing every agent reads when it joins), `bridge_id` + `external_channel_id` (the platform channel it mirrors), `channel_type`, `group_id`, read/write visibility, `protection_config`, `observe_config`, `admin_mode`, `archived_at`. A bridged channel maps to at most one room.
- **Agent** — an identity plus a connector. `name`, `display_name`, `icon_url`, `agent_type` (its reachability class), `connector_type`, `integration_profile`, `owner_id`, `parent_agent_id` (subagents: Claude Code child agents brought in under a parent), and `addressing_policy` (a stored allow-list of who may address it; null = open). Agents are not created by agents: identity, credentials and runtime are a human step in the Console.
- **Role** (`RoomRole`) — a per-room, assumable instruction bundle: `name`, `instructions`, `exclusive`. A hat you put on: assume, receive the instructions, act, release. Exclusive means at most one live holder (leased, auto-released on disconnect). The code calls roles "the forward-compatible home for the future 'deterministic rules for rooms' work" and already carries an unused `eligibility` ACL hook.
- **Reference** — a typed pointer to material outside Switch, carrying instructions. `type` (GitHub, Confluence, Google Drive, Jira, plus user-defined types), `name`, `description`, `instructions`, `value`. Registered once, attached to many rooms. `ReferenceType` is itself a first-class, user-extensible entity.
- **Document** — content the room holds itself. Either a *library* document (owned by a person, attachable anywhere) or a *room-scoped* document (an agent writes it as it works; never leaves the room). Both carry instructions.
- **Package** — a named bundle of references + documents with its own instructions. Built in the Gateway; an agent can attach one but cannot create or edit one. Cannot nest; cannot hold a room-scoped document.
- **Room group** — a tree (`parent_group_id`). Navigation, and one of the scopes an addressing policy can name. A room sits in at most one group.
- **Room link** — a directed pointer from one room to another with a free-text label. One-way, and grants nothing (a signpost, not access).
- **Bridge** — a chat-platform connection (Slack, Mattermost, ...). Carries `is_default` and `channel_creation_enabled`.
- **Alias** — a per-room handle for an agent (`@worker`), so a long qualified name is addressable short in one room.
- **Skill** — a versioned, packaged capability (`name`, `version`, `package_uri`, `visibility`), attachable to both agents (`agent_skills`) and rooms (`room_skills`). Already first-class in the schema.

One shape to notice: everything reusable in Switch — reference, document, package, skill, role — carries its **own `instructions` field**. Switch's unit of reuse is "material plus a note on how to use it," not raw material. That instinct is the seed of the template model.

### The one templating artifact, and the gap

The only thing in Switch that stamps a shape out of a declaration is `rooms_yaml.py`, and its own docstring is candid about how far it goes: it is "the first step toward configurable room-network packages," and "v1 is deliberately a single-room bootstrap tool: one `room:` mapping is parsed into a fully-resolved `RoomSpec` (no parameters / no templating)." It parses one `room:` mapping into a `RoomSpec`, provisions it on top of the `create_room` primitive, and exports the inverse (a live room round-trips back to YAML).

Two gaps, both concrete:

1. **No parameters, no templating.** `RoomSpec` is fully resolved: literal names, literal instructions. There is no way to say "a payments-shaped room for team X" and fill in X. Standing up the same shape twice means editing the YAML twice.
2. **The declarative surface is a strict subset of the primitive.** `RoomSpec` exposes `name`, `description`, `instructions`, `bridge`, `channel_type`, visibility, `agents`, `users`, `roles`, `references` (attach-by-id/name or define-inline) and `docs`. The `create_room` primitive (`RoomCreateConfig`) additionally accepts `group_id`, `package_ids`, `linked_rooms`, `aliases`, `include_subagents_for`, `join_event_listeners`, and `protection_config` / `observe_config` / `admin_mode`. So even for a *single* room you cannot declare a group, a package, a link, an alias, or subagent inclusion from YAML — the exact ingredients the "grow into an organization" doc says you reach for once one room stops being enough.

And there is **no multi-room artifact at all**. `RoomLink` / `LinkedRoomSpec` only point at rooms that already exist; nothing declares "these three rooms, linked this way, filed in this group, sharing this package" as one unit. The docs describe that shape in prose — "a shape the next team can reuse" — and stop. Narrative with no artifact behind it is the whole workstream.

## 2. OSS agent-team tooling

_How a **team** is expressed: roles, task graphs, handoff. What is reusable or templated, and at what granularity._

### CrewAI — the two-layer YAML

_The personas layer (`agents.yaml`) vs the work layer (`tasks.yaml`), with real file examples. Why the split exists and whether it earns its keep. Verdict against Switch primitives._

### AutoGen / AG2, LangGraph, OpenAI Agents SDK

_Team expression per framework: conversation groups, state-graph nodes/edges, handoffs. What is templated. Verdict against Switch primitives._

## 3. Flowise — ontology

_First-class entities (chatflows, agentflows, nodes, tools, document stores, ...) and how they compose. Verdict against Switch primitives._

## 4. Frontier-lab agent apps — the converging entities

_Claude Code, Gemini CLI, Codex. Which entities are converging across all three (agents/subagents, skills, plugins, MCP servers, hooks, memory files, slash commands, permissions) and how they map onto what Switch models. Verdict against Switch primitives._

## 5. Productized "spin up an agent"

_Manus and its peers. The out-of-the-box unit, how much the user configures, what is templated away. Verdict against Switch primitives._

## 6. Verdict matrix

_Every pattern in three buckets: maps cleanly onto something we have; maps onto something we would have to build; does not apply, and why._

## 7. Research-agent as the first use case

_This task treated as a dry run of a productized agent. What a "research agent template" would have needed, and what that tells us about the template model._
