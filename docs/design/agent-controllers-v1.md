# Agent management and agent controllers: v1 implementation spec

Status: in progress. This is the implementation spec for the first slice of the
agent-controller design. It covers the **Core management module behind a flag** and the
**headless agents controller**. The full target contract is
`controller-contract-v1.md` (to be added alongside); this file says what v1 builds, and
where it deliberately stops short.

## Shape

- **Management** (Core package `switch_core/management/`, off unless
  `AGENT_MANAGEMENT_ENABLED=true`): the source of truth for managed agents. It holds agent
  definitions, which controller each one runs on, controller enrollment and credentials,
  controller status, and operations.
- **Agents controller** (`console/packages/agent-controller`, a Node CLI): one per
  machine. It pulls its assignment, runs each assigned agent through the existing
  shared-host agent host (the same `--watch-*` runtime the Console sidecar uses), and reports
  status.
- Core's messaging path is unchanged. Each managed agent still holds its own per-agent
  agent host connection to the agent bridge.

## v1 scope and deliberate deviations from the target contract

| Target contract | v1 | Why |
|---|---|---|
| Controllers act as agents on `/agents/{id}/...` with a controller token | **Not in v1.** The controller fetches a per-agent API key from Management for each bound agent. Every fetch **rotates** the key, which invalidates any earlier holder | The agent host and session hosts read the agent token once, from the credentials file, and cannot refresh a short-lived token. Moving to scoped tokens needs a runtime change first |
| One SSE stream per controller carrying agent events | **The controller stream carries only nudges** (`assignment.changed`, `operation.pending`, `credential.revoked`). Agent events stay on per-agent agent host streams | Avoids touching message delivery. That is roadmap step 7 |
| Connector tokens, sealed provider logins | Not in v1 | Later steps |
| Enrollment by EC2 machine secret | Not in v1. Supported: Console sign-in (gateway) and one-time code (headless) | |
| Operations | `agent.restart` and `provider.recheck` only. Core rejects other kinds with `400 operation_unsupported` | |
| Per-tenant flag | Deployment-wide env flag | No per-tenant flag mechanism exists yet |

## Core

### Config (`config.py`)
- `agent_management_enabled: bool = False` (`AGENT_MANAGEMENT_ENABLED`).
- `controller_token_secret: str | None = None` (`CONTROLLER_TOKEN_SECRET`). **Required
  when the flag is on**: a model validator raises if it is missing or shorter than 32 chars. It is
  separate from `jwt_secret_key` on purpose.
- `controller_status_interval_seconds: int = 60`. Returned to controllers as `report_within_s`.
  Placement needs a status within 3 intervals. Whether a machine is online is read from its
  recorded connection instead (see "Liveness" below).

With the flag off, none of the routes below are mounted, and the middleware branch is
inactive.

### Tables (all `TenantScoped`, RLS like every scoped table, one migration)
- `agent_controllers`
  - `id`, `owner_id` (users), `name`, `description` null (the owner's note on what the
    machine is for), `kind` (`console|daemon|ec2`), `platform` JSONB null,
    `version` null, `public_key` null.
  - `api_key_id`: the credential, an `api_keys` row of type `controller`, holding the hash only.
  - `assignment_revision` int default 0, `status_seq` bigint null, `status` JSONB null.
  - `last_seen_at` null (the last status), `revoked_at` null, `created_at`, `updated_at`.
  - The connection, as the switch-core process holding its socket last recorded it (all null
    until the first): `connection_id`, `connection_process_id`, `connected_at`,
    `disconnected_at`, `disconnect_reason` (`socket_closed`, `server_shutdown`,
    `heartbeat_lapsed`, `taken_over`, `revoked`).
- `switch_core_processes` (global, no tenant): each switch-core process's lease, `id`,
  `started_at`, `beat_at`, `stopped_at` null.
- `agent_controller_enrollment_codes`: `id`, `owner_id`, `api_key_id` (an `api_keys` row of
  type `controller_enrollment`, so the existing global hash → tenant lookup works),
  `expires_at`, `used_at` null, `controller_id` null, `created_at`.
- `agent_definitions`: `id`, `agent_id` (FK agents, cascade, unique per tenant),
  `owner_id`, `controller_id` (FK agent_controllers, null = unplaced), `revision` int,
  `desired_state` (`running|stopped`), `definition` JSONB, `created_at`, `updated_at`.
