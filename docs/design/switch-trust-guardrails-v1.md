# Switch Trust guardrails integration, v1

Integrates Switch with **Switch Trust**, a guardrails service that evaluates a
message against a policy and returns a block/allow verdict. The service
exposes a `/guardrails/check` endpoint (see
[hoot#2397](https://github.com/sandbox-quantum/hoot/pull/2397) and its
[README](https://github.com/sandbox-quantum/hoot/blob/300cece9ec3625a5327a06aea66681c444c53139/services/aispm/guardrails/common/externalprocessor/README.md))
that takes a provider-agnostic `messages` array and returns an `outcome` plus
findings. This doc covers v1: a global, env-configured gate in front of every
message Switch sends, blocking on a `BLOCKED` outcome.

## Scope

- One guardrails policy for the whole deployment (no per-tenant override).
- Configured by environment variables only — no gateway or console UI.
- Checks the single outgoing message only — no conversation history sent.
- All five outcomes are acted on: `BLOCKED` stops the send, `REDACTED`
  replaces the content, `ALERTED`/`ERRORED` (and a Switch Trust outage) send
  with a short non-blocking annotation. See §Enforcement flow.
- Text content only — no media/attachments, no tool call/tool result mapping.

These are deliberate v1 cuts, not an assessment that they're unneeded — see
Follow-ups.

## Where it hooks in

Not the fully generic `Actor.send_message` (`core/switch_core/clients/actor.py:206`)
that was the original candidate: that method is also how Switch posts its own
canned, system-generated text under an agent's or a bridge's identity (a
join greeting, a command result, an auto-reply) — content nobody authored
freely and that gains nothing from a guardrails check. Hooking there would
have checked those too.

Instead, the check runs at the point each kind of *freely-authored* content is
actually about to be sent:

- **Agent-authored**, in `AgentCore` (`core/switch_core/bridges/agent/protocol/agent_core.py`):
  `send_message`, `update_status`, and `finalise_task` — the three places an
  agent's own text (a reply, a status line, a task outcome) reaches a room.
  All three call a shared `_enforce_trust(room, content, thread_root_id)`
  helper.
- **Human-authored**, in `CollaborationCore._handle_inbound_message`
  (`core/switch_core/bridges/collaboration/collaboration_core.py`): the point
  where an inbound platform message is about to become a
  `human_actor.send_message(...)` call.

Both sit directly in front of the actual send, so a blocked message never
becomes a row — but each as a deliberately-chosen call site with the right
context (room, thread, originating channel) rather than one generic
interception point further down the stack.

## Enforcement flow

1. Map the outgoing message to the hoot request shape:
   ```json
   {"messages": [{"role": "<mapped>", "content": "<body>"}]}
   ```
   Role mapping: `agent` → `assistant`, `human`/`bridge` → `user`.
2. `POST {switch_trust_endpoint}/guardrails/check` — the check-only endpoint
   added in [hoot#2397](https://github.com/sandbox-quantum/hoot/pull/2397) —
   with headers `x-guardrails-policy-id` and `x-flintai-api-key`, short
   timeout (2s default).
3. The outcome (mapped from the wire's `GUARDRAIL_RESULT_OUTCOME_*` values —
   `ok` / `blocked` / `redacted` / `alerted` / `errored`) decides what happens
   next — see §Outcome handling.
4. On block: the caller raises `GuardrailBlockedError` (carrying `outcome`,
   `findings`, `policy_id`) instead of sending. No row is created.
5. On network error, timeout, non-2xx, or a response `HttpTrustClient` doesn't
   recognise: **fail open** — `check_message` catches it, logs a warning, and
   reports it to the caller as `outcome="errored"` rather than `"ok"`, so it
   still gets the same quiet annotation an engine-side error would (see
   below). Blocking all of Switch's messaging on a guardrails-service outage
   is a worse failure mode than an unchecked message during an outage.

## Outcome handling

Each of the two call sites (§Where it hooks in) runs the check and then acts
on `TrustCheckResult.outcome`:

- **`blocked`** — raise `GuardrailBlockedError` instead of sending.
  - **Agent-authored**: catch it in the three `AgentCore` methods, and instead
    of the real content, post a notice into the room via `SystemActor.send_admin`
    with a new `AdminMessageType.TRUST_BLOCKED`
    (`core/switch_core/clients/admin_messages.py`). Every collaboration adapter
    (Slack, Mattermost, Discord, Teams, Telegram) already renders
    `admin_message()` as a platform-native system notice, distinct from an
    ordinary chat bubble — this is "visually stands out" for free. The
    agent's tool/API call gets back an error (HTTP 422 / an MCP tool error) so
    it knows its response was blocked.
  - **Human-authored**: catch it in `CollaborationCore._handle_inbound_message`
    and call the adapter's `admin_message(...)` back to the **originating
    platform channel** directly (`msg.channel_id`, `msg.root_id or
    msg.message_ref`). The row is never created, so the message never reaches
    the room or any agent — the notice goes straight back to the sender's
    platform, not into Switch.
- **`redacted`** — `HttpTrustClient.check` builds `redacted_content` itself:
  for each finding, it substring-replaces `detected_string` in the checked
  content with `[redacted]`, immediately, inside the client. `detected_string`
  is never stored on `TrustFinding` or exposed elsewhere — only the already-
  redacted result travels further, so the sensitive text itself can't
  accidentally end up in a log line or a notice the way it could if findings
  carried it around. The caller swaps in `redacted_content` before sending if
  it's set. (The endpoint's own response doesn't carry a pre-sanitized
  message — hoot's "SanitizedMessages" is dashboard-ingestion-only state, not
  part of the `/guardrails/check` JSON body — so this redaction is Switch's
  own, built from the findings' detected text.)
- **`alerted`** / **`errored`** (including a failed check, per above) — not
  blocking. The caller appends a short line to the message body itself via
  `trust_annotation()`, e.g. `⚠️ _Switch Trust: pii/email (not blocked)_` for
  an alert, or `⚠️ _Switch Trust could not fully check this message_` for an
  error — rather than a separate chat message or a platform reaction. See
  below for why.
- **`ok`** — unchanged.

### Why an inline annotation and not a reaction badge

The original sketch for a lightweight, non-disruptive indicator was to reuse
`mark_activity()` — the reaction-emoji badge (👀 working / ⏳ queued) every
adapter already implements for "agent is working" status. That turned out not
to fit: `mark_activity`'s `agent_name` parameter is required because some
platforms (Mattermost) give each agent's bot its own reaction, so the method
has no way to add a reaction that belongs to no agent. A Switch Trust
alert/error is a Switch-level concern, not any agent's — retrofitting it would
mean a genuinely new cross-adapter primitive (touching every adapter), not a
reuse of an existing one.

Appending to the message body instead needs no adapter changes at all: it
rides through the same `translate_outbound`/markdown pipeline every message
already goes through, works identically on every platform, and stays attached
to the message it's about, rather than becoming a second thing to read.

## Config

New fields on `SwitchConfig` (`core/switch_core/config.py`), mirroring the
existing all-or-nothing settings groups (`_validate_slack_app`,
`core/switch_core/config.py:986`):

```python
switch_trust_endpoint: str = "https://api.flintai.dev"
switch_trust_api_key: str = ""
switch_trust_policy_id: str = ""
switch_trust_timeout_seconds: float = 2.0
```

`switch_trust_endpoint` is a base URL; the client appends
`/guardrails/check` — the check-only route added in
[hoot#2397](https://github.com/sandbox-quantum/hoot/pull/2397) — rather than
treating the configured value as the full check URL. This default will change
once Switch Trust has its own deployment — see Follow-ups.

A `trust_enabled` property returns `bool(switch_trust_api_key and
switch_trust_policy_id)`. A `_validate_switch_trust` model validator checks
the endpoint's URL shape (scheme/host, no path/query — mirroring
`_validate_observability`'s OTLP check) when it's overridden from the default,
and that `switch_trust_api_key`/`switch_trust_policy_id` are both set or both
empty.

When `trust_enabled` is false, a `NullTrustClient` is injected — mirrors
`telemetry/sink.py`'s `NullSink`: off is a client that always allows, so no
call site has to branch on whether the feature is on.

## Execution plan

1. **Config** — add the four `switch_trust_*` fields, `trust_enabled`
   property, and `_validate_switch_trust` validator to `SwitchConfig`. Unit
   tests mirroring the existing Slack/Discord app validator tests.
2. **Trust client** — new `core/switch_core/trust/client.py`: a `TrustClient`
   protocol (`check(role, content) -> TrustCheckResult`), an `HttpTrustClient`
   (httpx, the request/response mapping from §Enforcement flow, fail-open on
   transport errors), and a `NullTrustClient`. Unit tests for request
   building, outcome parsing, and the fail-open path.
3. **Exception + admin message type** — add `GuardrailBlockedError` (new
   module or alongside `transport` exceptions) and
   `AdminMessageType.TRUST_BLOCKED` in `admin_messages.py`.
4. **Wire the client in** — inject `TrustClient` into `AgentCore` (new
   required constructor param) and `CollaborationCore` (defaulted to
   `NullTrustClient()` for the many tests that assemble one directly), built
   once in `main.py` (`trust/setup.py::build_trust_client`) and threaded
   through the same layers `telemetry` already is.
5. **Agent-origin handling** — a shared `AgentCore._enforce_trust` helper,
   called from `send_message`, `update_status`, and `finalise_task`: raises
   `GuardrailBlockedError` on a block (having posted the `TRUST_BLOCKED`
   admin message first), otherwise returns the content to actually send
   (redacted or annotated as needed).
6. **Human-origin handling** — the same outcome handling inline in
   `CollaborationCore._handle_inbound_message`, before the
   `human_actor.send_message(...)` call.
7. **Integration tests** (real Postgres, per repo convention) — a blocked
   human message never creates a `messages` row; a blocked agent message
   results in a `TRUST_BLOCKED` admin row instead of the real content; an
   allowed message is unaffected; a Switch Trust timeout/error still delivers
   the message (fail-open, annotated).
8. **`docs/old/`**: note the new config block in whichever doc lists
   deployment env vars (none currently fully enumerates `SwitchConfig`, so
   likely just a short mention near the other optional-integration blocks, if
   one exists).

## Resolved decisions

- Prod default for `switch_trust_endpoint`: `https://api.flintai.dev` (base
  URL; the client appends `/guardrails/check`). Expected to change once Switch
  Trust has its own deployment — tracked in Follow-ups.
- 2s timeout default, and `x-guardrails-policy-id` / `x-flintai-api-key`
  headers, confirmed as-is.
- The hook point moved from the originally-sketched `Actor.send_message` to
  three `AgentCore` methods plus `CollaborationCore`'s inbound handler, to
  avoid checking Switch's own canned/system text — see §Where it hooks in.
- `REDACTED` and `ALERTED`/`ERRORED` are handled (client-side redaction and an
  inline annotation, respectively) rather than deferred — see §Outcome
  handling. The originally-sketched reaction-badge indicator was dropped in
  favor of an inline annotation once `mark_activity`'s agent-scoping turned
  out not to fit a Switch-level concern.

## Follow-ups (explicitly out of v1 scope)

- **`switch_trust_endpoint` default will change**: `https://api.flintai.dev`
  is a placeholder base URL for now; Switch Trust is expected to get its own
  dedicated endpoint later, at which point the default should move.
- **Conversation history**: send the last N room messages as context so the
  policy can catch things that only make sense across turns (e.g. a PII leak
  split across messages). Needs a role-mapping strategy for Switch's
  multi-party rooms (which don't have a strict two-party turn structure) and a
  decision on including/excluding system/admin notices.
- **Tool calls / tool results**: the hoot endpoint supports `tool_calls` and
  `tool_result` message fields; Switch doesn't yet have an obvious mapping
  from its agent-protocol tool use onto that shape.
- **A real cross-platform status indicator**: the inline-annotation approach
  for `ALERTED`/`ERRORED` (§Outcome handling) is a pragmatic v1 choice. A
  dedicated, Switch-level (not per-agent) reaction or status primitive across
  adapters would be a nicer fast-follow, if the inline text proves too noisy
  in practice.
- **Per-tenant / per-workspace policy**: today it's one global policy for the
  whole deployment. Multiple tenants wanting different policies needs a DB
  table, migration, and an admin API — a materially bigger lift than the env
  var config in this doc.
- **Settings UI**: a dedicated Switch Trust section, either in the gateway
  operator dashboard or in Console's "server properties" — neither surface has
  an existing settings page to extend today, so this is new UI work in either
  home.
- **Media/attachment checks**: images and files aren't sent to Switch Trust in
  v1.
