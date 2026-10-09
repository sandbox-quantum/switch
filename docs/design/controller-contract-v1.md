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
         | { kind: "machine_secret", assertion: string }  // Switch EC2, from the boot secret
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
  advanced_config: Record<string, string | number | boolean | string[]> // the provider's "Advanced configuration", checked by the server against its schema for the provider (GET /gateway/management/advanced-config); an unset field is left out; {} for none
  instructions: string                // ≤ 32 KiB
  provider_definition: string | null  // e.g. the Claude agent definition file
  auto_approve: boolean               // CLI runs with its bypass-permissions flag
  isolation: "shared" | "isolated"    // agent host in the controller, or a process of its own
  session_limit: number
  repo: { kind: "github"; installation_id: number; repository_id: number } | null
  skills: Skill[]
  local: { directory: string | null } // placement hint for console/daemon. Ignored on ec2
}

type Skill = { name: string; content: string }   // installed into the provider's skills dir
```

`repo` and `skills` are not sent in v1. An agent's service grants and their skills are read by its agent host from `GET /agents/{agent_id}/service-grants` (§5) when a session starts, so a grant change bumps no revision.

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
    workspaces_dir?: string            // absolute; where agents' workspaces are made when the definition names no directory. Absent from older controllers
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

type ToolStatus = { tool: string; state: "ok" | "missing" | "unauthenticated" | "unsupported" | "unknown"; reason?: ReasonCode }
                                            // e.g. "gh", "git", "mcp:jira". unsupported: this machine cannot run
                                            // Switch's helper for the tool (GitHub's on Windows)

type AgentStatus = {
  agent_id: string
  applied_revision: number | null          // null = never applied
  process: "pending" | "starting" | "running" | "stopping" | "stopped" | "crashed" | "failed"
  attached: boolean                        // receiving its events on this controller's stream
  sessions: { active: number; ids: string[] }
  restarts_10m: number
  oom_kills: number
  directory?: string | null                // absolute working directory it runs in; null before one was resolved. Absent from older controllers
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

## 5. Tokens and secrets

### Service tokens (Core)

Service tokens are issued on agent routes (§7), so one route serves a controller acting as an agent and a directly connected agent using its own key. Implementation: `service-connections-v1.md`, and `service-connections-v2.md` for services beyond GitHub.

```
GET /agents/{agent_id}/service-grants                auth: controller token acting as the agent (§7), or the agent's own key
  → 200 { grants: ServiceGrant[] }

POST /agents/{agent_id}/service-tokens/{service}     auth: as above. No body
  → 200 { token: string, expires_at: Time, expires_in: number, use_until: Time, resources: ServiceResources }
                                                     // Cache-Control: no-store. Every issuance is recorded
  → 403 grant_missing | not_assigned | forbidden     // forbidden also: the service is switched off on this server
  → 404 connector_not_connected | not_found          // not_found: no such service
  → 409 connector_revoked | grant_account_changed | managed_by_controller
  → 500 internal                                     // the vendor's token outlived its catalog lifetime; not retryable
  → 503 internal                                     // the vendor or the connection is unavailable
```

- **`expires_in`** is the token's remaining life in seconds, as Core counts it. Time the token from when the answer arrived, not by comparing `expires_at` with your own clock.
- **`use_until`** is when to ask again: `expires_at`, or an hour after the issue if that is sooner. A token may outlive it (a service whose tokens live longer than an hour), but it is not used past it, so Core's checks run at least hourly. Both fields are additive; a holder that predates them keeps using `expires_at`.
- **Minted and pass-through tokens.** GitHub's token is minted for the one request and lives at most an hour. A pass-through service hands out its owner's own access token, shared by every agent they grant; it cannot be revoked per agent, and Core renews it while at least 15 minutes remain.

```ts
type ServiceGrant = {
  service: string                     // catalog slug: "github", "atlassian"; later "google-workspace", …
  access: "read" | "write"
  tool_mode: "allow" | "deny"         // allow: only `tools`; deny: every tool of the level except `tools`
  tools: string[]
  resources: ServiceResources
  skill: { name: string; content: string } | null   // the service's SKILL.md
  mcp_servers: { name: string; url: string }[]       // the vendor's MCP servers a session calls; [] for GitHub. Additive
  cli_tools: ServiceCliTool[]                         // the vendor's command-line tool a session's host runs; [] for most. Additive
}