- `agent_controller_operations`: `id`, `controller_id`, `agent_id` null, `kind`,
  `params` JSONB, `state` (`pending|claimed|succeeded|failed|cancelled|expired`),
  `lease_expires_at` null, `result` JSONB null, `created_by` (users), `created_at`, `updated_at`.

Controller and enrollment `api_keys` rows **must not** appear in the user's API-key list,
and must not be revealable. `encrypted_key` holds an empty string for these types, because
nothing may decrypt them.

### Credentials and tokens
- Controller credential: `swcc_` + `token_urlsafe(32)`. It is stored as a sha256 hash, as an
  `api_keys` row of type `controller`.
- Enrollment code: `swce_` + `token_urlsafe(18)`. Single use, valid for 10 minutes.
- Access token: `swct_` + an HS256 JWT signed with `controller_token_secret`.
  - `aud="switch-controller"`, claims `cid`, `tid` (tenant), `oid` (owner), `iat`, `exp`.
  - Valid for 1 hour.
- Every POST/PUT that creates something accepts `Idempotency-Key`. v1 may treat that as
  best effort, but naturally idempotent routes (claim, result) must be idempotent.

### Agent-bridge routes (bearer). Errors use `{"error": {"code", "message", "retryable"}}`
Public (they authenticate through the body):
- `POST /v1/management/controllers/enroll`
  - Body: `{proof:{kind:"enrollment_code", code}, controller:{kind, name, description?, platform, version}, public_key?}`.
  - `name` is trimmed and must not be blank (at most 200 characters); `description` is
    optional, at most 500 characters, and blank means none.
  - Returns `201 {controller_id, credential}`.
- `POST /v1/management/controllers/{id}/token`
  - Body: `{credential}`.
  - Returns `200 {access_token, expires_at}`, or `401 controller_revoked | invalid_credential`.

