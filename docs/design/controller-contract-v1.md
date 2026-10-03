# Agents controller contract, v1 (draft)

The full contract between an **agents controller** and the Switch server (**Management** plus **Core**).
Step 1 of the roadmap turns this into OpenAPI and JSON Schema files plus recorded fixtures. The types below are the source for those files.

---

## 0. Conventions

- **Transport:** HTTPS with JSON bodies (`application/json`), and one SSE stream (`text/event-stream`).
- **Base paths:** Management is `/v1/management/...`. The Core controller surface is `/v1/controllers/...`. Agent actions use the existing `/agents/{agent_id}/...` routes.
- **Version:** every request sends `Switch-Controller-Protocol: 1`.
  - The server answers with the range it supports in `Switch-Controller-Protocol-Accepts: 1-1`.
  - An unsupported version returns `426` with code `protocol_unsupported`.
- **Forward compatibility:** receivers ignore unknown fields. An unknown enum value is read as `unknown`, never as an error.
- **Time:** RFC 3339 UTC strings. **IDs:** opaque strings.
- **Idempotency:** every mutating `POST` accepts `Idempotency-Key`. A repeat returns the first result.
- **Errors:** always this shape, with a code from §9:
  ```ts
  type Error = { error: { code: ReasonCode; message: string; retryable: boolean; retry_after_s?: number } }
  ```
- **Auth:** `Authorization: Bearer <access_token>` on everything except enrollment and token exchange (§1).

---

## 1. Enrollment and authentication (Management)

```
POST /v1/management/enrollment-codes                 auth: user session (Console)
  → 201 { code: string, expires_at: Time }           // single use, 10 min

POST /v1/management/controllers/enroll               auth: one of the proofs below
  { proof: { kind: "user_session" }                  // Console, user signed in (bearer = user session)
         | { kind: "enrollment_code", code: string } // personal VM / own machine
         | { kind: "machine_secret", machine_id: string, capability: string }
                                                     // Switch EC2: the machine capability from its boot secret,
                                                     // with X-Switch-Host-Boot-Id and X-Switch-Host-Instance-Id
    controller: { kind: "console" | "daemon" | "ec2", name: string, platform: Platform, version: string },
    public_key: { alg: "X25519", key: base64 } }     // used to seal provider logins to this controller
  → 201 { controller_id: string, credential: string } // credential returned once, stored in the local secret store

POST /v1/management/controllers/{id}/token           auth: none (credential in body)
  { credential: string }
  → 200 { access_token: string, expires_at: Time }    // about 1h. Claims: controller_id, owner_id, tenant_id

POST /v1/management/controllers/{id}/credential/rotate   → 200 { credential: string }
DELETE /v1/management/controllers/{id}                    auth: owner (user). Revokes it, and every agent on it stops
```

```ts
type Platform = { os: "macos" | "linux" | "windows"; arch: "arm64" | "x64"; os_version: string }
```

**Machine secret (as implemented).** The machine's supervisor enrolls, not
the controller, and hands the controller its identity on the command line and
the credential on stdin. The capability is checked as on the machine routes:
`401 invalid_credential` for a wrong one, `400 validation_error` without the
host headers, `410 machine_retired` once the machine is retained or being
deleted. The controller is of kind `ec2` and bound to the machine: one per
machine. Enrolling again keeps it and rotates its credential (the old one is
refused with `invalid_credential`); a machine whose controller was revoked
gets a new one. An enrollment code cannot enroll an `ec2` controller.

The token is short-lived and the credential is long-lived but revocable. An expired token returns `401 token_expired`, and the controller then exchanges its credential again. A revoked credential returns `401 controller_revoked`, and the controller stops all agents and exits.

---

## 2. Assignment (Management)

What this controller should run. It's pulled on start, on reconnect, and on every `assignment.changed`.

```
GET /v1/management/controllers/{id}/assignment
  If-None-Match: "<revision>"
  → 200 Assignment | 304
```

