# AG-UI: framework-built agents

Status: **Design accepted; not yet implemented** (CHOO-1685)

This document specifies how agents built with third-party frameworks
(LangGraph, Google ADK, CrewAI, …) take part in Switch rooms over the **AG-UI
protocol**, and records the evaluation that chose AG-UI over the alternatives.

It is subordinate to `AGENT_PROTOCOL.md`, which remains authoritative for the
agent↔Switch protocol proper. This describes a *second* integration shape that
the protocol document does not contemplate: one where **Switch dials out**.

Protocol facts below were verified against `ag-ui-protocol/ag-ui@main`, npm and
PyPI on **2026-08-13**. AG-UI is pre-1.0 and ships breaking changes without a
changelog, so re-verify before relying on any specific claim.

---

## 1. The problem

Switch supports an agent that can hold an outbound connection and speak the
agent protocol: Claude Code, Codex and OpenCode all do, each through a
connector we wrote and maintain.

A framework-built agent cannot. A LangGraph graph or an ADK agent is a
request/response program behind an HTTP endpoint; it has no event loop of its
own to hold an SSE stream, and no reason to know Switch exists. Supporting them
one at a time means a bespoke connector per framework — the cost this ticket
exists to avoid.

**Non-goals:**

- Replacing the agent protocol. `AGENT_PROTOCOL.md` §3's outbound-only model
  remains how first-class agents connect. This is an additional door.
- Replacing MCP as the tool surface. AG-UI consumes the same operations
  registry (§6); it does not define new operations.
- Agent-initiated messages. Out of scope by requirement, and impossible in
  AG-UI regardless (§9.2).
- Rendering UI. AG-UI's original purpose is agent-to-frontend. We use its
  transport and tool semantics, not its UI story.

---

## 2. The inversion

AG-UI and the Switch agent protocol point in opposite directions.

| | Switch agent protocol | AG-UI |
|---|---|---|
| who dials | the agent | the client |
| who is the server | Switch | the agent |
| connection | long-lived, resumable | one run, then closed |
| initiative | either side | client only |
| state | Switch owns the room | stateless per run |

Read as "a replacement transport for the agent protocol", AG-UI fails on every
row. The design only works when you flip which side Switch plays:

> **Switch is the AG-UI client. The framework agent is the AG-UI server.**

Then the mismatches stop mattering. "The agent cannot be pushed to" is
irrelevant when Switch is the caller. "Stateless, resend history every run" is
irrelevant because Switch already owns the transcript. And the per-framework
adapter still exists — but it is written and maintained by the AG-UI project
and the frameworks themselves, not by us.

That is the whole value proposition: **one client in Switch, many frameworks,
zero Switch-specific code in the agent.**

---

## 3. Why AG-UI and not A2A

This was not obvious, and the answer depends on requirements that could change.
Recording it so the next person does not redo the work.

**A2A is the better-shaped protocol on paper**, and AG-UI's own documentation
says so — "A2A connects agents to other agents; AG-UI connects agents to
users." A2A reached **v1.0.0 in March 2026** (v1.0.1, May 2026), is hosted by
the Linux Foundation, and defines as normative operations four things AG-UI
lacks entirely: agent-initiated push via authenticated webhooks, discovery via
signed agent cards, a durable task lifecycle you can enumerate and re-attach
to, and first-class cancellation. Switch's own task protocol maps onto A2A's
task model closely, and onto AG-UI's run model not at all.

**Three requirements decided it for AG-UI anyway:**

1. **LangGraph must be supported.** A2A has no first-party LangGraph adapter.
   `ag-ui-langgraph` is the most actively maintained adapter in the AG-UI tree.
   This is AG-UI's one decisive, current advantage.
2. **Agents only answer when addressed.** AG-UI's inability to initiate is the
   defect that would otherwise disqualify it. Given this requirement it costs
   nothing.
3. **Client-executed tools are exactly our shape.** AG-UI natively models
   "these tools are executed by the client" — which is what Switch's room
   operations are. A2A has no equivalent concept.