Controller access token (`{id}` must match the token's `cid`, otherwise `403 forbidden`):
- `POST /v1/management/controllers/{id}/credential/rotate` returns `{credential}`.
- `PATCH /v1/management/controllers/{id}`
  - Body: `{name?, description?}`, at least one: the controller renames its own machine
    (`switch-agent-controller set-info`). The same validation and effects as the owner's
    `PATCH /gateway/management/controllers/{id}`, including the rename reaching Core's
    bindings. Returns the controller as the owner's list shows it.
- `GET  /v1/management/controllers/{id}/assignment`
  - Honours `If-None-Match`; returns `200` with an `ETag` header, or `304`.
- `PUT  /v1/management/controllers/{id}/status`
  - Body: a `StatusReport`.
  - Returns `{assignment_revision, report_within_s}`.
  - An older `seq` is ignored, and the response is still 200.
- `GET  /v1/management/controllers/{id}/operations?state=pending`
  - Expired leases are re-offered.
- `POST /v1/management/operations/{op}/claim`
  - Returns the operation with `lease_expires_at` (5 min), or `409 already_claimed | 410 cancelled`.
- `POST /v1/management/operations/{op}/progress` renews the lease. Returns `204`.
- `POST /v1/management/operations/{op}/result`
  - Body: `{outcome:"succeeded", output?} | {outcome:"failed", error:{code,message}}`.
  - Returns `204`.
- `POST /v1/management/controllers/{id}/agents/{agent_id}/credentials` (v1 only)
  - Returns `{agent_id, api_key}`, or `403 not_assigned`.
  - Rotates the agent's API key (`AgentCore.rotate_agent_api_key`).
- `GET  /v1/controllers/{id}/events` (SSE)
  - The first frame is `connection_state {controller_id, assignment_revision, report_within_s}`.
  - Then `assignment.changed {revision}`, `operation.pending {operation_id, kind, agent_id}`,
    and `credential.revoked {}`.
  - A `: keepalive` comment is sent every 15s.
  - Notifications are process-local (an in-memory notifier, since Core is single process).
    A controller resyncs fully on every reconnect.

### Gateway routes (cookie, `get_current_user`, owner-only)
- `POST   /gateway/management/enrollment-codes` returns `{code, expires_at, server_url}`.
  `server_url` is the agent bridge's public origin (`GATEWAY_PUBLIC_URL`), the
  `--server` to enroll with, or null when it is not configured; the gateway
  page's own address is not a stand-in, since a gateway need not serve the
  agent bridge.
- `POST   /gateway/management/controllers`
  - Console enrollment by a signed-in user.
  - Body: `{name, description?, kind:"console", platform, version, public_key?}`.
  - Returns `{controller_id, credential}`.
- `GET    /gateway/management/controllers`
  - Returns the list, each with its `description`, derived `state`
    (`online|offline|unknown|revoked`, see "Liveness" below), `last_seen_at` (its last status),
    `connection` (`{connected_at, disconnected_at, disconnect_reason}` or null when it never
    connected; `disconnect_reason` is also `server_shutdown` or `server_lost` when the row
    shows it open but the process holding it stopped or died), its last `status`, and
    `workspaces_dir`: the directory the controller makes
    agents' workspaces in, from that status (`machine.workspaces_dir`), null when it has not
    reported one.
- `PATCH  /gateway/management/controllers/{id}`
  - Body: `{name?, description?}`, at least one. Renames the machine and/or changes its
    description; `description: null` (or blank) clears it. Same limits as at enrollment;
    `422 validation_error` otherwise. Someone else's controller is `404`.
  - A new name also reaches Core's bindings (`ControllerPresence.rename_controller`), since
    it is the name a room is told when the machine is offline.
- `DELETE /gateway/management/controllers/{id}`
  - Revokes it: deletes the credential, sends the `credential.revoked` nudge, and leaves definitions placed but shown.
- `GET    /gateway/management/agents` and `GET /gateway/management/agents/{agent_id}`.
  - Each agent's `status` is its entry in its controller's last status report, with
    `directory` always present: where the agent runs, null until the controller resolved it.
- `POST   /gateway/management/agents` creates and places a new agent.
  - Body: `{name, description, display_name?, controller_id, desired_state, definition}`.
  - It registers the agent through `AgentCore.register_agent`, using the known-agent spec for the provider
    (`claude→claude-code`, `codex`, `opencode`, `antigravity`, `cursor`), with `owner_only=True`. A managed agent always starts a session when addressed; there is no setting for it.
- `PUT    /gateway/management/agents/{agent_id}`
  - Adopts an agent the user already owns, or replaces its definition and placement.
- `PATCH  /gateway/management/agents/{agent_id}`
  - Changes `definition`, `desired_state` or `controller_id`.
  - Moving bumps both controllers' `assignment_revision`. The new controller's credential fetch rotates the key, which fences the old one out.
- `DELETE /gateway/management/agents/{agent_id}`
  - Stops managing the agent: removes the definition, and the controller stops it. It does not delete the agent.
- `POST   /gateway/management/operations` and `GET /gateway/management/operations?controller_id=`.
- `GET    /gateway/management/advanced-config` returns each provider's advanced-configuration
  schema, `{"providers": {"claude": {"fields": [...]}, "codex": ..., "opencode": ...,
  "cursor": {"fields": []}, "antigravity": {"fields": []}}}` (see Advanced configuration below),
  and `GET /gateway/management/providers` the providers in order, each with its label and the
  same fields. These two are served whether or not agent management is on: Switch Console
  builds the advanced-configuration form of the agents it runs itself from them too.

**Placement checks** run on create, adopt and move, and on a change to `running`. Each failure returns `409` with a reason:
- `controller_revoked`
- `controller_offline`: not online (never connected, its socket went, or the process
  holding it stopped), or no status, or the last status is stale
- `provider_not_installed`
- `provider_login_missing` or `provider_login_expired`

A provider whose `auth` is `unknown` passes.

**The working directory is always named.** On create, and on every change through PUT, PATCH
or `update_agent_detail`, a definition whose `directory` is null gets
`<workspaces_dir>/<agent name>`, the controller's own workspace for the agent (its
`DataLayout.workspace(name)`), when the target controller has reported `workspaces_dir`.
A move clears a directory equal to the old controller's workspace for the agent before filling
in the new one's. A controller that has not reported `workspaces_dir` leaves it null, and still
reports the directory it resolved in the agent's status. The controller makes a missing
directory inside its workspaces directory; any other directory must already exist.

