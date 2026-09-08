# Agent-team frameworks and templating patterns

Market research for CHOO-2620. Groundwork for articulating Switch's framework model: what a room template and an agent template should be, read against how other systems express and reuse the shape of an agent team.

> Research complete as of 2026-09-07. Fast-moving space: version- and date-sensitive claims are flagged inline, and the Manus corporate situation (§5) is the least stable fact here. Sources are listed at the end.

## 0. Recommendation

**Switch already has the primitives every other system is converging toward. It is missing one property and two artifacts. Build them in that order.**

The property is **parameterization**. Nothing in Switch fills `{variables}` at instantiation; `rooms_yaml` is fully resolved. This is the smallest change with the widest leverage, and it unblocks everything else. Add it first.

The two artifacts:

1. **A room template = a parameterized, multi-room shape.** Concretely, grow the `rooms_yaml` surface three ways: (a) a `params:` block of typed variables with defaults, interpolated as `{var}` into every field; (b) the *full* `create_room` surface per room, group, packages, links, aliases, subagent inclusion, not today's subset; (c) more than one room in a single document, able to link to each other by a local handle. That turns "a shape the next team can reuse" from prose into an artifact. **Acceptance test: the entire payments-room → grow-into-an-organization narrative should collapse into one instantiable template**: `payments(team, repo, design_doc, ticket_project)` that stamps out the day-to-day room, the incidents room, the group, the package, the links and the roles in one shot.

2. **An agent template = the bundle the frontier CLIs converged on, in Switch's own entities.** Identity + instructions + skills + attached references/packages + addressing policy + subagents. Switch already stores every one of those as a first-class row; the template is the declaration that stamps them out, plus a catalogue to instantiate from. One boundary matters: `shape/build-it-from-inside-a-room` records that **agents cannot create agents**: identity, credentials and runtime are a human step in the Console. So an agent template is a Console-side artifact that pre-fills that human step, whereas a **room template an agent can stamp out itself** (it can already create rooms, roles, links and references). That makes room templates the nearer-term, higher-agency win.

**Build order:** (1) parameters in `rooms_yaml`; (2) room templates, multi-room, full surface, parameterized, with the payments example as the acceptance test; (3) a template **catalogue** in the Gateway (the "marketplace" every product in this scan has and Switch does not); (4) agent templates as the Console-side bundle; (5) a recurring-run trigger convention, later, as the companion to templates.

**The differentiator to protect.** Everyone else either barely templates a team (the OSS frameworks) or hides the team inside a single agent (the productized ones). Switch's template should stamp out a **visible, inhabitable organization**: humans and agents in rooms, explicit roles, addressable names. The market's instinct is a black box; Switch's whole premise is the opposite. Don't copy the black box.

One thing the scan settles: this is a **packaging problem, not a new-primitive problem.** Switch has the nouns. It needs a way to declare a reusable arrangement of them, parameterize it, and instantiate it from a shelf.

## Direction (decisions from review)

Captured from the review of this note with the steering dev. These are the calls that shape where the framework model goes, and they re-weight the recommendation above.