Google ADK ships adapters for both, so it does not discriminate.

**Revisit this decision if** agents ever need to speak unprompted, if A2A
gains a first-party LangGraph adapter, or if AG-UI's governance does not
improve (§9.4). The connector is deliberately built behind our own interface
(§9.5) so the protocol underneath is replaceable.

---

## 4. Where it sits

AG-UI is a **server-side connector**
(`bridges/agent/server_connectors/agui/`), the same extension point as
OpenCode. That subsystem is the only existing place where Switch drives an
agent rather than serving one, and it already provides registration,
per-agent event delivery and a reporter for posting back into rooms.

It is **not** a "known agent" (`gateway/known_agents.py`). Those describe
operator-launched local CLI agents and carry start-session instructions for a
human to follow; a framework agent is server-hosted and started by nobody. This
distinction also means no desktop-console work: the console's `KnownAgentType`
union is closed over known agents only, while connector types are enumerated
from the registry and their config forms rendered from a JSON Schema.

One connector registration corresponds to **one AG-UI agent endpoint**.
AG-UI has no discovery mechanism — no well-known URL, no agent card, and
`HttpAgent` does not implement `getCapabilities()` — so `discover_agents`
cannot enumerate anything. It returns the single agent described by its
configuration. Registering several framework agents means several connector
registrations, which the gateway already supports.

---

## 5. A run

A room message addressed to the agent produces exactly one AG-UI run.

1. `handle_message` receives the addressed message.
2. Switch builds a `RunAgentInput`: the room transcript as `messages`, the
   room-scoped operations as `tools`, a `threadId` derived from the room and
   thread, and a fresh `runId`.
3. Switch POSTs it to the agent's endpoint with
   `Accept: text/event-stream` and consumes the SSE response.
4. Events are translated to reporter calls as they arrive (§7).
5. If the agent called any tools, Switch executes them and POSTs a
   continuation run carrying the results (§6.3).
6. The stream must terminate with `RUN_FINISHED` or `RUN_ERROR` (§9.1).

### 5.1 Runs are backgrounded

`ConnectorCore` awaits each handler inline in a single per-agent poll loop, and
an agent's heartbeat only fires when that loop re-enters `poll_events`. With
`CONNECTOR_POLL_TIMEOUT_SECONDS = 30` against `ALWAYS_ON_TTL = 90s`, **a
handler that blocks for ninety seconds makes the agent flap to `DISCONNECTED`
while it is actively working** — and LLM runs with tool-call loops routinely
exceed that.

So the AG-UI connector deliberately departs from the OpenCode reference:
`handle_message` starts the run as a background task and returns `None`
immediately. All output reaches the room through the reporter.

**Accepted cost:** backgrounding gives up the poll loop's implicit
serialisation, so the connector keeps its own lock per (agent, room). A second
message for a room whose run is in flight queues behind it rather than
interleaving. The queue is bounded; overflow is reported into the room rather
than dropped.

This is a workaround for a constraint in the connector core, not a property of
AG-UI. If that core later grows a heartbeat that survives a running handler,
this can be simplified.

### 5.2 Threads

A room thread maps deterministically to an AG-UI `threadId`; room-level
conversation gets a stable per-room id. This works inbound only.
`ConnectorReporter` has no thread parameter — `send_message(room_id, content)`
is the whole surface — so **everything an AG-UI agent says lands at the room
root**, even when replying to a threaded message. Fixing that means widening
the reporter interface, which is out of scope here and worth doing separately.

---

## 6. Tools: the operations registry as client-provided tools

AG-UI distinguishes tools the *agent* owns from tools the *client* executes and
passes in `RunAgentInput.tools`. The spec is explicit that the latter is for
client-executed tools only, "not intended to contain every tool available to
the backend agent". Switch's room operations are precisely client-executed
tools, so the mapping is legitimate rather than a stretch.

The projection is mechanical: `Operation` already carries `name`,
`description` and `input_schema`, and that schema is plain JSON Schema with no
`$ref`s, built transport-neutrally for exactly this reason. Each becomes
`{name, description, parameters: input_schema}`. The local runtime already does
the same thing in about nine lines when it re-serves `GET /ops` as MCP.