Any change that affects a controller bumps its `assignment_revision` and nudges it.

### Definition (v1)
```json
{"provider": "claude|codex|opencode|antigravity|cursor",
 "model": null, "advanced_config": {}, "instructions": "", "auto_approve": false,
 "directory": null, "isolation": "shared"}
```

### Advanced configuration
`advanced_config` carries the provider's "Advanced configuration", the per-provider settings
Switch Console offers for its own agents. The server owns one fixed schema per provider
(`management/advanced_config.py`), checks every create and update against it whatever
machine runs the agent, and serves it at `GET /gateway/management/advanced-config` and
through the `get_advanced_config(provider)` agent operation. Switch Console and the
controller hold no copy of the fields; their provider plugins only apply values, by key.
Controllers report nothing about settings; they apply what they are given, and report
`definition_invalid` for a key their build does not apply or a value of a shape it cannot
apply, rather than starting the agent without it.

- Each served field is `{key, label, type, help, placeholder, options, catalogue}`. `type`
  is `text` or `textarea` (a string), `number` (finite), `boolean`, `list` (strings) or
  `select` (a string among `options`). `options` is `[{value, label}]` for a select, null
  otherwise; its first entry is `{"value": "", "label": <unset label>}` ("Default",
  "Inherit", ...), which a form shows for "unset" and which is not an accepted value.
  `catalogue` is null, `{kind: "model"}`, or `{kind: "model-variant", model_field}`.
- Claude: `tools`, `disallowedTools` (lists), `permissionMode`, `color`, `maxTurns`,
  `background`, `isolation` (Claude's git worktree, unrelated to the definition's own
  `isolation`), `effort`, `memory`. Codex: `effort`, `verbosity`, `reasoningSummary`,
  `webSearch` (`"true"`/`"false"`). OpenCode: `variant`, `temperature`, `topP`,
  `maxSteps`, `webSearch`, `smallModel`. Cursor and Antigravity: none. `model` and the
  instructions stay top-level definition fields.
- An unset field is left out, never null, `""` or `[]`. At most 32 keys, strings at most
  4096 characters, lists at most 64 items of 1 to 256 characters. An unknown key, a wrong
  type or a value outside a select's options is refused as `422 validation_error`, the
  message naming the provider and the field. A definition is replaced whole, so changing
  `provider` needs an `advanced_config` the new provider takes.

The assignment entry adds the agent's `name`, `display_name` and `icon_url`, read from the agents row.

### Reason codes
These are the codes from the contract, plus `forbidden`, `invalid_credential`, `enrollment_code_invalid`,
`operation_unsupported`, `not_found` and `validation_error`.

### Contract fixtures
`core/tests/switch_core/fixtures/agent_controllers/` holds one JSON file per wire message.
- Core tests check that real route responses match the fixture's shape, with volatile values normalised.
- The controller's TypeScript tests parse the same files with its schemas.

### Agents managing agents

An agent may act on its owner's agent management through four agent operations. They
exist only while management runs: they are declared in their own operation group
(`registry.gated_operation`), and `Management.install` enables it by handing Core
management's implementation of `AgentManagementPort`
(`bridges/agent/protocol/agent_management.py`, implemented by
`management/agent_operations.py`). With the flag off they are on neither door: not in
`GET /ops`, `404` on `POST /ops/{name}`, and not listed or callable over MCP (the MCP server
registers every declared operation and filters by the registry per request).

