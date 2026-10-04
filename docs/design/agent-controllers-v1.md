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
| Enrollment by EC2 machine secret | Added after v1: see "Cloud machines" at the end. Also supported: Console sign-in (gateway) and one-time code (headless) | |
| Operations | `agent.restart` and `provider.recheck` only. Core rejects other kinds with `400 operation_unsupported` | |
| Per-tenant flag | Deployment-wide env flag | No per-tenant flag mechanism exists yet |

## Core

### Config (`config.py`)
- `agent_management_enabled: bool = False` (`AGENT_MANAGEMENT_ENABLED`).
- `controller_token_secret: str | None = None` (`CONTROLLER_TOKEN_SECRET`). **Required
  when the flag is on**: a model validator raises if it is missing or shorter than 32 chars. It is
  separate from `jwt_secret_key` on purpose.
- `controller_status_interval_seconds: int = 60`. Returned to controllers as `report_within_s`.
  A controller is `unknown` after 3 intervals without a status.

With the flag off, none of the routes below are mounted, and the middleware branch is
inactive.

### Tables (all `TenantScoped`, RLS like every scoped table, one migration)
- `agent_controllers`
  - `id`, `owner_id` (users), `name`, `kind` (`console|daemon|ec2`), `platform` JSONB null,
    `version` null, `public_key` null.
  - `api_key_id`: the credential, an `api_keys` row of type `controller`, holding the hash only.
  - `assignment_revision` int default 0, `status_seq` bigint null, `status` JSONB null.
  - `last_seen_at` null, `revoked_at` null, `created_at`, `updated_at`.
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
  - Body: `{proof:{kind:"enrollment_code", code}, controller:{kind, name, platform, version}, public_key?}`.
  - Returns `201 {controller_id, credential}`.
- `POST /v1/management/controllers/{id}/token`
  - Body: `{credential}`.
  - Returns `200 {access_token, expires_at}`, or `401 controller_revoked | invalid_credential`.