### 6.1 Only the room-scoped subset ships

MCP sends its tool list once per session. **AG-UI re-sends `tools[]` on every
POST**, including every continuation of a tool-call loop. That changes the
economics completely.

Measured on the current registry:

| surface | JSON bytes | approx. tokens |
|---|---|---|
| all 45 operations | 52,103 | ~13,000 |
| 22 room-scoped operations | 19,207 | ~4,800 |

`Operation.description` is the function's entire docstring, and they are long
by design — `create_room` alone is 4.4KB. At a 32-iteration tool loop the full
surface would cost roughly **416,000 tokens of tool definitions for a single
room turn**, before any conversation. Subsetting is therefore a correctness
requirement, not tidiness.

The subset is the operations that resolve their room from the session binding —
those calling `require_connected_room()`. They take no `room_id` argument, so
no argument rewriting is needed, and the group is self-sufficient: reading
context and participants, posting, the task protocol, documents and roles.

Excluded: connection lifecycle (`connect_to_room` claims a room slot on the
caller's connection and can evict a live session elsewhere — meaningless and
dangerous when Switch already knows the room), and instance-wide administration
(room and agent CRUD), which is a different blast radius from "take part in
this room".

**The registry does not mark this subset** — `Operation` has no category field
and `@operation` takes no arguments. The subset is therefore derived and
**pinned by a test**, so an operation added later cannot silently join or
escape the AG-UI surface.

### 6.2 Call context

Room-scoped operations resolve their room from `CallContext.session_key`, an
opaque string compared only for equality. A Switch-driven run has no
agent-held session, so Switch mints one and binds it with
`bind_room_for_connectionless_caller` — a plain function, deliberately not an
operation, that exists for callers in exactly this position. Dispatch then goes
through `call_operation`, the same entry point the HTTP door uses.

### 6.3 The continuation loop

A client-executed tool result returns to the agent as a `ToolMessage` in the
`messages` array of a **new** run. Switch therefore loops: consume stream,
execute any tool calls, POST again with the results, until a run completes with
no outstanding calls.

**The loop is ours to bound.** Neither the protocol nor the AG-UI client SDK
defines an iteration cap — `@ag-ui/mcp-middleware` has one (default 32) but it
governs its own MCP loop and explicitly hands off rather than managing client
tools. Switch caps iterations, and exhausting the cap is an error surfaced into
the room, never a silent truncation.

A tool that raises returns a `ToolMessage` with its `error` field set. Without
it a failed tool is indistinguishable from a successful one.

---

## 7. Events consumed

AG-UI defines **33 event types**. Switch consumes a subset and ignores the rest
forward-compatibly.

| event | effect |
|---|---|
| `RUN_STARTED` | begin; record the run |
| `TEXT_MESSAGE_START` / `_CONTENT` / `_END` | buffer, then one `send_message` |
| `TEXT_MESSAGE_CHUNK` | same, via the chunk shape (§7.1) |
| `TOOL_CALL_START` / `_ARGS` / `_END` | accumulate, then execute (§6.3) |
| `TOOL_CALL_CHUNK` | same, via the chunk shape |
| `TOOL_CALL_RESULT` | agent-side result; recorded, not executed |
| `STEP_STARTED` / `STEP_FINISHED` | `send_status` |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | `send_status` |
| `STATE_SNAPSHOT` / `STATE_DELTA` | per-thread state (§7.2) |
| `MESSAGES_SNAPSHOT` | authoritative history replacement |
| `RUN_FINISHED` | terminate; flush |
| `RUN_ERROR` | terminate; surface into the room |

Ignored: `RAW`, `CUSTOM`, `REASONING_*` (seven types — internal to the model,
not room content). The five deprecated `THINKING_*` events are accepted as
aliases of their `REASONING_*` equivalents. Unknown event types are ignored
rather than rejected, so a future AG-UI version does not break a running
Switch.