```ts
type Assignment = {
  revision: number                    // bumps on any change to this controller's set
  agents: AgentAssignment[]
}

type AgentAssignment = {
  agent_id: string
  revision: number                    // bumps on any change to this agent. Used for fencing
  desired_state: "running" | "stopped"
  definition: AgentDefinition
}

type AgentDefinition = {
  name: string                        // Switch identifier, as addressed in rooms
  display_name: string | null
  icon_url: string | null
  provider: "claude" | "codex" | "opencode" | "cursor" | "antigravity"
  model: string | null                // null = provider default
  instructions: string                // ≤ 32 KiB
  provider_definition: string | null  // e.g. the Claude agent definition file
  auto_session: boolean               // start a session when addressed with none running
  auto_approve: boolean               // CLI runs with its bypass-permissions flag
  session_limit: number
  repo: { kind: "github"; installation_id: number; repository_id: number } | null
  skills: Skill[]
  local: { directory: string | null } // placement hint for console/daemon. Ignored on ec2
}

type Skill = { name: string; content: string }   // installed into the provider's skills dir
```

**Cloud agents (as implemented).** v1 sends the v1 definition
(`agent-controllers-v1.md`) and, for a cloud agent, adds an optional
`hosted` block rather than the fields above. Management writes it from the
agent's cloud launch; a person's client cannot submit one.

```ts
type HostedDefinition = {
  machine_id: string
  launch_id: string
  launch_revision: number             // the cloud launch's revision; a new one rebuilds the block
  provider_credential_kind: "api-key" | "setup-token" | "auth-json" | null
  repository: string | null           // "owner/name"
  spec: { name?: string; definition?: string; instructions: string;
          definition_attributes: Record<string, unknown>; auto_session: boolean; auto_approve: boolean }
  skills: { slug: string; files: Record<string, string> }[]
  worker_capability: string | null    // added as the assignment is read, never stored; null while the
                                      // launch is moving to a new revision (the controller then waits)
}
```

Only a cloud machine's controller (`ec2`) runs a definition with a `hosted`
block, and it runs nothing else.

---

## 3. Status (Management)

A full snapshot every time, not a delta. It's sent on every change, and at least every `report_within_s`.

```
PUT /v1/management/controllers/{id}/status
  StatusReport                                     // ≤ 64 KiB
  → 200 { assignment_revision: number, report_within_s: number }  // tells the controller if it's behind
```

```ts
type StatusReport = {
  seq: number                          // monotonic per controller. The server drops anything older
  observed_at: Time
  controller: { version: string; protocol: 1; assignment_revision: number }
  machine: {
    platform: Platform
    disk_free_bytes: number; disk_total_bytes: number
    mem_free_bytes: number;  mem_total_bytes: number
    sessions_running: number; sessions_max: number
  }
  providers: ProviderStatus[]
  tools: ToolStatus[]
  agents: AgentStatus[]
}

type ProviderStatus = {
  provider: AgentDefinition["provider"]
  installed: boolean
  version: string | null
  auth: "ok" | "expired" | "missing" | "unknown"
  auth_source: "local" | "sealed" | null   // own login on the machine, or one delivered sealed
  checked_at: Time
  reason?: ReasonCode
}

type ToolStatus = { tool: string; state: "ok" | "missing" | "unauthenticated" | "unknown"; reason?: ReasonCode }
                                            // e.g. "gh", "git", "mcp:jira"

type AgentStatus = {
  agent_id: string
  applied_revision: number | null          // null = never applied
  process: "pending" | "starting" | "running" | "stopping" | "stopped" | "crashed" | "failed"
  attached: boolean                        // receiving its events on this controller's stream
  sessions: { active: number; ids: string[] }
  restarts_10m: number
  oom_kills: number
  since: Time                              // when it entered the current process state
  reason?: ReasonCode                      // required when process is crashed or failed
  detail?: string                          // human-readable. Never contains secrets
}
```

---

## 4. Operations (Management)