- `list_machines()`: the owner's controllers that are not revoked, each `{id, name,
  description, kind, state, last_seen_at, providers: [{provider, installed, version, auth}],
  agents_running}`. Revoked machines are left out rather than flagged; the managed-agent
  list still shows an agent placed on one, with the machine's `state: "revoked"`.
  `agents_running` counts the agents the last status reports as `running`, null before any
  status.
- `get_advanced_config(provider)`: the provider's advanced-configuration fields, as the
  gateway serves them.
- `create_agent(name, description, machine, provider, model=None, advanced_config=None,
  instructions="", directory=None, auto_approve=False, display_name=None, icon_url=None,
  start=True)`: builds the same
  `CreateManagedAgentRequest` the gateway route takes and calls
  `ManagementService.create_managed_agent`, so validation, placement checks, owner-only
  addressing and registration are the gateway's. `machine` is an id among the owner's
  controllers (any state; a revoked one is then refused as `controller_revoked`), or else an
  exact name among those not revoked; a shared name is refused with the candidates listed.
  The agent is owned by the calling agent's owner, with `auto_session` true and the
  capability off. Returns `{agent_id, name, machine: {id, name}, desired_state, hint}`.
- `list_managed_agents()`: the owner's managed agents, each `{agent_id, name, display_name,
  description, provider, model, advanced_config, machine: {id, name, state} | null,
  desired_state, actual:
  {process, reason, detail, applied_revision, since, directory} | null, revision}`, `actual`
  being the agent's entry in its controller's last status, plus top-level `directory`, the one
  the definition names.

**The capability.** `agents.can_manage_agents` (boolean, default false) gates all four,
listing included since it discloses the owner's machines. It is the agent's, read from its
row on every call, so it holds however the call authenticated: the agent's own key or a
controller acting as the agent. An agent with no owner is refused. Only the agent's owner
sets it, with `PUT /gateway/agents/{agent_id}/can-manage-agents {enabled}` (not an admin:
the agent would act on the owner's own machines); the agent detail carries it as
`can_manage_agents`. An agent created through `create_agent` (or the gateway) starts with
it off.

**Where owners set things.** The gateway's agent page has an "Agent management" section
with the capability switch (shown only where management runs), and the Machines page an
edit action for a machine's name and description. In Switch Console, an agent's settings
carry the same switch for Switch agents, and the "This computer as a machine" card shows
and edits this computer's name and description. Console's own enrollment sends no
description.

**Refusals.** Without the capability: `403`, "Agent X is not allowed to manage agents. Ask
your owner to enable 'can manage agents' for X ...". Everything management refuses is an
`AgentManagementRefused` (a `ValueError`, so `400` over HTTP) whose message starts "Nothing
was created:", says why in terms of the machine (placement codes are reworded: the machine
has not reported recently, the provider is not installed or not logged in there, ...) and
ends with the reason code in parentheses. Another person's machine, by id or name, gets
exactly the answer a missing one does.

## Headless agents controller (`console/packages/agent-controller`)

- CLI `switch-agent-controller`, released as its own npm package on
  `switch-agent-controller-v*` GitHub releases, with an `install.sh` (see RELEASING.md):
  - `enroll --server <agent-bridge-url> --code <code> [--name] [--description] [--data-dir] [--secret-store]`
  - `run [--data-dir] [--env-file]`
  - `set-info [--name] [--description] [--data-dir]`: renames the machine and/or changes its
    description on the server, with the controller's own credential, and records the new name
    locally.
  - `status [--data-dir]`
  - `install-service` / `uninstall-service`: a systemd user unit or a launchd agent
  - `doctor`: what the machine lacks to run agents
  - `update [--check]`: the newest release, from GitHub
- **Data dir:** `SWITCH_CONTROLLER_DATA_DIR`, otherwise the OS default.
  - macOS: `~/Library/Application Support/Switch/agent-controller`
  - Linux: `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller`
  - Mode 0700.
- **Store:** `node:sqlite`, one file. It holds identity, the assignment cache, per-agent applied revision and
  runtime state, and the status seq. It is a cache that can be rebuilt from the server.
- **Secrets:** behind a `SecretStore` interface: the macOS keychain (the default on a Mac), the
  desktop keyring through `secret-tool` (on request), or a file backend (0600, the default on
  Linux) that **logs a warning at startup**. The data directory records which one `enroll` used.
- **Run loop:**
  1. Exchange the token, refreshing it before expiry. On `controller_revoked`: stop all agents, wipe the credential, and exit non-zero.
  2. Open the nudge stream, reconnecting with jittered backoff capped at 8 s and
     reset whenever a stream attaches: every agent is offline while it is down.
  3. On connect and on `assignment.changed`: pull the assignment with ETag, then reconcile.
  4. On `operation.pending`: list, claim, execute and report.
  5. As a safety net, resync fully every 10 minutes.
- **Reconcile, per agent:**
  - Running, and not applied or at an older revision:
    1. Ensure the credentials: fetch from the credentials endpoint if there is no local file, or after an auth failure.
    2. Write them to `<data>/agents/<id>/credentials.json` (0600), outside the agent's working directory.
    3. Ensure the working directory: `definition.directory`, otherwise `~/.switch/agents/<server>/<name>`, where `<server>` is the server's address (`localhost-8000`, `switch.example.com`). A missing directory inside that folder is made; any other must exist.
    4. Write the agent host root `<data>/agent hosts/<id>/` with `watch.json {enabled:true, spawn:true}` and a `SharedHostConfig` template, as the Console builds.
    5. Start the agent host (`runAgentHost`) in the controller's process, after stopping the running one when the revision changed. Its sessions are the controller's child processes.
  - Stopped or removed: write `watch.json {enabled:false}`, stop the agent host and its sessions, and delete the credentials of removed agents.
  - Nothing an agent runs outlives the controller: stopping the controller stops every agent host and session, and the next run starts them again from their journals and confirmed cursors.
- **Status:** sent on every change, and every `report_within_s`.
  - Machine: os, arch, disk, memory, sessions, and `workspaces_dir` (`~/.switch/agents/<server>`, absolute).
  - Providers: installed via a PATH lookup, auth via the bundle's `--probe`, cached for 10 min. `provider.recheck` forces a probe.
  - Agents: read from each running agent host's state and `supervisor/failure.json`, mapped to the contract's process states and reason codes, with `directory`, the working directory its agent host was configured with.
- **Operations:** `agent.restart` restarts the agent host. `provider.recheck` forces a probe and reports.

---

## Step 10, option B: controller-backed agents on one stream per controller

Decided after v1. This **replaces** the v1 per-agent key workaround and the nudge-only
stream. The flag and everything else above stay as they are.

### Model
- **Controller-backed agent:** an agent whose `agent_definitions.controller_id` is set.
  Core treats it differently from a directly connected agent:
  - It has **no per-agent connection** in `AgentConnectionRegistry`, no placements and no room claims.
  - **Presence** comes from its controller. The agent is connected while its controller's stream is
    attached and its heartbeat is fresh, its owner has it running, and the controller is not
    revoked. That, and which rooms it is a member of, is all Core knows: where its sessions
    are, and whether one is running, is the controller's business.
- **Directly connected agent:** an agent with no controller. Nothing changes for it.
- **Its per-agent API key cannot open an event stream** while the agent is controller-backed
  (`409 managed_by_controller`). The key-fetch route
  (`POST /v1/management/controllers/{id}/agents/{agent_id}/credentials`) is removed, and so
  are the controller's credential files.

### The Core / Management boundary
- Core owns an in-memory `ControllerPresence`, in `bridges/agent/protocol/`. It records which
  controller each agent is bound to, and whether each controller's
  stream is attached and when it last beat.
- Management fills it at startup (all bindings) and on every binding change, through
  a narrow API. Core never imports Management and never reads its tables.
- Every presence reader in Core asks `ControllerPresence` for controller-backed agents and the
  `AgentConnectionRegistry` for the others:
  - statuses (LIVE / DISCONNECTED)
  - the agent client's reachability replies (never a "Starting a session…" promise: the
    agent's host posts that itself)
  - the bridges' `agent_online`
  - role leases (a lease held by a controller-backed agent lives while the agent is live)
  - probes and snapshots

### Acting as an agent
- A controller access token is accepted on **every agent route**:
  - `/agents/{agent_id}/...`, including `ops`, media, typing and history
  - `/agent-sessions/...`, where the agent comes from an `X-Switch-Agent-Id` header
- A central check in the middleware requires the agent to be **bound to that controller now**.
  Otherwise the request fails with `403 not_assigned`. It then sets `scope["agent"]`, so the handlers stay
  unchanged.
- **Room context for operations:** a controller sends `X-Switch-Room-Id`, meaning the room the
  calling session works in, which the controller tracks locally. Core checks that the agent is a
  member and uses it where a session selector would have resolved a room.
- `connect_to_room` for a controller-backed agent only checks membership and returns the room
  context. It claims nothing.

### The controller stream (`GET /v1/controllers/{id}/events`)
- **Open:** `POST /v1/controllers/{id}/connection` with `{cursors: {agent_id: seq | "head"}}`.
  It returns `{connection_id, generation, heartbeat_interval_s, agents}`.
- **Takeover:** reopening takes over, with `generation` fencing like today's agent connections.
- **Beat:** `POST /v1/controllers/{id}/connection/beat {connection_id, generation, cursors}`,
  every 2 s, with a 6 s TTL. A lapse makes all its agents not live.
- **Frames.** Every frame carries `agent_id`, plus the agent's own sequence where it has one:
  - `agent.event`: today's domain event payload and `sequence`, plus `missed` counts computed as
    today, with one counting reader per controller stream and agent.
  - `agent.gap`: today's gap fields.
  - `agent.session_command`: in-room commands such as `!reset` and `!compact`, with `room_id`.
    The controller routes it to the session working in that room.
  - `agent.approval_outcome`
  - `agent.attached {from_seq, rooms}`, `agent.detached {reason}` and `agent.rooms {rooms}`
    (membership changed).
  - Plus the management nudges: `assignment.changed`, `operation.pending`,
    `credential.revoked`.
- **Reading:** a read-side merge over the existing per-agent `EventBuffer`, from each agent's cursor,
  `filter=all` (the controller filters locally). There is no buffer per controller. Bindings
  changing mid-stream attach or detach agents live.

### Agent hosts in the controller's process, and the local relay
- Each agent's definition says where its agent host runs: `isolation: "shared"` (the default)
  in the controller's process, as below; `isolated` in a process of its own, which reaches
  the same hub over a WebSocket on the relay's port (`/hub`). Cloud machines run every agent
  isolated, as a systemd unit. Changing an agent's isolation restarts it the other way.
- One upstream stream. Each agent's agent host runs inside the controller's process and is handed
  its events from that stream directly (`AgentHub`): in order, filtered to what addresses the
  agent, with gaps, resets, room controls and approval outcomes. Events that arrive while its
  agent host is not running are held (bounded); its cursor moves only once the agent host has taken an
  event. The agent host states its sessions' rooms in memory, for the relay and for routing
  session commands; none of it is sent upstream.
- The shared agent host code (`runAgentHost`) takes the function that opens its event stream: the
  controller passes its hub, an isolated agent host the hub over its WebSocket
  (`openHubStream`, chosen by `SWITCH_AGENT_HUB` in its credentials), while Console passes the
  agent host's own connection to Switch. Only the controller holds the agent protocol's
  connection to Switch; nothing on the machine imitates it.
- A loopback HTTP relay (`127.0.0.1`, a per-agent bearer token minted locally) is what each
  agent host uses as `SWITCH_API_ENDPOINT` for its calls to Switch. It forwards everything with the
  controller access token, the `X-Switch-Agent-Id` header, and `X-Switch-Room-Id` resolved from
  the placements. It serves no event stream and no connection bookkeeping of its own. The
  credentials file names the relay, its hub and its local token, never a Switch credential.

### Core implementation notes (decisions the spec left open)

- **No placements.** Core does not know where a controller-backed agent's
  sessions are. The open and the beat carry no session map; a body that still
  sends `placements` is refused with `422 validation_error`, an exception to
  ignoring unknown controller fields so a controller still reporting sessions
  is noticed. Per-agent room membership (`agent.attached {rooms}`,
  `agent.rooms`) is kept: that is membership, not sessions.
- **Presence states.** A controller-backed agent is `LIVE` while it is
  connected (its controller's stream attached and beating, set to running, the
  controller not revoked), whatever its `connection_model`, and `DISCONNECTED`
  otherwise; a `session_passive` agent is `AWAITING_MANUAL_POLL` as any other.
  There is no `DORMANT` or `NO_SESSION` for it. An agent whose owner set it to
  `stopped` is not connected however healthy its controller is.
  While connected it is present (`agents_present_in`, `rooms_occupied`, so the
  runtime-state sweep keeps its state) in every room it is a member of, and in
  none otherwise. A role holder is `present_here` in a room it is connected to
  and a member of; Core never names another room as its `session_room`. The
  agent detail shows one room-agnostic session while it is connected.
- **Room replies.** An addressed agent that is connected is available: the
  message is delivered and Core posts nothing, neither "Starting a session…"
  nor "I don't have a session in this room"; the agent's host posts any
  "Starting a session…" notice itself. Not connected, the reply says why: its
  owner stopped it and has to set it running, or its machine (the
  controller's name, carried on the binding) is offline or reconnecting, or
  has been removed once it is revoked. A controller-backed agent is never
  offered the terminal command or told to open Switch Console.
  In-room session commands (`!reset`, `!compact`) are still relayed on the
  controller's stream with the room, and the controller picks the session.
- **Liveness** is "socket attached and a pong within 6 s"; the connection sweep
  closes lapsed controller connections. Heartbeats stay in the memory of the
  process holding the socket.
- **Recorded transitions.** `ControllerPresence` stays the in-memory fast path for
  routing and agent presence, and tells a ledger (`ControllerConnectionLedger`, Core's
  port, implemented by `management/connection_ledger.py`) of each transition, once:
  the socket attaching to a connection that had none, and the socket going, with why
  (`socket_closed`, `server_shutdown`, `heartbeat_lapsed`, `taken_over`, `revoked`).
  The ledger writes them to the controller's row from one background task, never
  per beat. A connecting replaces the row; a closing is written only while the row
  still names that connection, so a process closing a connection the controller has
  since replaced through another process leaves the replacement standing.
- **Process lease.** Each switch-core process renews a lease in
  `switch_core_processes` every 5 s (`management/process_lease.py`), one write per
  process however many machines it holds, and marks it stopped as it shuts down.
  A machine is online while its socket is recorded attached and its holding
  process's lease was renewed within 15 s and is not stopped; so a process that
  dies without writing its closings takes its machines offline within 15 s.
  Leases are written and compared on the database's clock.
- **Holder id.** A controller-backed agent holds things under
  `controller:{controller_id}:{agent_id}`: the operation caller's session key
  and session id, the reader of its unread counts, and the holder of a role
  lease (live while the agent is). Moving the agent changes it, so a lease does
  not survive a move.
- **Act-as routes.** Every `/agents/{agent_id}/...` and `/agent-sessions/...`
  route; on `/agents/rooms/...`, `/agents/feature-flags` and `/agent-sessions/...`
  the agent comes from `X-Switch-Agent-Id` alone. Refused for a controller
  token: registration (`403 forbidden`), any non-agent route (`403
  forbidden`), and the per-agent connection surface the controller holds for the agent — `events`,
  `notifications`, `rooms/{id}/events`, `connection/*`, `watch/heartbeat` —
  with `409 managed_by_controller`. `X-Switch-Connection-Id` and the session
  selector headers are ignored for a controller principal.
- **Own key.** A controller-backed agent's own API key (or OIDC token) is
  refused on every route with `409 managed_by_controller`, in the contract
  envelope. Binding an agent closes any connection it still held.
- **Open/beat bodies.** `POST /connection` returns `agents: string[]` (the
  agent ids bound now); the beat returns `{agents}`. `client` and
  `client_version` are optional on open; `placements` is refused on both. A
  beat with no stream attached is
  `409 no_stream`. Each open is a new server-generated connection id and
  generation and takes over the previous one. A second `GET /events` on the
  same connection takes the stream over and resumes every agent from its
  latest beat-confirmed cursor (or where the earlier stream attached it).
- **Frames** wrap today's per-agent payloads unchanged: `agent.event
  {agent_id, seq, event}`, `agent.session_command {agent_id, room_id,
  command}` (`command.sessionId` is null: the controller picks the session
  from the room), `agent.approval_outcome {agent_id, outcome}`, and the stream
  ends with `evicted {code, reason}` (`taken_over`, `heartbeat_lapsed`,
  `closed`) or after `credential.revoked`. `connection_state` adds
  `connection_id`, `generation` and `heartbeat_interval_s`.
- **Revocation** leaves the agents bound to the revoked controller (still
  controller-backed, not live) until they are moved or removed.
- **Controller-token cache.** The controller row a controller token re-reads
  and the agent row it acts as are memoised (`ControllerAuthCache`, separate
  from the agent API-key cache) for `AGENT_AUTH_CACHE_TTL_SECONDS` (0
  disables it). `ControllerPresence` drops a controller's entry when it is
  revoked and an agent's when it is bound, moved, unbound or deleted; the
  binding check itself is never cached.