**Token streaming is buffered, not relayed.** Slack and Mattermost do not
render token-by-token updates, and a room is not a terminal. Each complete
message triad becomes one room message; `set_typing` covers liveness.

### 7.1 Chunk events are not optional

`TEXT_MESSAGE_CHUNK` and `TOOL_CALL_CHUNK` bypass the start/content/end triad
entirely, with all fields optional. A decoder that handles only the triad
**silently drops all content** from any producer that emits chunks. Both shapes
are handled and both are tested.

### 7.2 State

AG-UI is stateless per run; `state` plus `STATE_SNAPSHOT`/`STATE_DELTA` carry
whatever memory the agent keeps between runs. Switch stores it per (agent,
room, thread), in memory first, behind a narrow interface so it can move to
Postgres — the same treatment the event buffer gets and for the same reason.

`STATE_DELTA` is an RFC 6902 patch from an external agent applied to data
Switch holds. Patch paths are validated before application; a malformed or
out-of-bounds patch is an error, not a best-effort merge.

---

## 8. History

`messages` is built from room context. Two constraints:

- **The window is explicit and bounded.** A long-running room exceeds any
  model's context, and AG-UI re-uploads the full array every turn — the
  protocol does not say whether it may be partial, and the question is
  unanswered upstream. Switch sends a bounded window.
- **Truncation is disclosed.** When the window omits history, the agent is told
  so through `context` rather than being handed a silently shortened
  transcript. An agent that cannot see the start of a conversation should know
  that, exactly as `read_context`'s `truncated` tells a first-class agent.

---

## 9. What AG-UI gets wrong, and what we do about it

Recorded plainly. These are the reasons this connector is more than a thin
HTTP client, and the reasons to keep the protocol replaceable.

### 9.1 A truncated stream looks like a successful one

The most serious defect. An AG-UI stream that ends **without** `RUN_FINISHED`
or `RUN_ERROR` — dropped socket, load-balancer timeout, evicted pod — is
reported upstream as a *successful* run carrying the partial message. The
reference client's own reproduction commits the text `"Transferring $50,0"`.
Two terminators are caught; zero are not.

**Mitigation:** Switch treats absence of a terminator as a hard failure. The
partial message is not posted as though complete; the failure is surfaced into
the room. This is the single most important behaviour in the connector and it
is tested directly.

Relatedly, the protocol defines **no keepalive event**, so a model that is
merely thinking is indistinguishable from a dead socket. Switch applies a
read timeout and a whole-run timeout, both configurable, both loud.

### 9.2 `connectAgent()` succeeds having done nothing

`AbstractAgent.connect()` throws `AGUIConnectNotImplementedError`, nothing in
the AG-UI tree overrides it, and `connectAgent()` catches that specific error,
returns an empty observable and supplies a default value so the empty stream
does not raise. The caller receives a resolved promise and no events, forever.

This is the bidirectional/push path. **Switch does not use it** — agents answer
only when addressed — so the defect is on a code path we never take. It is
recorded because it is the reason "AG-UI will grow push later" should not be
assumed: `pushNotifications` and `resumable` exist only as booleans in a
capability schema with no sender, receiver or transport behind them, and the
drafts directory contains nothing about either.

### 9.3 No authentication, and no version on the wire

AG-UI defines no authentication, authorization or identity whatsoever. Nor is
there a protocol version on the wire — no field, no header, no negotiation.

**Mitigation:** Switch authenticates to the endpoint with a bearer token from
connector configuration, stored as an encrypted `ApiKey` row rather than in
plaintext `connection_config` (§10). The protocol version we speak is pinned in
our own types (§9.5), since the wire cannot tell us what the peer speaks.

### 9.4 Pre-1.0 under single-vendor governance

`@ag-ui/core` is **0.0.57** and `ag-ui-protocol` is **0.1.19** — fifteen months
after first release, with no 1.0 and no dated plan for one. `CODEOWNERS`
assigns the entire repository to a single vendor's team. There is no changelog
for the core packages; history is reconstructed from compatibility middleware.
Thoughtworks lists AG-UI at Trial while noting that "the need for a separate UI
protocol layer such as AG-UI is being questioned".