Explicit actions that aren't part of the desired state. Created by the Manager UI, the personal agent, or Management itself.

```
GET  /v1/management/controllers/{id}/operations?state=pending   → 200 { operations: Operation[] }
POST /v1/management/operations/{op_id}/claim                    → 200 Operation (with lease) | 409 already_claimed | 410 cancelled
POST /v1/management/operations/{op_id}/progress  { message: string }          → 204   // optional, renews the lease
POST /v1/management/operations/{op_id}/result    OperationResult              → 204
```

```ts
type Operation = {
  id: string
  kind: OperationKind
  agent_id: string | null              // null for machine-level kinds
  params: OperationParams              // shape depends on kind, see below
  created_at: Time
  lease_expires_at?: Time              // set on claim. An expired lease is re-offered
}

type OperationKind =
  | "agent.start" | "agent.stop" | "agent.restart"          // params: {}
  | "provider.recheck"                                      // params: { provider }
  | "provider.login"                                        // params: { provider, method: "device_code" | "sealed" }
  | "machine.collect_diagnostics"                           // params: {}

type OperationResult =
  | { outcome: "succeeded"; output?: Record<string, unknown> }  // e.g. provider.login → { verification_uri, user_code }
  | { outcome: "failed"; error: { code: ReasonCode; message: string } }
```

Claim leases last 5 minutes and are renewed by `progress`. Every operation reaches a terminal result or expires. Nothing is left pending forever.

---

## 5. Tokens and secrets (Management)

```
POST /v1/management/controllers/{id}/connector-token
  { agent_id: string, service: "github" | "jira" | "confluence" | "gdrive" | string, scope?: string[] }
  → 200 { token: string, expires_at: Time }          // ≤ 1h. Every issuance is audited
  → 403 not_assigned | 404 connector_not_connected

GET /v1/management/controllers/{id}/provider-credentials/{provider}
  → 200 { revision: string, sealed: { alg: "X25519-XChaCha20Poly1305", key_id: string, ciphertext: base64 } }
  → 404 provider_login_missing
```

- The Console seals a provider login to the controller's `public_key`, and the server stores only the ciphertext.
- On Switch EC2, the blob is sealed with a KMS key that only that VM's role can decrypt.
- The controller **prefers a local login** (`auth_source: "local"`) and fetches a sealed one only when none exists.
- When a CLI refreshes and rotates a login on the machine, the controller doesn't upload it back.

---

## 6. Event stream (Core)

One stream per controller. It carries events for every agent assigned to it.

```
POST /v1/controllers/{id}/connection
  { client: string, client_version: string,
    cursors: Record<agent_id, number | "head"> }     // where to resume each agent. Missing = "head"
  → 201 { connection_id: string, generation: number, heartbeat_interval_s: number,
          attached: string[] }                        // agents Core attached to this connection

GET /v1/controllers/{id}/events?connection_id=…&generation=…
  Accept: text/event-stream
  → SSE stream (frames below). The server sends ": ping" every 15s

POST /v1/controllers/{id}/connection/beat
  { connection_id: string, generation: number, cursors: Record<agent_id, number> }
  → 200 { attached: string[] }
  → 409 { code: "taken_over" | "stale_generation" }   // taken_over is terminal for this client
  → 404 { code: "unknown_connection" }                // reopen
```

**Attachment is automatic.** Core attaches the agents currently bound to this controller (§7), and attaches or detaches them as bindings change. There's no per-agent subscribe call.

**SSE frames.** `event:` is the type and `data:` is JSON.

```ts
type StreamEvent =
  | { type: "agent.event";        agent_id: string; seq: number; event: AgentProtocolEvent }
                                  // payload unchanged from today's per-agent stream (message, room_join, command, …)
  | { type: "agent.gap";          agent_id: string; rooms: string[]; reason: "overflow" | "restart" | "unknown" }
                                  // events were lost. The controller tells the agent to read context
  | { type: "agent.attached";     agent_id: string; from_seq: number }
  | { type: "agent.detached";     agent_id: string; reason: "unassigned" | "superseded" | "deleted" }
  | { type: "assignment.changed"; revision: number }
  | { type: "operation.pending";  operation_id: string; kind: OperationKind; agent_id: string | null }
  | { type: "credential.revoked" }
```

