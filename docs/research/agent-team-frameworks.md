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

CrewAI splits a crew's configuration into two YAML files: a **personas** layer (`config/agents.yaml`) and a **work** layer (`config/tasks.yaml`). A Python `@CrewBase` class binds them into a runnable crew.

> **Currency note.** CrewAI's hosted docs now lead new projects with a JSON-first model (`crew.jsonc`, `crewai run`). The two-file YAML below is the still-fully-supported "classic" pattern (`crewai create crew <name> --classic`), not the 2026 default. The files below are the canonical classic-template files from `crewAIInc/crewAI` (fetched 2026-09-07).

**`agents.yaml`** — who is acting. Each key is an agent; the load-bearing fields are `role`, `goal`, `backstory`, and (optionally) `llm`, `tools`, and a long tail of tuning knobs (`max_iter`, `allow_delegation`, `memory`, `reasoning`, ...).

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

**`tasks.yaml`** — what gets done. Each key is a task; the two required fields are `description` and `expected_output`, plus `agent` (which persona does it), `context` (which prior tasks feed it), `output_file`, guardrails, and so on.

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
- **Would have to build.** (1) `{variable}` interpolation — the parameterization `rooms_yaml` explicitly lacks. This is the single most transferable idea: a room/team template with `{variables}` filled at instantiation. (2) `process` (sequential/hierarchical) is deterministic control flow; Switch has none (no scheduler; roles are the code's own "forward-compatible home for deterministic rules for rooms"). A crew's ordered task graph maps onto that unbuilt rules layer.
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

## 3. Flowise — ontology

Flowise is an open-source, node-graph-centric visual builder. Everything a user builds is a **flow**: a graph of typed nodes and edges, persisted as JSON, wrapped around a set of first-class supporting objects.

**First-class entities:**

- **Flow** — the thing you build. Three visual builders in ascending capability: **Assistant** (beginner: instructions + tools + RAG), **Chatflow** (single-agent / simple LLM flows), **Agentflow** (the superset: single- and multi-agent orchestration; current version is Agentflow V2, a native redesign with loops, branching and human-in-the-loop). Under the hood these are *not* separate tables: all three are rows in one `ChatFlow` entity discriminated by a `type` column (`CHATFLOW | AGENTFLOW | MULTIAGENT | ASSISTANT`), verified in source (`packages/server/src/database/entities/ChatFlow.ts`).
- **Nodes** — the atomic units of a flow. Typed, with input/output anchors. Agentflow V2 has ~15 node types (Start, LLM, Agent, Tool, Retriever, HTTP, Condition, Condition Agent, Iteration, Loop, Human Input, Direct Reply, Custom Function, Execute Flow, Sticky Note).
- **Tools** — reusable callable capabilities (built-in, user-defined Custom Tools in JS, and MCP tools) that attach to Agent nodes.
- **Document Stores** — centralized RAG knowledge bases: loaders → splitters → embeddings → vector store, referenced by retriever nodes and by an agent's Knowledge slot.
- **Credentials** — encrypted, reusable auth objects referenced by nodes rather than inlined; shareable across workspaces.
- **Variables** — static or runtime (`.env`) values referenced in nodes as `$vars.name`, overridable per request via `overrideConfig`.
- **Marketplace / Templates** — pre-built flow and tool templates you instantiate as a starting point (24+ chatflow templates ship in the repo); flows also export/import as JSON.
- **Workspaces / Organizations / RBAC** — the tenancy layer that partitions all of the above.

**How it composes:** a flow is `{ nodes, edges }`; nodes carry a `category`/`type` and typed anchors; edges wire one node's output anchor to another's input. Document Stores feed retriever nodes and agent Knowledge; Tools attach to Agent nodes; Credentials attach to provider nodes; Variables are referenced inside node fields; `$flow.state` is a per-run key-value store shared across nodes in one execution. Multi-agent is explicit graph orchestration (supervisor/worker is a *pattern* you wire, not a primitive), and an **Execute Flow** node lets one flow call another as a sub-workflow.

**Verdict against Switch's primitives:**

- **Maps cleanly.** A **Document Store** (a curated bundle of material an agent draws on) is close to a Switch **package** of references and documents. **Tools attach to Agent nodes** the way Switch **skills** attach to agents. The **Marketplace of instantiable templates** + **export/import as JSON** is precisely the artifact Switch lacks and the workstream wants; Flowise proves the shape (a named, shareable, instantiable flow definition) is viable. **Variables + `overrideConfig`** are the parameterization Switch's `rooms_yaml` is missing.
- **Would have to build.** The template marketplace / export-import / parameterization layer. And the node-graph orchestration itself is deterministic control flow (loops, conditions, sequencing) — the same "deterministic rules for rooms" gap CrewAI's `process` exposes.
- **Doesn't apply.** The visual node-graph canvas *as the authoring model*: Switch is chat-native, so the "flow" is a conversation in a room, not a DAG drawn on a canvas. Wiring agents by dragging edges is the opposite of Switch's premise (you talk to an agent; you don't wire it). **Credentials as a first-class stored object** is a deliberate non-goal for Switch: references store a *pointer* and instructions, never the keys, and agents bring their own access. **`$flow.state`** (ephemeral per-run memory) has no analogue and needs none: Switch state lives in the room, the repo and the tracker, not in a run.

## 4. Frontier-lab agent apps — the converging entities

Claude Code, Gemini CLI and Codex are independently converging on the same vocabulary of configuration and extension entities. What is genuinely converging across all three:

- **MCP servers** — total convergence; the same open protocol (Anthropic-originated) with a `/mcp` surface in each. The strongest convergence of the set.
- **Skills (`SKILL.md`)** — all three, with the same progressive-disclosure model (name + description first, body on use). A cross-tool `.agents/skills` directory is emerging (native in Codex, aliased in Gemini).
- **Subagents** — all three (Claude and Gemini as markdown files with YAML frontmatter in an `agents/` dir; Codex via TOML config).
- **Memory / context file** — all three use a root Markdown instructions file with hierarchical merge (`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`).
- **Hooks** — all three (Codex still beta); Claude and Codex even share PascalCase event names (`PreToolUse`, `SubagentStop`, ...).
- **Slash / custom commands, permissions/sandbox/approval/trusted-folders, and hierarchical settings files** — all three, with shared vocabulary (JSON for Claude/Gemini, TOML for Codex).

Not symmetric: **plugin/extension packaging + a marketplace** is first-class in Claude (Plugins + Marketplaces) and Gemini (Extensions), but absent as a first-party layer in Codex. A plugin/extension bundles the rest — skills, hooks, subagents, MCP servers, commands — into one installable, distributable unit.

Two emerging cross-lab standards are worth naming: **MCP** (Anthropic, now universal here) and **AGENTS.md** (stewarded by the Agentic AI Foundation under the Linux Foundation, 60k+ repos; Codex reads it natively, Gemini via config, Claude keeps `CLAUDE.md` by design but interoperates).

**Verdict against Switch's primitives:**

- **Maps cleanly.** **Skills** are already a first-class Switch entity (`agent_skills`, `room_skills`). **Subagents** are already modelled: `Agent.parent_agent_id` exists explicitly to bring Claude Code child agents into Switch under a parent. The **memory/context file** is conceptually Switch's `instructions` — a room's briefing and an agent's instructions, layered the way `CLAUDE.md`/`AGENTS.md` merge hierarchically. **Permissions** map onto Switch's `addressing_policy` + room visibility + `protection_config` (a different axis — who may address an agent, versus what a tool may do — but the same "declared allow-list" shape). **Hooks** have a real analogue: Switch already mediates every local tool call for governance (a platform-level `PreToolUse`).
- **Would have to build.** The **plugin/extension bundle + marketplace** is the single most important lesson here for the *agent template* question. The frontier CLIs show the agent-extension surface (subagents + skills + MCP + hooks + memory + commands + permissions) converging into one packaged, shareable, installable unit with a catalogue. Switch already has every one of those pieces as a first-class entity — it lacks the *bundle* and the *catalogue*. A Switch agent template should be exactly that bundle.
- **Doesn't apply.** The CLI-local mechanics: file paths, TOML-vs-JSON, OS-kernel sandboxing, `.claude/` vs `.gemini/` directory layouts. These are how a single agent is configured on one machine; Switch operates a layer up, orchestrating agents that already carry their own such config. MCP servers as a Switch-modelled entity fall here too: they live inside the agent's own runtime, not in Switch's orchestration model (though an agent template may want to *declare* them — see the recommendation).

## 5. Productized "spin up an agent"

Across Manus and its peers the out-of-box unit is consistent: a **task or session**, not a configured "agent object." The user writes a natural-language goal; the environment, tool wiring, planning loop and sub-agent orchestration are pre-built and hidden. What differs between products is what the user gets to *keep and reuse*.

- **Manus.** Each task spins up its own isolated cloud VM (browser, terminal, filesystem, on E2B). The user picks a mode (Agent / Chat) and writes the goal. What is templated away: the sandbox, tool selection, the planner/executor/verifier decomposition, and sub-agent orchestration (its "Wide Research" fans a task across many parallel sub-agents). What the user can reuse: **Agent Skills** (reusable workflow modules written as Markdown, progressive-disclosure loading, portable via an "open standard" and a **Team Skill Library** — explicitly positioned against Claude Skills), **Scheduled Tasks** (recurring runs with an output destination), and **Playbooks** (a catalog of starting-point templates). Weakest axis: durable cross-task memory.
- **Peers, same lens.** OpenAI's **ChatGPT Agent** (a task in a cloud "virtual computer"; user configures connector permissions and takes over for logins). **Genspark** (a "Mixture-of-Agents" router picks model and tools; user connects an MCP store of integrations). **Devin** (a per-session coding sandbox ending in a PR; user configures a codebase **knowledge base** and approves an interactive plan). **Replit Agent** (builds and deploys apps in a browser cloud; user sets an autonomy level and can roll back to checkpoints; can itself build other agents and scheduled automations). **Lindy** (the outlier: a no-code **agent builder** where the reusable unit is front-and-centre — 100+ templates, custom agents, triggers, multi-agent handoffs).

**Synthesis.** What is consistently templated away: the execution environment (an isolated sandbox per task), tool selection and wiring, the planning loop, and sub-agent orchestration. What users get to reuse: **skills + schedules + knowledge** — and of those, knowledge/memory is the least mature across the whole category.

**Verdict against Switch's primitives:**

- **Maps cleanly.** Manus **Agent Skills** ≈ Switch **skills** (both are packaged, Markdown, attachable, progressively disclosed); a **Team Skill Library** ≈ Switch's shared skills and packages. Devin's and Manus's **Knowledge** ≈ Switch **references / documents / packages** (curated material carrying instructions). **Lindy's template library** ≈ exactly the room-template artifact this workstream wants — a catalogue of instantiable shapes.
- **Would have to build.** A **template / playbook catalogue** of instantiable shapes (Lindy and Manus Playbooks both have one; Switch has none). **Scheduled / recurring runs**: Switch has no scheduler at all (`external/switch-has-no-scheduler`), a gap these products have solved and a natural companion to templates ("stand up this shape every Monday"). The per-task isolated workspace pattern is already Switch idiom at the design level (`shape/hub-and-execution-rooms` + `external/worktree-per-parallel-task`); productizing it is the step not yet taken.
- **Doesn't apply.** The cloud VM / sandbox as a Switch primitive: Switch agents run on their own hosts, and Switch orchestrates rather than provisions compute. And the **hidden planning loop** is a deliberate philosophical divergence: these products hide the whole organization *inside one agent* (planner, executor, verifier, sub-agents, all invisible), whereas Switch makes the organization **explicit** — rooms, roles, and named agents you can see, address and correct. That contrast is the sharpest thing in this whole scan, and it belongs in the recommendation: Switch's template should stamp out a *visible, inhabitable* team, not a black box.

## 6. Verdict matrix

_Every pattern in three buckets: maps cleanly onto something we have; maps onto something we would have to build; does not apply, and why._

## 7. Research-agent as the first use case

_This task treated as a dry run of a productized agent. What a "research agent template" would have needed, and what that tells us about the template model._