**Mitigation:** pin the version, keep it behind our interface, and treat §3's
"revisit if" list as live.

### 9.5 Hand-rolled types, not the SDK

**There is no Python AG-UI client.** `ag-ui-protocol` ships `core` and
`encoder` for building *servers*; no client package exists on PyPI under any
plausible name. Switch therefore implements the events it consumes as its own
types over `httpx` and an SSE decoder.

This is forced rather than chosen, but it is also what we would want: a small
surface, an explicit version pin, no pre-1.0 dependency in `core`, and a seam
at which the protocol underneath could be swapped.

### 9.6 Reachability inverts

`AGENT_PROTOCOL.md` §3 makes a deliberate promise: "Both are client-initiated,
so agents work behind NAT with only outbound HTTPS." An AG-UI agent is a server
Switch must reach, which reverses that.

**Accepted, with scope.** Framework agents are server-deployed by nature, so
this fits their deployment shape. It does mean an AG-UI agent on a developer
laptop needs a tunnel or must sit beside Switch, and that is a real regression
against a property the protocol document calls out on purpose. It is a
deployment constraint, documented, not a surprise.

---

## 10. Configuration and security

Connector configuration carries the endpoint URL, the bearer token, the agent's
name and description, and the timeout and iteration bounds.

### 10.1 The bearer token is not encrypted at rest

This section originally specified that the token would be held as a
Fernet-encrypted `ApiKey` row. **It is not, and the reason is worth recording
rather than quietly dropping.**

Registration happens in the shared connector lifecycle: it validates the config
against the connector's model and persists it verbatim into
`ServerConnector.connection_config`, which is plain JSONB. The connector is
constructed *afterwards*, from the already-stored config, so there is no point
at which an AG-UI-specific hook could encrypt the value on the way in. The
token therefore gets exactly the treatment the OpenCode connector's password
gets: stored in the clear, masked in the admin form via `format: "password"`,
and never returned by the gateway API.

Doing better means teaching `ServerSideConnectorLifecycleService` to encrypt
fields a config declares as secret — perhaps twenty lines, and a real
improvement. But it changes how **every** connector's stored config is read,
including rows written before the change, so it needs a compatibility path and
a decision that is not this ticket's to make. It is a follow-on, deliberately,
rather than a refactor smuggled in beside a new feature.

### 10.2 The endpoint URL is validated

Switch making outbound HTTP to an operator-supplied address is new attack
surface, so the URL's shape is checked at registration rather than discovered
on the first run: http or https only, a host present, and no embedded
credentials — those would otherwise surface in logs and error messages.

**Private and loopback addresses are deliberately allowed.** An agent running
beside Switch is the ordinary development case, and blocking it would make the
connector unusable locally while doing little for a determined operator. What
confines where Switch can reach is the network boundary around the deployment,
not this validator. That is a deployment expectation, and stating it is the
point of writing it down.

---

## 11. Delivery

Each phase is independently reviewable and lands with its tests.

0. **This document.**
1. **Types and SSE decoder** — pure, no I/O.
2. **Run client** — POST plus stream consumption, against a mock transport.
3. **Tool projection and continuation loop** — registry to `tools[]`, dispatch,
   results, bounds.
4. **The connector** — `ServerSideConnector`, backgrounded runs, reporter
   mapping, per-room locking.
5. **Configuration and registration.**
6. **Framework validation** — LangGraph and Google ADK.

### 11.1 Testing

`server_connectors/` gained its first tests with the OpenCode connector, which
establishes the harness: a duck-typed fake client, a recording reporter, and a
scripted event stream. The AG-UI tests follow it, plus a mock HTTP transport
for the client layer.

Specific behaviours that must be covered rather than assumed: the missing
terminator (§9.1); chunk-shaped events (§7.1); unknown events ignored while
malformed events are rejected; the tool subset pinned against the registry
(§6.1); a failing tool surfacing as `ToolMessage.error`; the iteration cap; and
a regression test that a long run does not block the poll loop (§5.1).

