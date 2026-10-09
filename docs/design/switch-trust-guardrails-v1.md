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
   with headers `x-guardrails-policy-id`, `x-flintai-api-key`, and three
   always-set identity headers Switch Trust uses to group checks:
   - `x-agent-name`: a constant, `Switch Rooms` — Switch has no single agent
     to attribute a check to (a room can hold several, and a human-authored
     message has none at all), so every check is reported under one identity
     rather than inventing a per-sender one Switch Trust has no use for.
   - `x-agent-session-id`: the Switch room id — a room is the closest thing
     Switch has to an agentic session.
   - `x-agent-turn-id`: a fresh UUID per check. Switch has no stable
     "invocation" or "turn" id to hand it at either call site (the closest
     existing concept, session-activity's host-supplied `turn_id`, belongs to
     a different subsystem, is opaque to Switch, and doesn't exist for
     human-authored messages at all), so this is generated per call instead
     of reused.

   Short timeout (2s default).
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
    ordinary chat bubble — this is "visually stands out" for free. The notice
    names the agent (`@<agent-name> was blocked...`) so a room with several
    agents can tell whose response was withheld. The agent's tool/API call
    gets back an error (HTTP 422 / an MCP tool error) so it knows its response
    was blocked.
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
  own, built from the findings' detected text.) **Human-authored**: the
  redacted content is what reaches the room, but the sender would otherwise
  never know their own words were altered — `CollaborationCore` also calls
  the adapter's `admin_message(...)` back to the originating channel (a new
  `AdminMessageType.TRUST_REDACTED`) naming the finding categories redacted.
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

v1 shipped as four env-var fields on `SwitchConfig`
(`switch_trust_endpoint`/`switch_trust_api_key`/`switch_trust_policy_id`/
`switch_trust_timeout_seconds`, with a `trust_enabled` property and a
`_validate_switch_trust` validator), with `NullTrustClient` injected whenever
`trust_enabled` was false — mirroring `telemetry/sink.py`'s `NullSink`, so no
call site had to branch on whether the feature was on. These env vars were a
bootstrap stopgap, never a real deployment's config, and are gone: see
§Settings UI below for what replaced them.

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

## Resolved decisions

- Prod default for `switch_trust_endpoint`: `https://api.switchagents.ai`
  (base URL; the client appends `/guardrails/check`).
- 2s timeout default, and `x-guardrails-policy-id` / `x-flintai-api-key`
  headers, confirmed as-is.
- `x-agent-name` / `x-agent-session-id` / `x-agent-turn-id` are always set,
  never omitted: a deployment-side bug report showed a check going out with no
  agent attribution at all. `x-agent-name` is a fixed constant rather than
  per-caller, since nothing in Switch maps cleanly to the "one agent" these
  headers assume — see the header list above. `TrustClient.check` takes
  `room_id` as a required parameter (no default) precisely so a call site
  cannot forget it; the other two headers need no caller input at all.
- The hook point moved from the originally-sketched `Actor.send_message` to
  three `AgentCore` methods plus `CollaborationCore`'s inbound handler, to
  avoid checking Switch's own canned/system text — see §Where it hooks in.
- `REDACTED` and `ALERTED`/`ERRORED` are handled (client-side redaction and an
  inline annotation, respectively) rather than deferred — see §Outcome
  handling. The originally-sketched reaction-badge indicator was dropped in
  favor of an inline annotation once `mark_activity`'s agent-scoping turned
  out not to fit a Switch-level concern.

## Follow-ups (explicitly out of v1 scope)