Cursors are **per agent**, because each agent keeps its own sequence in Core's buffer. That's why resume uses the `cursors` map and not `Last-Event-ID`.

**Cloud agent workers (as implemented).** A cloud agent's watcher attaches as
its worker through the controller's relay, and Core admits it on the
controller's connection:

```
POST /v1/controllers/{id}/agents/{agent_id}/worker
  { connection_id, generation,                       // the controller's open connection
    worker: { connection_id, generation,             // the relay's local connection and incarnation
              spawn_capable, protocol, protocol_accepts,
              capability, boot_id, instance_id, state_version } }
  → 200 { attached: WorkerAttached }                 // the worker_attached payload, written first on its stream
  → 403/409/426 { detail: { code, message } }        // the worker's own admission refused, as on its own stream
  → 403 not_assigned | 409 no_stream | 404 unknown_connection   // the controller's: retry

POST /v1/controllers/{id}/agents/{agent_id}/worker/detach
  { connection_id, generation, worker: { connection_id, generation } }
  → 204                                              // a stale detach changes nothing
```

Two frames carry what the worker is owed:

```ts
  | { type: "agent.worker";        agent_id; connection_id; generation; event: WorkerFrameName; data: object }
                                   // relay, relay_cancel, wake, mailbox_cancel, operation, credential
  | { type: "agent.worker_closed"; agent_id; connection_id; generation; code: "launch_superseded"; reason }
```

The worker's up-calls carry the relay's connection id and incarnation, and
are refused (`409 generation_changed`) unless they name the attached worker.
A worker is let go of when the controller connection closes, is taken over or
loses its stream, when the agent is moved or unbound, or on detach.

---

## 7. Acting as an agent (Core)

- **Binding.** Management tells Core which controller may act for an agent, through Core's narrow internal interface: `bind(agent_id, controller_id, revision)` and `unbind(agent_id, revision)`. Core stores the binding and never reads Management's tables.
- **Existing routes, new principal.** Every existing `/agents/{agent_id}/...` route accepts a controller access token: message, media, typing, history, participants, tasks, moderation, mediation, `events/report`, `runtime-state`, `connection/subscribe`, `connection/placements`.
  - Core checks `binding(agent_id).controller_id == token.controller_id`.
  - If that fails, it returns `403 not_assigned`.
  - Per-agent API keys keep working for agents with no binding: third-party agents and plugins.
- **Not used by controllers:** the per-agent `GET /agents/{agent_id}/events` stream. §6 replaces it.
- **Cloud agents (as implemented):** a cloud agent's worker up-calls under
  `/agents/{agent_id}/connection/` (`relay/...`, `idle`, `mailbox/ack`,
  `cutover-manifest`) are accepted from its controller, though the rest of the
  connection surface is not; so are `/hosted/provider-credential`,
  `/hosted/provider-status`, `/hosted/github-credential` and
  `/hosted/operations/{id}/claim|result`, with the agent in
  `X-Switch-Agent-Id`. An operation claimed this way is held under
  `controller:{controller_id}:{agent_id}`.
- **CLIs never call these routes directly.** The controller serves the Switch tools to its CLIs and makes the calls itself.

**Sessions are not managed through this contract.** A session and its transcript live with the host that runs it, and Core keeps no server-side session state. In-room session commands (`!reset`, `!compact`, `!interrupt`) keep reaching the session through the agent's own watcher stream, as `session_command` frames. How the Console reaches a session on a machine it cannot connect to directly (a cloud VM) is an open question, outside this contract.

---

## 8. Semantics

**Reconcile.** On every pull, for each agent:
- Not running and `desired_state = running`: start it.
- Running but absent or `stopped`: stop it.
- Running at an older `revision`: restart it with the new definition. Model and instructions apply on restart.