**Framework validation runs in CI, from committed fixtures.** Every fixture
under `tests/.../agui/fixtures/` was produced by real AG-UI software rather
than written by hand, which matters because Switch hand-rolls its types: a
hand-written fixture would only prove the decoder agrees with its own author.

- `langgraph_text_run.sse` — a **genuine capture** from a LangGraph graph
  driven through `ag-ui-langgraph`, using a deterministic fake chat model so it
  needs no API key. `capture_langgraph.py` regenerates it.
- `adk_text_run.sse` — a **genuine capture** from a Google ADK `LlmAgent`
  driven through `ag-ui-adk`, using a stub model subclassing ADK's own
  `BaseLlm` so it needs no Google credentials. `capture_adk.py` regenerates it.
- The remaining fixtures were encoded by the **reference Python SDK's own
  `EventEncoder`**. `generate_fixtures.py` regenerates them.

The two framework captures are what make the ticket's claim testable rather
than asserted: LangGraph and ADK share no code and neither knows Switch
exists, and one client turns both into the same room message. A test asserts
exactly that.

They also show how differently two conforming adapters behave. LangGraph emits
15 `RAW` passthrough events — more than any other type — and streams a short
sentence as seven `TEXT_MESSAGE_CONTENT` deltas. ADK emits six events total,
one delta, and carries its own bookkeeping in a `STATE_SNAPSHOT`. Both are
valid; a client that assumed either shape would break on the other.

Neither generator is a test dependency and neither runs in CI — the fixtures
are committed, so the conformance suite runs offline on every pull request.
Regenerating needs a throwaway virtualenv, which is the honest trade: CI gets
real-traffic coverage without the suite depending on a pre-1.0 package or a
live model.

The reference SDK's event enum is committed alongside as `event_types.txt` and
compared against ours, so an AG-UI release that adds or renames an event turns
into a failing test rather than a silent gap.

Live end-to-end runs against a framework are deliberately *not* wired into CI.
The existing `integration` marker means "boots Postgres and Tuwunel", so
reusing it would both misuse the marker and park this work where CI never
looks; and a live run needs the framework installed and, for most models, a
key. The captured fixtures are what makes the claim testable on every PR.

What is **not** covered: tool calling against a live framework. Both captures
exercise a text turn. The tool-call path is covered by reference-SDK fixtures
and unit tests, but no framework has yet been driven through a full
call-execute-continue cycle end to end.

---

## 12. Framework support

Switch does not support frameworks; it supports AG-UI. A framework works if its
AG-UI server adapter does, so the marginal cost of another framework is zero
and the only variable is adapter health.

- **Validated:** LangGraph (`ag-ui-langgraph`), Google ADK (`ag-ui-adk` — note
  it is community-maintained rather than by Google, and its PyPI releases lag
  its main branch).
- **Expected to work, untested:** Pydantic AI and Agno (AG-UI is built into
  both frameworks), LlamaIndex, CrewAI, AWS Strands, Mastra, Microsoft Agent
  Framework.
- **Not claimed:** AG2 (a single 0.0.1 release) and the Vercel AI SDK adapter
  (never published — its README's install command does not resolve).

Claiming only what has been run is deliberate. The repository already
advertises framework support that has no code path behind it; this list should
not add to that.

---

## 13. Related work

- **CHOO-490** — HTTP protocol parity. Delivered, and a precondition for this:
  the operations registry and its HTTP door are what AG-UI projects into (§6).
- **CHOO-1685** — this work. `AGENT_PROTOCOL.md` §1 lists AG-UI as a non-goal
  of that design and §14 notes it is worked separately; this document is where
  it is worked.
- **Stage C** (`AGENT_PROTOCOL.md` §8) — retiring `connection_model`. The AG-UI
  connector declares `always_on`, meaning *always reachable*, not *always
  speaking*. When Stage C lands, that becomes a connection with `scope: all`.
- **Reporter threading** — `ConnectorReporter` cannot post into a thread (§5.2).
  Worth its own ticket; it limits every server-side connector, not just this
  one.