- **Conversation history**: send the last N room messages as context so the
  policy can catch things that only make sense across turns (e.g. a PII leak
  split across messages). Needs a role-mapping strategy for Switch's
  multi-party rooms (which don't have a strict two-party turn structure) and a
  decision on including/excluding system/admin notices.
- **Tool calls / tool results**: the hoot endpoint supports `tool_calls` and
  `tool_result` message fields; Switch doesn't yet have an obvious mapping
  from its agent-protocol tool use onto that shape.
- **Per-tenant / per-workspace policy**: today it's one global policy for the
  whole deployment. Multiple tenants wanting different policies needs a DB
  table, migration, and an admin API — a materially bigger lift than the env
  var config in this doc.
- **Media/attachment checks**: images and files aren't sent to Switch Trust in
  v1.

## Settings UI

The env-var config above was always a bootstrap stopgap, not the intended
long-term home: it requires a deploy to change, and it isn't visible from
anywhere a deployment operator actually looks. This section replaces it with
a DB-backed, editable settings surface — still one global policy for the whole
deployment (no per-tenant override; that's still the bigger lift described
above).

**Storage**: a new `trust_settings` table — a single row (`endpoint`,
`policy_id`, `api_key_encrypted`, `updated_at`), upserted in place rather than
modeled as a list. `api_key_encrypted` is encrypted via `config.keyring`, the
same mechanism `ProviderConnection` already uses for per-user provider
credentials. The table starts empty — there is no migration step to carry
over the old `SWITCH_TRUST_*` env vars, since those never had a real
deployment depending on them. The `switch_trust_endpoint`,
`switch_trust_api_key`, `switch_trust_policy_id` fields, `trust_enabled`
property, and `_validate_switch_trust` validator are removed from
`SwitchConfig` entirely; endpoint URL-shape validation moves to the new
settings' write path.

The check timeout is the one exception: `switch_trust_timeout_seconds` stays
a `SwitchConfig` field (default 2s, validated positive), fixed at deploy time
rather than joining the DB-backed settings. Getting the endpoint, policy or
key wrong locks guardrails out entirely, which an operator needs to fix
without a restart — but the timeout is a tuning knob with a safe default, not
something to expose to day-to-day editing or surface in the settings UI.

**Resolution**: `TrustClient` gains a `DynamicTrustClient` implementation that
reads the current row on every `check()` call (via the new
`TrustSettingsStore`) instead of a client built once at boot from static
config, using `SwitchConfig.switch_trust_timeout_seconds` for the timeout on
every call. No row, or an incomplete one (missing `api_key`/`policy_id`),
behaves exactly like today's `NullTrustClient` — `outcome="ok"`, no request
made — except decided per call rather than at startup, so a settings change
takes effect on the next message with no restart. `trust/setup.py::build_trust_client`
now always returns a `DynamicTrustClient` wired to the store; `NullTrustClient`
remains for tests that want no DB involved at all.

**Gateway API**: a new router, `core/switch_core/gateway/trust_settings.py`,
deployment-scoped (no `{tenant_id}` in the path) and gated by `require_admin`
— the existing deployment-operator check (`users.role == "admin"`), distinct
from `require_tenant_admin` — since this setting applies to the whole
deployment, not one tenant.

- `GET /trust-settings` — `endpoint`, `policy_id`, `has_api_key`,
  `api_key_last4`, and a derived `enabled`. The real API key is never
  returned.
- `PUT /trust-settings` — full update of the non-secret fields; `api_key`
  omitted or `null` leaves the stored key untouched, so changing the endpoint
  or policy id doesn't force re-entering the secret.
- `DELETE /trust-settings` — clears the row, equivalent to turning guardrails
  off.

**Console UI**: a new section on the server's Home page, between "Messaging
apps" and "Full admin interface" — not a separate view, since there's little
enough here to configure that a full page would be a detour rather than a
destination. Gated on the connected server's reported `user.role === "admin"`
directly — not the broader `administersWorkspaceInScope()` helper, which also
admits a plain workspace owner and would be too wide for a deployment-level
setting — and hidden entirely for anyone else, since there's nothing read-only
to show a non-operator. Labeled "Switch Trust Endpoint", "Guardrails Policy
ID" and "Switch Trust API key" rather than the gateway's own field names, to
read as Switch Trust's settings rather than generic form fields; the timeout
is not surfaced at all. The key field shows "configured, ending •••1234"
instead of ever prefilling the real value, matching the write-only API above.