Controller access token (`{id}` must match the token's `cid`, otherwise `403 forbidden`):
- `POST /v1/management/controllers/{id}/credential/rotate` returns `{credential}`.
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
  - Body: `{name, kind:"console", platform, version, public_key?}`.
  - Returns `{controller_id, credential}`.
- `GET    /gateway/management/controllers`
  - Returns the list, each with derived `state` (`online|unknown|revoked`), `last_seen_at` and its last `status`.
- `DELETE /gateway/management/controllers/{id}`
  - Revokes it: deletes the credential, sends the `credential.revoked` nudge, and leaves definitions placed but shown.
- `GET    /gateway/management/agents` and `GET /gateway/management/agents/{agent_id}`.
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

**Placement checks** run on create, adopt and move, and on a change to `running`. Each failure returns `409` with a reason:
- `controller_revoked`
- `controller_offline`: no status, or the last status is stale
- `provider_not_installed`
- `provider_login_missing` or `provider_login_expired`

A provider whose `auth` is `unknown` passes.

Any change that affects a controller bumps its `assignment_revision` and nudges it.

### Definition (v1)
```json
{"provider": "claude|codex|opencode|antigravity|cursor",
 "model": null, "instructions": "", "auto_approve": false,
 "directory": null}
```

The assignment entry adds the agent's `name`, `display_name` and `icon_url`, read from the agents row.

### Reason codes
These are the codes from the contract, plus `forbidden`, `invalid_credential`, `enrollment_code_invalid`,
`operation_unsupported`, `not_found` and `validation_error`.

### Contract fixtures
`core/tests/switch_core/fixtures/agent_controllers/` holds one JSON file per wire message.
- Core tests check that real route responses match the fixture's shape, with volatile values normalised.
- The controller's TypeScript tests parse the same files with its schemas.

## Headless agents controller (`console/packages/agent-controller`)

- CLI `switch-agent-controller`:
  - `enroll --server <agent-bridge-url> --code <code> [--name] [--data-dir]`
  - `run [--data-dir]`
  - `status [--data-dir]`
- **Data dir:** `SWITCH_CONTROLLER_DATA_DIR`, otherwise the OS default.
  - macOS: `~/Library/Application Support/Switch/agent-controller`
  - Linux: `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller`
  - Mode 0700.
- **Store:** `node:sqlite`, one file. It holds identity, the assignment cache, per-agent applied revision and
  runtime state, and the status seq. It is a cache that can be rebuilt from the server.
- **Secrets:** behind a `SecretStore` interface. v1 ships a file backend (0600) that **logs a
  warning at startup**, saying no OS keychain backend is in use.
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
    3. Ensure the working directory: `definition.directory`, otherwise `<data>/workspaces/<name>`.
    4. Write the agent host root `<data>/agent hosts/<id>/` with `watch.json {enabled:true, spawn:true}` and a `SharedHostConfig` template, as the Console builds.
    5. Start the agent host (`runAgentHost`) in the controller's process, after stopping the running one when the revision changed. Its sessions are the controller's child processes.
  - Stopped or removed: write `watch.json {enabled:false}`, stop the agent host and its sessions, and delete the credentials of removed agents.
  - Nothing an agent runs outlives the controller: stopping the controller stops every agent host and session, and the next run starts them again from their journals and confirmed cursors.
- **Status:** sent on every change, and every `report_within_s`.
  - Machine: os, arch, disk, memory, sessions.
  - Providers: installed via a PATH lookup, auth via the bundle's `--probe`, cached for 10 min. `provider.recheck` forces a probe.
  - Agents: read from each running agent host's state and `supervisor/failure.json`, mapped to the contract's process states and reason codes.
- **Operations:** `agent.restart` restarts the agent host. `provider.recheck` forces a probe and reports.

---

## Step 10, option B: controller-backed agents on one stream per controller

Decided after v1. This **replaces** the v1 per-agent key workaround and the nudge-only
stream. The flag and everything else above stay as they are.

### Model
- **Controller-backed agent:** an agent whose `agent_definitions.controller_id` is set.
  Core treats it differently from a directly connected agent:
  - It has **no per-agent connection** in `AgentConnectionRegistry`, no placements and no room claims.
  - **Presence** comes from its controller. The agent is live while its controller's stream is
    attached and its heartbeat is fresh. It can start sessions on demand when
    it is a member of the room.
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
  - statuses (LIVE / DORMANT / NO_SESSION)
  - the agent client's reachability replies and its "Starting a session…" promise
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
  in the controller's process, as below; `isolated` in a process of its own, served the
  per-agent agent protocol by the relay (its own event stream, heartbeat, placements and room
  claims), as before agent hosts moved in-process. Cloud machines run every agent isolated, as
  a systemd unit. Changing an agent's isolation restarts it the other way.
- One upstream stream. Each agent's agent host runs inside the controller's process and is handed
  its events from that stream directly (`AgentHub`): in order, filtered to what addresses the
  agent, with gaps, resets, room controls and approval outcomes. Events that arrive while its
  agent host is not running are held (bounded); its cursor moves only once the agent host has taken an
  event. The agent host states its sessions' rooms in memory; the controller beats them upstream.
- The shared agent host code (`runAgentHost`) takes the function that opens its event stream: the
  controller passes its hub, while Console and the shared daemon pass the agent host's own
  connection to Switch.
- A loopback HTTP relay (`127.0.0.1`, a per-agent bearer token minted locally) is what each
  agent host uses as `SWITCH_API_ENDPOINT` for its calls to Switch. It forwards everything with the
  controller access token, the `X-Switch-Agent-Id` header, and `X-Switch-Room-Id` resolved from
  the placements. It serves no event stream and no connection bookkeeping. The credentials file
  names the relay and its local token, never a Switch credential.

### Core implementation notes (decisions the spec left open)

- **Placements.** The beat body carries `placements: {agent_id: [room_id, ...]}`:
  for each bound agent, the rooms where one of its sessions works now (the
  controller knows them from its agent hosts' placements). It is the full map each
  beat and replaces the last; an agent left out is in no room; agents not
  bound to the controller and rooms the agent is not a member of are ignored
  (logged at debug). The open request may carry an initial map. Placements
  are dropped when the controller's stream detaches, its beat lapses, it is
  taken over or revoked, and an agent's when it is unbound or moved.
- **Presence states.** A session-shaped controller-backed agent is `LIVE` in a
  room it is placed in. Elsewhere it is `DORMANT` where its live controller
  will start a session (a member of the room), `NO_SESSION`
  where the controller is live and will not, and `DISCONNECTED` when the
  controller is not live (`NO_SESSION` for `session_addressable`, as for any
  agent). An `always_on` agent is `LIVE` exactly while its controller is.
  An agent whose owner set it to `stopped` is not live however healthy its
  controller is: it is never promised a session, it holds no placements, and
  the agent client tells the room it is stopped and that its owner has to set
  it running.
  Placed rooms also answer `agents_present_in`, `rooms_occupied` (so the
  runtime-state sweep keeps a working session's state and resets the rest),
  a role holder's `present_here`/`session_room`, and the agent detail's
  session rows. An addressed agent placed in the room is available, so no
  "Starting a session…" or offline reply is posted; unplaced, the reply names
  the rooms it is placed in elsewhere. With its controller not live the reply
  names the machine (the controller's name, carried on the binding) as
  offline or reconnecting, or as removed once it is revoked; a controller-
  backed agent is never offered the terminal command or told to open Switch
  Console.
- **Liveness** is "stream attached and beat within 6 s"; the connection sweep
  closes lapsed controller connections.
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
  agent ids bound now); the beat returns `{agents}`. `client`,
  `client_version` and `placements` are optional on open; `placements` is
  required on the beat. A beat with no stream attached is
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

---

## Cloud machines: EC2 on the agents controller

Decided after step 10. A Switch cloud machine (one EC2 VM per user,
`deploy/hosted/`) runs its agents through an agents controller, and its cloud
agents become managed agents placed on it. The deploy controller, the EC2
lifecycle and the cloud agent routes Switch Console calls are unchanged.

### What stays where

- **The machine's root supervisor** keeps the machine's work: storage, the
  ownership marker and quarantine, the agents' memory slice, retirement on
  410, and the machine heartbeat (disk, memory, runtime fingerprint, each
  unit's process state), from which Core derives the machine's and each
  launch's state and decides idle stops.
- **The machine's agents controller** decides what runs: it pulls the
  assignment, holds the one stream for all the machine's agents, serves each
  agent's watcher through its loopback relay, and reports status.
- **The cloud launch** stays the record of the agent's machine, limits,
  billing and lifecycle.

### Enrollment (`machine_secret`)

- `POST /v1/management/controllers/enroll` with
  `{proof: {kind: "machine_secret", machine_id, capability}}` and the host
  headers. The capability is checked against the machine as on its own routes
  (`authenticate_machine`), in the cloud machines' tenant.
- One controller per machine: `agent_controllers.hosted_machine_id`, unique
  among controllers that are not revoked, kind `ec2` only. Enrolling again
  keeps the row and rotates its credential, so a reboot leaves the agents
  placed where they were (no revision churn, no rows piling up). A revoked
  machine controller is replaced by a new row, since a revoked controller id
  can never open a stream again.
- The supervisor keeps the credential on the runtime tmpfs and hands it to
  the controller unit on stdin from a root-only tmpfs file that systemd opens
  before the controller starts and the supervisor deletes right after.

### Placement (`management/hosted_sync.py`)

- Every launch with an agent has a definition: the v1 fields from the launch
  spec, and a `hosted` block (`HostedDefinition`, documented in the contract)
  the supervisor builds the deployment from. The worker capability is added
  by the assignment as it is read; no secret is stored in the definition.
- The block is rebuilt only when the launch revision moves. This keeps the
  supervisor's old semantics: an edited instruction applies at the next
  start, and a change to one agent never restarts another.
- It is placed on the machine's live controller, or left unplaced while the
  machine has none, in which case the agent is not controller-backed and an
  old image keeps running it from its agent list.
- Core never imports Management: it calls a `HostedPlacement` that
  Management registers (`machine_changed` after every launch change,
  `machine_seen` on every machine heartbeat, which syncs only an agents
  version not synced yet, so a failed sync is caught up within a heartbeat).
- A placed launch that is queued moves to provisioning, as the supervisor's
  first read of its list used to do, so the attach timeout applies.
- Owners cannot change a cloud agent through the management routes
  (`409 cloud_agent`), and an `ec2` controller takes no local agent.

### Units (`SystemdRuntime`)

- The controller's systemd runtime asks the supervisor, over a unix socket,
  to install, stop, remove and report on each `switch-agent@<id>` unit, and to
  prune agents its assignment no longer names. The request is the agent
  list's old entry shape, with the controller relay's credentials; the
  supervisor validates it, derives every path, and accepts only a loopback
  relay endpoint and a relay token as the agent's Switch credentials.
- Install replaces the runtime files and restarts the unit when they differ
  (a new revision, a relay that came back on another port), and otherwise
  only corrects the unit's state; `restart` forces a restart
  (`agent.restart`). The supervisor does not verify a request against Core:
  the socket is root:switch-agent 0660 with the peer uid checked, and code
  that runs as the agent account could already run anything a unit runs.

### Workers on the controller stream

- The relay has Core admit a worker on the controller connection
  (`ControllerWorker`, in `ControllerPresence`), with the admission a worker
  opening its own stream gets. A `ControllerWorker` has the attributes the
  hosted code reads of an `AgentConnection` bound to a worker (a
  `WorkerHandle`), so relays, the wake mailbox, idle evidence, operations and
  the cutover manifest run unchanged for both.
- Its id and generation are the relay's local connection id and incarnation:
  what the worker names on its up-calls, so the relay forwards them
  untouched. Its holder is `controller:{controller_id}:{agent_id}`.
- Frames are queued on it and written on the controller stream as
  `agent.worker`; a superseded launch revision ends it with
  `agent.worker_closed`. It lasts as long as the controller connection's
  stream, and the relay ends every worker stream when the controller stream
  drops, so the workers attach again on the next one.
- The worker's up-calls are accepted from the controller acting as the agent
  (the bearer middleware lets the worker connection routes and the cloud
  agent `/hosted/...` routes through), and `require_worker` fences them on the
  controller worker.