type ServiceCliTool = {               // as the catalog entry's `cli` block has it
  name: string                        // the tool's name in the session, beside `switch` and any MCP server's
  binary: string                      // the executable, run without a shell
  token_env: string                   // the only place the token goes: this variable, in the run's own environment
  config_env: string | null           // where the tool has one: a configuration folder made for the session
  allow: string[]                     // a command's first argument is one of these
  deny: string[]                      // first arguments, and flags refused anywhere in a command
  path_flags: Record<string, "read" | "write">   // flags whose value is a local file, kept inside the session's folder
  output_cap_bytes: number            // more output goes to a file, whose path is returned
  timeout_s: number
  token_refused: { exit_code: number; json_path: string; value: number | string }
                                      // a run that ends so asks for the token again, once
}

type ServiceResources =
  | { installation_id: number; repository_ids: number[] }   // GitHub
  | Record<string, never>                                    // a service whose token cannot be narrowed
```

- **Who gets a token.** Core issues only for an agent that holds a grant to its owner's own connection. A controller must belong to that owner and be bound to the agent (§7); an agent's own key works only while it has no binding.
- **When grants are read.** The agent's host reads its grants when a session starts, and a change applies from the next session. No stream frame announces a change: a removed grant fails the next fetch, and a GitHub token already issued is revoked at once. A pass-through service's token is its owner's own and cannot be revoked alone, so a removed grant stops a running session by `use_until`, within the hour, and a token already handed out stays valid at the vendor until it expires.
- **`credential.revoked` is not used for grants.** It revokes the controller itself.
- **Where tokens go.** The controller keeps tokens in memory and serves them to a session's tools and helpers. It never writes one to disk, a CLI's arguments or its environment, except GitHub's, which `git` receives from its credential helper and `gh` from its wrapper. A service with `mcp_servers` never reaches the CLI at all: the session's host serves each of them to the CLI on loopback, behind a key made for the run, asks for the token on each call and calls the vendor itself. A service with `cli_tools` is the same: the host serves each tool on loopback, checks every command against `allow`, `deny` and `path_flags`, asks for the token on each run, and runs `binary` itself with the token only in `token_env` of that run's environment.

### Provider logins (Management)

```
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

**Core knows only whether an agent is connected.** A controller-backed agent is connected while its controller's stream is attached and beating, its owner has it `running`, and the controller is not revoked. Core does not know where the agent's sessions are, or whether one is running: the open and the beat carry no session map, and a body that still sends `placements` is refused with `422 validation_error` (the one exception to ignoring unknown fields, so a controller still reporting sessions is noticed rather than silently dropped). When a connected agent is addressed, Core delivers the message and posts nothing; if a session has to start, the agent's host posts "Starting a session…" itself. When it is not connected, Core tells the room why: stopped by its owner, its machine removed, or its machine offline.

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

---

## 7. Acting as an agent (Core)

- **Binding.** Management tells Core which controller may act for an agent, through Core's narrow internal interface: `bind(agent_id, controller_id, revision)` and `unbind(agent_id, revision)`. Core stores the binding and never reads Management's tables.
- **Existing routes, new principal.** Every existing `/agents/{agent_id}/...` route accepts a controller access token: message, media, typing, history, participants, tasks, moderation, mediation, `events/report`, `runtime-state`, `connection/subscribe`, `connection/placements`.
  - Core checks `binding(agent_id).controller_id == token.controller_id`.
  - If that fails, it returns `403 not_assigned`.
  - Per-agent API keys keep working for agents with no binding: third-party agents and plugins.
- **Not used by controllers:** the per-agent `GET /agents/{agent_id}/events` stream. §6 replaces it.
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
| `grant_missing` | tokens | The agent has no grant for that service |
| `grant_account_changed` | tokens | The owner re-linked a different account at the vendor; the grant must be made again |
| `forbidden` | any | Authenticated, but not allowed this action, and `message` says why |
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
| §1 enrollment, EC2 | #556 machine secret and capability | Generalise to all controller kinds |
| §2 assignment | #556 `GET /hosted/machines/{id}/agents` | Generalise, and add revisions per agent |
| §3 status | #556 `/heartbeat`, `process_state`, OOM and restart counts, `/provider-status` | Merge into one snapshot |
| §4 operations | #556 `HostedOperation`, `/operations/{id}/claim` and `/result` | Generalise the kinds |
| §5 tokens | #556 `/github-credential` | Generalise to services, on the agent route `/agents/{id}/service-tokens/{service}`. Sealed provider logins are new |
| §6 stream | Per-agent `GET /agents/{id}/events` with connection, generation, beat and takeover | One stream per controller, as a read-side merge of the per-agent buffers |
| §7 act as | Per-agent API keys on `/agents/{id}/...` | Add the controller principal and the binding check |