After acting, send status.

**Fencing and handover.**
- An agent is bound to exactly one controller.
- To move it, Management first unbinds it from A at revision r+1, and waits for A to report it stopped, or for A to go stale.
- Then it binds the agent to B at revision r+2. B refuses to start a revision older than one it has already applied.

**Staleness.** No status for 3 × `report_within_s` makes a controller `unknown`, and so are its agents. Management then:
- shows them as unknown,
- refuses new placements on that controller,
- may reassign its agents only if their definition allows it. Cloud agents stay put.

**Placement checks.** Before binding, Management checks the target's last status. It refuses with a reason if:
- the controller is `unknown`,
- the provider is not installed, or its login is not `ok`,
- there's no session capacity, or the disk is nearly full.

The personal agent relays that reason to the user as is.

**Offline.** The controller keeps running its cached assignment. On reconnect it opens a new connection with its cursors, pulls the assignment, reconciles, and sends status. Core returns `agent.gap` where history was lost.

**Ordering.**
- `agent.event` frames are ordered per agent, not across agents.
- `assignment.changed` may arrive before Core has attached a newly bound agent. The controller starts the agent anyway and waits for `agent.attached`.

**Limits (initial):**
- Status ≤ 64 KiB. Definition ≤ 32 KiB. 200 agents per controller.
- At most 1 status report per second, with bursts coalesced.

**Compatibility.**
- Adding fields or enum values is a minor change and needs no version bump.
- Removing or renaming anything, or changing a meaning, bumps the protocol version. The server supports N and N-1.

---

## 9. Reason codes

| Code | Where | Meaning |
|---|---|---|
| `protocol_unsupported` | any | Controller protocol is outside the server's range |
| `token_expired` / `controller_revoked` | auth | Re-exchange the credential / stop and exit |
| `not_assigned` | Core, Management | This controller isn't bound to that agent |
| `taken_over` / `stale_generation` / `unknown_connection` | stream | Another connection took over / outdated / reopen |
| `already_claimed` / `cancelled` / `lease_expired` | operations | Operation is no longer this controller's |
| `provider_not_installed` / `provider_version_unsupported` | status, placement | CLI missing, or too old |
| `provider_login_missing` / `provider_login_expired` | status, placement | No usable login |
| `connector_not_connected` / `connector_revoked` | tokens | User hasn't connected the service, or revoked it |
| `definition_invalid` | status | The definition can't be applied, and `detail` says why |
| `repo_clone_failed` | status | Clone or worktree failed |
| `crash_loop` | status | 5 restarts in 10 minutes, stopped retrying |
| `out_of_memory` | status | Killed by the memory limit |
| `disk_full` / `capacity_exceeded` | status, placement | No disk / no session slots |
| `controller_offline` | placement | Target is `unknown` |
| `internal` | any | Server or controller bug, with `retryable` set honestly |

---

## 10. Mapping to today

| Contract | Exists today | Change |
|---|---|---|
| §1 enrollment, EC2 | #556 machine secret and capability | Done: `machine_secret` proof, one `ec2` controller per machine |
| §2 assignment | #556 `GET /hosted/machines/{id}/agents` | Done for cloud agents: the `hosted` block; the machine list stops carrying a placed agent's key |
| §3 status | #556 `/heartbeat`, `process_state`, OOM and restart counts, `/provider-status` | Merge into one snapshot |
| §4 operations | #556 `HostedOperation`, `/operations/{id}/claim` and `/result` | Generalise the kinds |
| §5 tokens | #556 `/github-credential` | Generalise to connectors. Sealed provider logins are new |
| §6 stream | Per-agent `GET /agents/{id}/events` with connection, generation, beat and takeover | One stream per controller, as a read-side merge of the per-agent buffers |
| §7 act as | Per-agent API keys on `/agents/{id}/...` | Add the controller principal and the binding check |