1. **"Team" is the unit, not "organization."** Team is more agnostic. A team is a durable unit anchored by a **repo as its knowledge base**.
2. **There is no `Team` entity today; it would be new.** The closest existing things are `room_groups` (navigation over rooms) and a `room`, neither of which is a team. If team becomes the durable unit that blueprints instantiate, make it a first-class entity rather than overloading `room_group`.
3. **Tasks are externalized to the tracker (Jira), not modelled as rooms.** Since work is routed to an agent rather than owned by it (as in CrewAI), a task lives in Jira and is *referenced*. This deliberately moves away from rooms-as-tasks and the room proliferation it causes: a task should be lighter than a room.
4. **Two clean layers, agent template inside team template.** The agent-anatomy entities (subagents, skills, MCP, hooks, memory/instructions, commands, permissions) are the **agent** layer, what an agent template bundles. The **team** layer is composition: which agents, their roles, the shared repo/knowledge, shared credentials, and the coordination shape. A team blueprint encodes a fleet by referencing agent templates.
5. **Agent templates are the primary near-term bet**, ahead of multi-room room templates. Preference is explicit: agent templates first.
6. **Team blueprints are the product: "startup in a box."** A named fleet (roster of agents + roles + shared repo + credentials + routines + triggers) you instantiate and direct. This is the marketplace unit, and it should encode a whole fleet, not a single agent.
7. **Parameterization stays the key enabler**, blueprints are filled per instantiation.
8. **Open decision: team-scoped credentials.** A blueprint needs to carry shared team resources (e.g. a newsroom's stock-image API) so its agents can use them. That requires a team-scoped, encrypted secret store, which does not exist today and cuts against the current "references are pointers, agents bring their own keys" stance. Lean: build it, because a blueprint that cannot carry its own access is not a product.
9. **Want a visual fleet view (observability, not authoring).** A live map of who is on what, which room, which role, which Jira task, over rooms + agents + roles + tasks. Distinct from Flowise-style visual programming (wiring a pipeline); this is watching a team work, not building one on a canvas.
10. **Keep the team visible and inhabitable.** The template stamps out a place you can walk into and see and direct, not a black box that returns an answer.
11. **A team is a durable entity, not a list of rooms.** Rooms are transient; a team is permanent. Building a team as a bag of rooms fuels amnesia (knowledge dies when a room archives) and liveness stress (chasing sessions across rooms). The durable substrate is the **team itself** (roster + repo + roles/policies + credentials), with **memory in the repo and the tracker, never in a room**. Switch's own patterns already say "state lives in your tracker and your repository; the room is a workspace, not a database", the amnesia is what happens when that is ignored.
12. **Default topology: one durable main room per team, not a room per task.** The main room is always on and is where the team lives; tasks are threads in it (the banner-thread pattern) or Jira items. A separate work room is the exception, created only when a task needs isolation (its own branch/worktree, different membership, an audit boundary like releases), and it flushes its memory to the repo/tracker before it archives. Louis's room-per-task setup is the "what it looks like at scale" reference, not the recommended default; room-per-task is a Switch-specific habit no other product shares and is the source of the blow-up.
13. **Aliveness: routines + triggers (the one genuine new capability).** Agents feel dead because you must ping them and they have no recurring behaviour. A team needs (a) **routines**, a cadence of its own (standups, triage sweeps, digests, watches), and (b) **event triggers**, reacting to a PR opening / bug filed / message landing, not only `@`-mentions. This is the one item that is *not* packaging: it needs a real scheduler/trigger layer (or a blessed convention), since Switch has no scheduler today (`external/switch-has-no-scheduler`). The market (Manus, Replit, Lindy scheduled tasks + triggers) has closed this; Switch has not, and closing it is central to the "alive, inhabitable team" pitch.
14. **Collaborator identity: a CRN-keyed profile as durable team context.** A team needs to know *who it collaborates with*, the same person recognised across channels (Slack, Teams, ...), and eventually external clients, keyed by a stable id (a CRN, ARN-style: `crn:…:person/…`, later `crn:…:client/…`). Switch already resolves a person's identity across channels at the account level (`ExternalUserClaim`, many-to-many; "unclaimed is not trusted by default"). Missing, and to build: (a) a rich collaborator **profile** (role, relationship, context, preferences) hung off the CRN, and (b) **external parties / clients** as a first-class entity, since Switch models only internal users and agents today. Referenceable from rooms, addressing policies, memory and team blueprints. Like routines/triggers, this is more new-capability than packaging, and it carries privacy/governance weight.

### Three exemplar blueprints to develop

1. **The Switch workforce (Louis's fleet), documented and simplified.** The team that builds Switch itself, and the reference blueprint. Read from the live instance, its composition is:
   - a **workstream hub** as the intake/portfolio layer (work is requested here);
   - a **workforce manager** (`switch-workforce-manager`), now split per workstream (`switch-workforce-manager-framework`, `-interconnectivity`, `-platform`): the coordinator that files a CHOO ticket, creates a branch and a per-item execution room, dispatches a worker, tracks it to done, and archives the room;
   - **workers** (`switch-worker-louis-local`, `switch-worker-louis-remote`, plus contributors' own) that plan-then-implement in isolation;
   - **specialists**: `switch-usecase-builder`, `switch-onboarding-manager`, `switch-expert` / `switch-expert-fast`, and bug/feature agents (`cc-bug-fixing-2`, `cc-switch-feature-requests`);
   - **CHOO/Jira** as the system of record, **GitHub** for branches and PRs, and **Louis** as the human approver and merge authority.

   Flow: hub intake → manager files CHOO + branch + execution room → worker plans with the human, then implements and posts verification → PR review → Louis merges → manager closes Jira (human-gated) → room archived. The load-bearing detail for the template model: the workflow logic lives in **room instructions, roles and aliases**, not hard-coded per agent (Louis's own observation). This is the blueprint a fleet owner recognizes their own setup in, and it is the fleet that dispatched and is running this very task.
2. **A newsroom / comms desk.** Roles: editor (exclusive), reporters (shared), fact-checker, publisher. Shared references: style guide, CMS, stock-image API (the credentials case). Flow: pitch → draft → review → publish.
3. **A hotel ops desk (booking.com-style).** Roles: front-desk, reservations, housekeeping-coordinator, guest-comms. References: the booking/PMS system, rate calendar, guest inbox. A domain the dev can sanity-check against a real operation.

_Precedent for team blueprints, who already ships a bundled fleet and the recurring role compositions, is in section 5 under "Bundled fleets and team blueprints." Short version: MetaGPT, ChatDev and Magentic-One ship fixed named teams; CrewAI, Relevance AI, Lindy and Beam let users assemble one; Manus notably does not (single agent plus a swarm of identical generalists). No one ships a browse-and-deploy blueprint marketplace, which is the open space._

## 1. Where Switch is today

Read from the code (`core/switch_core/db/models.py`, `room_service.py`, `rooms_yaml.py`), not the pitch.

### The primitives

- **Room**: a chat channel with a briefing. The fields that carry weight: `instructions` (the briefing every agent reads when it joins), `bridge_id` + `external_channel_id` (the platform channel it mirrors), `channel_type`, `group_id`, read/write visibility, `protection_config`, `observe_config`, `admin_mode`, `archived_at`. A bridged channel maps to at most one room.
- **Agent**: an identity plus a connector. `name`, `display_name`, `icon_url`, `agent_type` (its reachability class), `connector_type`, `integration_profile`, `owner_id`, `parent_agent_id` (subagents: Claude Code child agents brought in under a parent), and `addressing_policy` (a stored allow-list of who may address it; null = open). Agents are not created by agents: identity, credentials and runtime are a human step in the Console.
- **Role** (`RoomRole`), a per-room, assumable instruction bundle: `name`, `instructions`, `exclusive`. A hat you put on: assume, receive the instructions, act, release. Exclusive means at most one live holder (leased, auto-released on disconnect). The code calls roles "the forward-compatible home for the future 'deterministic rules for rooms' work" and already carries an unused `eligibility` ACL hook.
- **Reference**: a typed pointer to material outside Switch, carrying instructions. `type` (GitHub, Confluence, Google Drive, Jira, plus user-defined types), `name`, `description`, `instructions`, `value`. Registered once, attached to many rooms. `ReferenceType` is itself a first-class, user-extensible entity.
- **Document**: content the room holds itself. Either a *library* document (owned by a person, attachable anywhere) or a *room-scoped* document (an agent writes it as it works; never leaves the room). Both carry instructions.
- **Package**: a named bundle of references + documents with its own instructions. Built in the Gateway; an agent can attach one but cannot create or edit one. Cannot nest; cannot hold a room-scoped document.
- **Room group**: a tree (`parent_group_id`). Navigation, and one of the scopes an addressing policy can name. A room sits in at most one group.
- **Room link**: a directed pointer from one room to another with a free-text label. One-way, and grants nothing (a signpost, not access).
- **Bridge**: a chat-platform connection (Slack, Mattermost, ...). Carries `is_default` and `channel_creation_enabled`.
- **Alias**: a per-room handle for an agent (`@worker`), so a long qualified name is addressable short in one room.
- **Skill**: a versioned, packaged capability (`name`, `version`, `package_uri`, `visibility`), attachable to both agents (`agent_skills`) and rooms (`room_skills`). Already first-class in the schema.

One shape to notice: everything reusable in Switch, reference, document, package, skill, role, carries its **own `instructions` field**. Switch's unit of reuse is "material plus a note on how to use it," not raw material. That instinct is the seed of the template model.

### The one templating artifact, and the gap

The only thing in Switch that stamps a shape out of a declaration is `rooms_yaml.py`, and its own docstring is candid about how far it goes: it is "the first step toward configurable room-network packages," and "v1 is deliberately a single-room bootstrap tool: one `room:` mapping is parsed into a fully-resolved `RoomSpec` (no parameters / no templating)." It parses one `room:` mapping into a `RoomSpec`, provisions it on top of the `create_room` primitive, and exports the inverse (a live room round-trips back to YAML).

Two gaps, both concrete:

1. **No parameters, no templating.** `RoomSpec` is fully resolved: literal names, literal instructions. There is no way to say "a payments-shaped room for team X" and fill in X. Standing up the same shape twice means editing the YAML twice.
2. **The declarative surface is a strict subset of the primitive.** `RoomSpec` exposes `name`, `description`, `instructions`, `bridge`, `channel_type`, visibility, `agents`, `users`, `roles`, `references` (attach-by-id/name or define-inline) and `docs`. The `create_room` primitive (`RoomCreateConfig`) additionally accepts `group_id`, `package_ids`, `linked_rooms`, `aliases`, `include_subagents_for`, `join_event_listeners`, and `protection_config` / `observe_config` / `admin_mode`. So even for a *single* room you cannot declare a group, a package, a link, an alias, or subagent inclusion from YAML, the exact ingredients the "grow into an organization" doc says you reach for once one room stops being enough.

And there is **no multi-room artifact at all**. `RoomLink` / `LinkedRoomSpec` only point at rooms that already exist; nothing declares "these three rooms, linked this way, filed in this group, sharing this package" as one unit. The docs describe that shape in prose, "a shape the next team can reuse", and stop. Narrative with no artifact behind it is the whole workstream.

## 2. OSS agent-team tooling

_How a **team** is expressed: roles, task graphs, handoff. What is reusable or templated, and at what granularity._

### CrewAI, the two-layer YAML

CrewAI splits a crew's configuration into two YAML files: a **personas** layer (`config/agents.yaml`) and a **work** layer (`config/tasks.yaml`). A Python `@CrewBase` class binds them into a runnable crew.

> **Currency note.** CrewAI's hosted docs now lead new projects with a JSON-first model (`crew.jsonc`, `crewai run`). The two-file YAML below is the still-fully-supported "classic" pattern (`crewai create crew <name> --classic`), not the 2026 default. The files below are the canonical classic-template files from `crewAIInc/crewAI` (fetched 2026-09-07).

**`agents.yaml`**: who is acting. Each key is an agent; the load-bearing fields are `role`, `goal`, `backstory`, and (optionally) `llm`, `tools`, and a long tail of tuning knobs (`max_iter`, `allow_delegation`, `memory`, `reasoning`, ...).

```yaml
researcher:
  role: >
    {topic} Senior Data Researcher
  goal: >
    Uncover cutting-edge developments in {topic}
  backstory: >
    You're a seasoned researcher with a knack for uncovering the latest
    developments in {topic}. ...
```

**`tasks.yaml`**: what gets done. Each key is a task; the two required fields are `description` and `expected_output`, plus `agent` (which persona does it), `context` (which prior tasks feed it), `output_file`, guardrails, and so on.

```yaml
research_task:
  description: >
    Conduct a thorough research about {topic}
    Make sure you find any interesting and relevant information given
    the current year is {current_year}.
  expected_output: >
    A list with 10 bullet points of the most relevant information about {topic}
  agent: researcher
```

**How they bind.** A task names its agent by the agent's YAML key (`agent: researcher`). The YAML keys must match the `@agent` / `@task` method names in `crew.py`; `@CrewBase` loads both files, and `@crew` assembles agents + tasks + a `process` (`sequential` by default, or `hierarchical`, which inserts a manager agent that delegates). Task-to-task ordering is explicit via `context: [prior_task]`.

**Templating.** The one real parameterization primitive is `{variable}` interpolation: placeholders in any field of either file are filled from `kickoff(inputs={'topic': 'AI LLMs', ...})` at run time. It is string substitution, not conditionals or loops. A crew is reused by re-running it against different inputs; there is no native YAML-level "import this agent/task into another crew" (reuse across crews means sharing files or Python, or composing whole crews via CrewAI Flows).

**Why the split, and does it earn its keep.** CrewAI's stated rationale (assembled from its docs, no single maintainer manifesto found): decouple prompt/role/task text from code so behaviour is editable without touching Python, keep definitions declarative and centralized, and let the persona axis (who) and the work axis (what) vary independently. It half-earns it. The separation is genuinely useful and the interpolation is the good idea. But the classic pattern still cannot run from YAML alone: every agent and task needs a decorated Python stub, tools/callbacks/LLM objects are wired in code, and the "YAML key equals method name" convention is a silent-failure surface. A closed feature request (#1474) asked for fully-YAML agents/tasks to kill the boilerplate; CrewAI's actual answer was the newer JSONC path, not fixing the YAML one. So the two-file split is a sound *conceptual* separation wrapped around a leaky *mechanical* one.

**Verdict against Switch's primitives:**

- **Maps cleanly.** The persona/work separation already exists in Switch, along a *better* axis: the **agent** is the portable persona (identity + instructions + skills, reusable across every room), and the **room's instructions** are the work brief (`shape/hub-and-execution-rooms`: "the room instructions carry the brief"). CrewAI's `agents.yaml` ≈ a Switch agent; its `tasks.yaml` ≈ a room's instructions. Switch is in fact *stronger* on persona reuse: a Switch agent is a first-class identity attached to many rooms, where a CrewAI agent is bound to its crew class.
- **Would have to build.** (1) `{variable}` interpolation, the parameterization `rooms_yaml` explicitly lacks. This is the single most transferable idea: a room/team template with `{variables}` filled at instantiation. (2) `process` (sequential/hierarchical) is deterministic control flow; Switch has none (no scheduler; roles are the code's own "forward-compatible home for deterministic rules for rooms"). A crew's ordered task graph maps onto that unbuilt rules layer.
- **Doesn't apply.** CrewAI's task graph as a literal in-process DAG runner. Switch execution is conversational and human-in-the-loop, not a batch runner stepping a DAG; the "team" is a room people and agents talk in, not a `kickoff()`.

### AutoGen / AG2, LangGraph, OpenAI Agents SDK

Three more OSS frameworks. The interesting axis across them is not how they run a team but whether a team can be *declared* rather than coded.

- **AutoGen (Microsoft 0.4+) / AG2.** A team is a `Team` class (`RoundRobinGroupChat`, `SelectorGroupChat` where an LLM picks the next speaker, `Swarm` using `HandoffMessage`) or, in the AG2 fork, a `GroupChat` + `GroupChatManager`. It is the **only** framework here with a genuine declarative team spec: every component (team, agent, tool, model) serializes to JSON via `dump_component()` / `load_component()`, and the **AutoGen Studio** UI is built directly on that JSON. That is the existence proof that a declarative, UI-instantiable team definition is workable.
- **LangGraph.** There is no team primitive: a multi-agent system is just a `StateGraph` whose nodes are agents or subgraphs. Handoff is `Command(goto=...)`; supervisor and swarm topologies ship as thin builder libraries (`langgraph-supervisor`, `langgraph-swarm`) that emit an ordinary graph. There is no declarative team format; `langgraph.json` is only a deployment manifest pointing at code.
- **OpenAI Agents SDK.** No team object either. Orchestration is a `Runner` plus a graph of `Agent`s wired by handoffs, and a handoff is simply listing one `Agent` in another's `handoffs` list, surfaced to the model as a `transfer_to_<agent>` tool. Reuse is agent objects, `clone()`, and `agent.as_tool()`.

**Verdict against Switch's primitives:**

- **Maps cleanly.** The reusable unit in all three is the **agent object**, which is exactly Switch's agent. The OpenAI SDK's handoff (one agent handing control to another, exposed as a tool) is conceptually Switch's `messaging/agents-ask-each-other-by-addressing`: an agent gets another to act by addressing it. Switch already does agent-to-agent handoff, just conversationally rather than as a typed tool call.
- **Would have to build.** A **declarative team spec a UI can instantiate**: AutoGen's JSON + Studio is the nearest analogue to a Switch "room/team template" plus a Gateway builder that stamps it out. And, again, deterministic control flow (graph edges, speaker selection) is the unbuilt "rules for rooms" layer.
- **Doesn't apply.** The in-process actor/graph runtime. These frameworks run a team as a program to completion; Switch runs a team as a standing room with humans in it. Their orchestration primitive is a call stack; Switch's is a conversation.

**Common thread across the OSS frameworks.** A declarative team definition is the exception (only AutoGen has one), and even there it describes a single-process program, not a durable, human-inhabited organization. None of these model what Switch models: persistent rooms, humans in the loop, work spread across a network of rooms. Switch's real peers in spirit are not these runtimes but the productized-agent and frontier-CLI worlds below.

## 3. Flowise, ontology

Flowise is an open-source, node-graph-centric visual builder. Everything a user builds is a **flow**: a graph of typed nodes and edges, persisted as JSON, wrapped around a set of first-class supporting objects.

**First-class entities:**

- **Flow**: the thing you build. Three visual builders in ascending capability: **Assistant** (beginner: instructions + tools + RAG), **Chatflow** (single-agent / simple LLM flows), **Agentflow** (the superset: single- and multi-agent orchestration; current version is Agentflow V2, a native redesign with loops, branching and human-in-the-loop). Under the hood these are *not* separate tables: all three are rows in one `ChatFlow` entity discriminated by a `type` column (`CHATFLOW | AGENTFLOW | MULTIAGENT | ASSISTANT`), verified in source (`packages/server/src/database/entities/ChatFlow.ts`).
- **Nodes**: the atomic units of a flow. Typed, with input/output anchors. Agentflow V2 has ~15 node types (Start, LLM, Agent, Tool, Retriever, HTTP, Condition, Condition Agent, Iteration, Loop, Human Input, Direct Reply, Custom Function, Execute Flow, Sticky Note).
- **Tools**: reusable callable capabilities (built-in, user-defined Custom Tools in JS, and MCP tools) that attach to Agent nodes.
- **Document Stores**: centralized RAG knowledge bases: loaders → splitters → embeddings → vector store, referenced by retriever nodes and by an agent's Knowledge slot.
- **Credentials**: encrypted, reusable auth objects referenced by nodes rather than inlined; shareable across workspaces.
- **Variables**: static or runtime (`.env`) values referenced in nodes as `$vars.name`, overridable per request via `overrideConfig`.
- **Marketplace / Templates**: pre-built flow and tool templates you instantiate as a starting point (24+ chatflow templates ship in the repo); flows also export/import as JSON.
- **Workspaces / Organizations / RBAC**: the tenancy layer that partitions all of the above.

**How it composes:** a flow is `{ nodes, edges }`; nodes carry a `category`/`type` and typed anchors; edges wire one node's output anchor to another's input. Document Stores feed retriever nodes and agent Knowledge; Tools attach to Agent nodes; Credentials attach to provider nodes; Variables are referenced inside node fields; `$flow.state` is a per-run key-value store shared across nodes in one execution. Multi-agent is explicit graph orchestration (supervisor/worker is a *pattern* you wire, not a primitive), and an **Execute Flow** node lets one flow call another as a sub-workflow.

**Verdict against Switch's primitives:**

- **Maps cleanly.** A **Document Store** (a curated bundle of material an agent draws on) is close to a Switch **package** of references and documents. **Tools attach to Agent nodes** the way Switch **skills** attach to agents. The **Marketplace of instantiable templates** + **export/import as JSON** is precisely the artifact Switch lacks and the workstream wants; Flowise proves the shape (a named, shareable, instantiable flow definition) is viable. **Variables + `overrideConfig`** are the parameterization Switch's `rooms_yaml` is missing.
- **Would have to build.** The template marketplace / export-import / parameterization layer. And the node-graph orchestration itself is deterministic control flow (loops, conditions, sequencing), the same "deterministic rules for rooms" gap CrewAI's `process` exposes.
- **Doesn't apply.** The visual node-graph canvas *as the authoring model*: Switch is chat-native, so the "flow" is a conversation in a room, not a DAG drawn on a canvas. Wiring agents by dragging edges is the opposite of Switch's premise (you talk to an agent; you don't wire it). **Credentials as a first-class stored object** is a deliberate non-goal for Switch: references store a *pointer* and instructions, never the keys, and agents bring their own access. **`$flow.state`** (ephemeral per-run memory) has no analogue and needs none: Switch state lives in the room, the repo and the tracker, not in a run.

## 4. Frontier-lab agent apps, the converging entities

Claude Code, Gemini CLI and Codex are independently converging on the same vocabulary of configuration and extension entities. What is genuinely converging across all three:

- **MCP servers**: total convergence; the same open protocol (Anthropic-originated) with a `/mcp` surface in each. The strongest convergence of the set.
- **Skills (`SKILL.md`)**: all three, with the same progressive-disclosure model (name + description first, body on use). A cross-tool `.agents/skills` directory is emerging (native in Codex, aliased in Gemini).
- **Subagents**: all three (Claude and Gemini as markdown files with YAML frontmatter in an `agents/` dir; Codex via TOML config).
- **Memory / context file**: all three use a root Markdown instructions file with hierarchical merge (`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`).
- **Hooks**: all three (Codex still beta); Claude and Codex even share PascalCase event names (`PreToolUse`, `SubagentStop`, ...).
- **Slash / custom commands, permissions/sandbox/approval/trusted-folders, and hierarchical settings files**: all three, with shared vocabulary (JSON for Claude/Gemini, TOML for Codex).

Not symmetric: **plugin/extension packaging + a marketplace** is first-class in Claude (Plugins + Marketplaces) and Gemini (Extensions), but absent as a first-party layer in Codex. A plugin/extension bundles the rest, skills, hooks, subagents, MCP servers, commands, into one installable, distributable unit.

Two emerging cross-lab standards are worth naming: **MCP** (Anthropic, now universal here) and **AGENTS.md** (stewarded by the Agentic AI Foundation under the Linux Foundation, 60k+ repos; Codex reads it natively, Gemini via config, Claude keeps `CLAUDE.md` by design but interoperates).

**Verdict against Switch's primitives:**

- **Maps cleanly.** **Skills** are already a first-class Switch entity (`agent_skills`, `room_skills`). **Subagents** are already modelled: `Agent.parent_agent_id` exists explicitly to bring Claude Code child agents into Switch under a parent. The **memory/context file** is conceptually Switch's `instructions`, a room's briefing and an agent's instructions, layered the way `CLAUDE.md`/`AGENTS.md` merge hierarchically. **Permissions** map onto Switch's `addressing_policy` + room visibility + `protection_config` (a different axis, who may address an agent, versus what a tool may do, but the same "declared allow-list" shape). **Hooks** have a real analogue: Switch already mediates every local tool call for governance (a platform-level `PreToolUse`).
- **Would have to build.** The **plugin/extension bundle + marketplace** is the single most important lesson here for the *agent template* question. The frontier CLIs show the agent-extension surface (subagents + skills + MCP + hooks + memory + commands + permissions) converging into one packaged, shareable, installable unit with a catalogue. Switch already has every one of those pieces as a first-class entity, it lacks the *bundle* and the *catalogue*. A Switch agent template should be exactly that bundle.
- **Doesn't apply.** The CLI-local mechanics: file paths, TOML-vs-JSON, OS-kernel sandboxing, `.claude/` vs `.gemini/` directory layouts. These are how a single agent is configured on one machine; Switch operates a layer up, orchestrating agents that already carry their own such config. MCP servers as a Switch-modelled entity fall here too: they live inside the agent's own runtime, not in Switch's orchestration model (though an agent template may want to *declare* them, see the recommendation).

## 5. Productized "spin up an agent"

Across Manus and its peers the out-of-the-box unit is consistent: a **task or session**, not a configured "agent object." The user writes a natural-language goal; the environment, tool wiring, planning loop and sub-agent orchestration are pre-built and hidden. What differs between products is what the user gets to *keep and reuse*.

- **Manus.** Each task spins up its own isolated cloud VM (browser, terminal, filesystem, on E2B). The user picks a mode (Agent / Chat) and writes the goal. What is templated away: the sandbox, tool selection, the planner/executor/verifier decomposition, and sub-agent orchestration (its "Wide Research" fans a task across many parallel sub-agents). What the user can reuse: **Agent Skills** (reusable workflow modules written as Markdown, progressive-disclosure loading, portable via an "open standard" and a **Team Skill Library**: explicitly positioned against Claude Skills), **Scheduled Tasks** (recurring runs with an output destination), and **Playbooks** (a catalog of starting-point templates). Weakest axis: durable cross-task memory.
- **Peers, same lens.** OpenAI's **ChatGPT Agent** (a task in a cloud "virtual computer"; user configures connector permissions and takes over for logins). **Genspark** (a "Mixture-of-Agents" router picks model and tools; user connects an MCP store of integrations). **Devin** (a per-session coding sandbox ending in a PR; user configures a codebase **knowledge base** and approves an interactive plan). **Replit Agent** (builds and deploys apps in a browser cloud; user sets an autonomy level and can roll back to checkpoints; can itself build other agents and scheduled automations). **Lindy** (the outlier: a no-code **agent builder** where the reusable unit is front-and-centre, 100+ templates, custom agents, triggers, multi-agent handoffs).

**Synthesis.** What is consistently templated away: the execution environment (an isolated sandbox per task), tool selection and wiring, the planning loop, and sub-agent orchestration. What users get to reuse: **skills + schedules + knowledge**: and of those, knowledge/memory is the least mature across the whole category.

**Verdict against Switch's primitives:**

- **Maps cleanly.** Manus **Agent Skills** ≈ Switch **skills** (both are packaged, Markdown, attachable, progressively disclosed); a **Team Skill Library** ≈ Switch's shared skills and packages. Devin's and Manus's **Knowledge** ≈ Switch **references / documents / packages** (curated material carrying instructions). **Lindy's template library** ≈ exactly the room-template artifact this workstream wants, a catalogue of instantiable shapes.
- **Would have to build.** A **template / playbook catalogue** of instantiable shapes (Lindy and Manus Playbooks both have one; Switch has none). **Scheduled / recurring runs**: Switch has no scheduler at all (`external/switch-has-no-scheduler`), a gap these products have solved and a natural companion to templates ("stand up this shape every Monday"). The per-task isolated workspace pattern is already Switch idiom at the design level (`shape/hub-and-execution-rooms` + `external/worktree-per-parallel-task`); productizing it is the step not yet taken.
- **Doesn't apply.** The cloud VM / sandbox as a Switch primitive: Switch agents run on their own hosts, and Switch orchestrates rather than provisions compute. And the **hidden planning loop** is a deliberate philosophical divergence: these products hide the whole organization *inside one agent* (planner, executor, verifier, sub-agents, all invisible), whereas Switch makes the organization **explicit**: rooms, roles, and named agents you can see, address and correct. That contrast is the sharpest thing in this whole scan, and it belongs in the recommendation: Switch's template should stamp out a *visible, inhabitable* team, not a black box.

### Bundled fleets and team blueprints

The single-agent products are one half. The other half is the small but real set of tools that ship a **fleet** as the unit, the "startup in a box" precedent. Two shapes:

- **Fixed, named teams shipped as one instantiable object.** Microsoft **Magentic-One** (Orchestrator + WebSurfer + FileSurfer + Coder + ComputerTerminal). **MetaGPT** (a "software company": Product Manager, Architect, Project Manager, Engineer, QA, run as an assembly-line SOP). **ChatDev** (a "virtual software company": CEO/CPO/CTO, programmer, designer, tester, over a chat-chain waterfall). All fixed-role, pipeline- or orchestrator-shaped, and code-generation-centric.
- **Team-as-unit but user-assembled.** **CrewAI** (a "Crew"; ~16 ready-to-run example crews in its examples repo, plus a no-code Crew Studio that generates a crew plan with per-agent role/goal/task). **Relevance AI** ("AI Workforce", pitched literally as "an org chart where every role is an agent"). **Lindy** ("Societies of Lindies"). **Beam AI** (per-function agent templates you assemble).

Two counter-examples worth naming, because they are easy to assume wrongly: **Manus is not a team bundle.** It is a single general agent plus task **Playbooks**, and its "Wide Research" fans out a swarm of *identical generalists*, explicitly contrasted by Manus against role-differentiated teams. **Artisan** markets separate single-role "AI employees" (Ava, Aaron, Aria), not a team you deploy together.

**Recurring role compositions:** (1) orchestrator/coordinator + specialists (hierarchical); (2) the software-team SOP, PM + Architect + Engineer + QA, sometimes over a CEO/CTO layer; (3) research → build/write → review pipelines; (4) the go-to-market split, prospect → qualify → outreach → customer success. Underneath, two structures recur: a **pipeline / assembly line** with typed handoffs, and an **orchestrator with workers**.

**The gap is the opportunity.** No product ships a browse-and-deploy **marketplace of role-differentiated team blueprints**. Frameworks ship *example* teams (CrewAI, Magentic-One, MetaGPT); vertical products ship *building canvases + component templates*. The team-as-catalogue-item, instantiated with parameters, is an open space (absence-of-evidence from this scan, not proof, but nothing surfaced) and it is exactly the "startup in a box" blueprint catalogue the recommendation points at. The way to win it is Switch's own differentiator: a blueprint that stamps out a team with **humans in it**, visible and directable, not a code-generation black box.

## 6. Verdict matrix

Every idea from the scans, sorted into three buckets against Switch's primitives.

### Maps cleanly onto something we already have

| External idea | Seen in | Switch primitive |
|---|---|---|
| Persona/work separation | CrewAI (`agents.yaml` vs `tasks.yaml`) | Agent (portable persona) vs room `instructions` (the work brief), and Switch is cleaner: an agent is one identity reusable across rooms |
| The agent object as the reusable unit | AutoGen, AG2, LangGraph, OpenAI SDK | Agent |
| Agent-to-agent handoff surfaced as a tool | OpenAI Agents SDK | Addressing another agent in a room (`agents-ask-each-other-by-addressing`) |
| Skills / `SKILL.md` | Manus, Claude Code, Gemini CLI, Codex | Skill (first-class; attaches to agents and rooms) |
| Subagents | Claude Code, Gemini CLI, Codex | `Agent.parent_agent_id` (models Claude Code subagents explicitly) |
| Hierarchical memory / context file | `CLAUDE.md` / `GEMINI.md` / `AGENTS.md` | Room `instructions` + agent instructions, layered |
| Permissions allow-list | frontier CLIs | `addressing_policy` + room visibility + `protection_config` |
| Tool-call interception / `PreToolUse` hook | frontier CLIs | Switch's governance mediation of every local tool call |
| Curated knowledge bundle | Flowise Document Store; Devin/Manus Knowledge | References + documents + packages |
| Tools attach to an agent | Flowise | Skills attach to an agent |

### Maps onto something we would have to build

| External idea | Seen in | What it would take |
|---|---|---|
| **`{variable}` parameterization at instantiation** | CrewAI interpolation; Flowise Variables / `overrideConfig` | Parameters in the room/team spec, filled at create time. `rooms_yaml` has none. **Highest-leverage single item.** |
| **A multi-object shape as one instantiable, shareable unit + a catalogue** | Flowise Marketplace; Lindy templates; Manus Playbooks; AutoGen JSON + Studio | The room template + agent template artifacts, plus a library to instantiate from. **This is the workstream.** |
| Deterministic control flow / ordering | CrewAI `process`; LangGraph edges; Flowise nodes; AutoGen speaker selection | The "deterministic rules for rooms" layer that `RoomRole` is already the code's stated stub for |
| A plugin/extension bundle + marketplace | Claude Code Plugins, Gemini Extensions | The agent template: bundle skills + references + addressing policy + subagents into one installable unit |
| Scheduled / recurring runs | Manus, Replit, Lindy | An external trigger convention (Switch has no scheduler; `external/switch-has-no-scheduler`), a natural companion to templates |
| Expanding the declarative surface to match the primitive | our own `rooms_yaml` gap | Let the YAML express group, package, link, alias, subagent inclusion, everything `create_room` already takes |

### Does not apply, and why

| External idea | Seen in | Why not |
|---|---|---|
| In-process DAG / actor runtime, run to completion | CrewAI `kickoff`, LangGraph, AutoGen, OpenAI `Runner` | Switch is a standing room, conversational and human-gated, not a program that terminates |
| Visual node-graph canvas as the authoring model | Flowise | Switch is chat-native; you talk to an agent, you don't wire it on a canvas |
| Credentials as a first-class stored object | Flowise | Deliberate non-goal: references store a pointer + instructions, never keys; agents bring their own access |
| Ephemeral per-run state | Flowise `$flow.state` | Switch state lives in the room, the repo and the tracker, not in a run |
| Per-task cloud VM / sandbox provisioning | Manus, ChatGPT Agent, Devin, Replit | Switch orchestrates agents that run on their own hosts; it does not provision compute |
| Hidden planning loop / the org inside one agent | Manus and peers | Switch makes the organization **explicit**: visible, addressable rooms/roles/agents. A philosophy divergence, not just an absence |
| CLI-local mechanics (paths, TOML vs JSON, OS sandbox) | frontier CLIs | These configure one agent on one machine; Switch operates a layer up |

## 7. Research-agent as the first use case

This task was a dry run of a productized research agent. Reading back what it actually needed is the cheapest way to see what a "research agent template" would stamp out.

What this run used:

- **A home room whose instructions carried the whole procedure and the instance data**: the task card: the Jira key, the branch, the hub thread id, the repo, the write-out-loud rules. That is `knowledge/procedure-vs-bindings` exactly: portable how-to in the agent, instance data in the room instructions.
- **A worktree per task** (`external/worktree-per-parallel-task`), set up by hand.
- **Parallel sub-agents, one per research area**: done here with the agent runner, but ad hoc. A template would declare "fan out one researcher per area" rather than leaving it to the agent to improvise.
- **A place to report and a human gate**: the hub banner thread, plus human-approved readiness and merge.
- **Skills the agent leaned on**: commit/PR style, anti-AI-slop prose, knowledge distillation.

So a **research-agent template** decomposes into exactly the two artifacts from the recommendation:

- an **agent template**: identity + research skills + web/citation tooling + a "cite everything, admit gaps" discipline in its instructions; plus
- a **room template**: a per-task work room carrying the procedure, a worktree convention, a declared fan-out of sub-researchers, and a report-to-hub-then-gate flow.

Two things stand out. First, **every piece the template would stamp out already exists** as a Switch primitive or a documented pattern, more evidence that this is packaging, not new primitives. Second, the one genuinely missing mechanic this task exposed is the same one section 0 leads with: **parameterization.** The task card was hand-written and fully resolved; a template would have generated it from `research(jira_key, branch, hub_thread, repo, areas[])`. Building the research agent well requires parameters first, which is a good reason to make the research agent the first use case: it forces the highest-leverage piece.

## Sources

Internal (this repo): `docs/official/building/payments-room.md`, `docs/official/building/grow-into-an-organization.md`, `switch-expert/knowledge/PATTERNS.md` and `INDEX.md`, `core/switch_core/db/models.py`, `core/switch_core/room_service.py`, `core/switch_core/rooms_yaml.py`.

**CrewAI** (classic two-file template still supported; docs now lead with a JSONC model, flagged in §2):
- Template files: `https://github.com/crewAIInc/crewAI/blob/main/lib/cli/src/crewai_cli/templates/crew/config/agents.yaml`, `https://github.com/crewAIInc/crewAI/blob/main/lib/cli/src/crewai_cli/templates/crew/config/tasks.yaml`, `https://github.com/crewAIInc/crewAI/blob/main/lib/cli/src/crewai_cli/templates/crew/crew.py`
- Concepts: `https://docs.crewai.com/en/concepts/agents`, `https://docs.crewai.com/en/concepts/tasks`, `https://docs.crewai.com/en/concepts/crews`; quickstart `https://docs.crewai.com/en/quickstart`
- Full-YAML feature request (closed): `https://github.com/crewAIInc/crewAI/issues/1474`

**AutoGen / AG2, LangGraph, OpenAI Agents SDK:**
- AutoGen teams + declarative components: `https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html`, `https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/component-config.html`; AG2 group chat: `https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/patterns/`
- LangGraph: `https://langchain-ai.github.io/langgraph/`; supervisor/swarm: `https://github.com/langchain-ai/langgraph-supervisor-py`, `https://github.com/langchain-ai/langgraph-swarm-py`
- OpenAI Agents SDK: `https://openai.github.io/openai-agents-python/`, `https://openai.github.io/openai-agents-python/handoffs/`, `https://openai.github.io/openai-agents-python/quickstart/`

**Flowise:**
- `https://docs.flowiseai.com/using-flowise/agentflowv2`, `https://docs.flowiseai.com/using-flowise/document-stores`, `https://docs.flowiseai.com/using-flowise/variables`, `https://docs.flowiseai.com/using-flowise/workspaces`
- Entity source: `https://raw.githubusercontent.com/FlowiseAI/Flowise/main/packages/server/src/database/entities/ChatFlow.ts`; templates: `https://github.com/FlowiseAI/Flowise/tree/main/packages/server/marketplaces/chatflows`

**Frontier CLIs (Claude Code / Gemini CLI / Codex) + standards:**
- Claude Code: `https://code.claude.com/docs/en/sub-agents`, `https://code.claude.com/docs/en/skills`, `https://code.claude.com/docs/en/mcp`, `https://code.claude.com/docs/en/hooks`, `https://code.claude.com/docs/en/plugins`, `https://code.claude.com/docs/en/memory`, `https://code.claude.com/docs/en/permissions`
- Gemini CLI: `https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md`, `https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md`, `https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/index.md`, `https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md`
- Codex: `https://learn.chatgpt.com/docs/config-file/config-reference`, `https://developers.openai.com/codex/skills`, `https://developers.openai.com/codex/hooks`
- Standards: `https://agents.md` (AGENTS.md); MCP (Anthropic-originated, adopted by all three)

**Productized agents:**
- Manus: `https://manus.im/docs/introduction/welcome`, `https://manus.im/blog/manus-sandbox`, `https://manus.im/features/agent-skills`, `https://manus.im/docs/features/scheduled-tasks`; Meta acquisition (Dec 2025, developing): `https://www.cnbc.com/2025/12/30/meta-acquires-singapore-ai-agent-firm-manus-china-butterfly-effect-monicai.html`
- Peers: `https://openai.com/index/introducing-chatgpt-agent/`, `https://cognition.com/blog/introducing-devin`, `https://blog.replit.com/introducing-agent-3-our-most-autonomous-agent-yet`, `https://www.lindy.ai/tools/ai-workflow-automation`, `https://venturebeat.com/ai/gensparks-super-agent-ups-the-ante-in-the-general-ai-agent-race`

**Bundled fleets / team blueprints:**
- MetaGPT: `https://github.com/geekan/MetaGPT`, `https://arxiv.org/html/2308.00352v6`; ChatDev: `https://github.com/openbmb/ChatDev`, `https://arxiv.org/html/2307.07924v5`
- Magentic-One: `https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html`, `https://arxiv.org/html/2411.04468v1`
- CrewAI examples + Crew Studio: `https://github.com/crewAIInc/crewAI-examples/tree/main/crews`, `https://docs.crewai.com/en/enterprise/features/crew-studio`
- Relevance AI Workforce: `https://relevanceai.com/workforce`; Lindy: `https://www.lindy.ai/blog/lindy-3-0`; Beam AI: `https://beam.ai/platform`; Artisan: `https://www.artisan.co/`
- Manus Wide Research (single-agent swarm, not a role team): `https://manus.im/blog/introducing-wide-research`

**Caveats carried from the research:** CrewAI's two-file YAML is the "classic" pattern, not the 2026 default. No first-party maintainer manifesto was found justifying CrewAI's persona/work split; the rationale in §2 is synthesized from its docs + issue tracker. "No declarative team spec" for AG2, LangGraph and the OpenAI SDK is a scoped negative (core pages checked, not exhaustive). Manus's Planner/Executor/Verifier architecture is analyst reconstruction, and its "100×"/benchmark and post-acquisition status are vendor or developing claims, re-verify before relying on them.
