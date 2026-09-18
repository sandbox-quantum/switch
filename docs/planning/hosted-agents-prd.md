# PRD: Switch Hosted Agents

Status: Draft for review  
Date: 2026-09-17  
Implementation base: `codex/sdk-server-split`  
Source reviewed: `c0d489e8`

## 1. Problem and outcome

Using Switch today requires users to arrange a Switch server and an execution machine with installed, authenticated agent providers. Coding agents also need repository access, build dependencies and a workspace. This setup prevents a new user from quickly getting to useful work, and makes unattended execution their responsibility.

Switch Hosted Agents adds an optional service operated by Switch. A user signs into Switch Console, supplies personal provider credentials, connects GitHub, selects a repository and creates an agent. Switch supplies the server, execution environment and persistent storage. The agent can clone repositories, run builds, change code and open pull requests while Console is closed.

Console remains the primary management interface, with Local, SSH and Hosted execution choices. Existing local and SSH agents continue to work. Hosted execution is optional and does not automatically move existing agents or their conversations.

## 2. Agreed product scope

| Area | MVP requirement |
| --- | --- |
| Service ownership | Switch operates the server and hosted execution. Users do not provision infrastructure. |
| Primary workflow | Coding agents working against GitHub repositories, including private repositories, builds and PR creation. |
| Providers | Codex, Claude Code, OpenCode, Antigravity ACP and Cursor. One provider may be implemented first; all five are required for the full MVP. |
| Provider authentication | Personal API keys and provider-issued tokens supplied by the user, explicitly including Claude setup tokens. No interactive provider browser-login flow in Switch. |
| Ownership | Personal agents and credentials. Existing owner authorization governs session access and controls. |
| Runtime | Persistent environment per hosted agent, with room watching available while the agent is enabled. |
| Commercial limits | No plans, credits, billing system or user-facing product quotas in the MVP. Operator resource and concurrency boundaries still apply. |
| Recovery | Preserve saved state, support safe recovery where possible and expose failures. No automatic cross-host migration commitment. |

“No browser login” applies to **model-provider authentication**. It does not prohibit ordinary Switch sign-in or GitHub authorization. Users obtain provider credentials outside Switch and submit them through Console.

## 3. Primary user journey

1. **Sign in.** Console offers the managed Switch service without requiring a server URL, SSH host or cluster configuration.
2. **Create a hosted agent.** Choose Hosted, name the agent and select a provider/model. Local and SSH remain available as separate choices.
3. **Connect the provider.** Supply a personal API key or supported provider token. Show the credential type expected for that provider. Secrets are masked and are not returned after saving.
4. **Connect GitHub.** Authorize access to selected repositories and the operations necessary to clone, push a branch and open a PR. Show the repositories available to the account and any missing permissions.
5. **Choose the workspace.** Select a repository and starting branch. Offer a managed build environment and optional setup instructions. Advanced settings must not be mandatory for a supported, ordinary repository.
6. **Provision.** Show progress for capacity assignment, workspace creation, repository checkout, credential checks and provider readiness. A failed stage has a useful error and a safe retry action.
7. **Start work.** Open a Console conversation or assign the agent to a room and address it there. The agent can edit files, execute builds, push its work and open a PR within its granted permissions.
8. **Leave and return.** Close Console. Work and room-triggered startup continue. Reopening Console discovers the hosted agent and attaches to its existing conversation without launching another copy or replaying the initial prompt.

GitHub credentials and model-provider credentials are separate connections. Users must not need to paste either into a chat message or repository file.

## 4. Functional requirements

### 4.1 Agent configuration and placement

- Persist hosted placement and launch configuration on the service so execution does not depend on a laptop's database or filesystem.
- Persist agent identity, owner, provider/model settings, repository configuration, environment selection, startup policy and credential references.
- Display actual lifecycle state and errors in Console. Proposed labels: Setting up, Ready, Working, Waiting for approval, Pausing, Paused, Queued for capacity, Needs attention and Deleting.
- Treat agent lifecycle, session lifecycle and connectivity as distinct facts. A disconnected worker must not appear successfully stopped.
- Prevent local or SSH watchers from starting a second copy of an agent assigned to hosted execution.
- Retrying agent creation or provisioning must reuse the same operation identity and converge on one assigned environment.

### 4.2 Provider support and credentials

- Support the existing five SDK adapters through the shared session protocol. Provider capabilities can differ; controls must reflect the adapter's actual support.
- Validate each provider's supplied credential in the hosted execution environment before declaring it ready. An authentication check does not guarantee quota or access to every model.
- Support Claude setup tokens as an explicit credential type. Treat their accepted format, expiry behavior and runtime integration as implementation work to verify, not as established behavior of the current hosted system.
- Build and validate a provider authentication matrix covering credential types, required configuration, readiness checks, rotation and expiry. A provider without a verified noninteractive credential path blocks completion of the all-provider MVP; do not silently introduce browser login or mark it supported.
- Permit replacement and removal of saved credentials. Stop new work using a removed connection and report existing execution until its shutdown is confirmed. Replacing a credential must not silently restart an active turn.
- Store secrets encrypted with scoped access. Launch specifications contain references, not plaintext secrets. Treat provider homes and session state as potentially credential-bearing.
- Keep provisioning-service credentials, infrastructure administration credentials and other users' secrets out of agent environments. An agent may access credentials deliberately assigned to its own execution context.
- Redact secrets from logs, diagnostics, command displays and user-visible errors.

### 4.3 GitHub and build workspaces

- Support repository discovery, private cloning, explicit branch selection, branch creation/push and PR creation.
- Scope repository access to what the user authorizes. Surface organization restrictions, missing permissions and revoked credentials without falling back to broader access.
- Give each agent its own persistent workspace and provider state. Do not share writable worktrees between different agents by default.
- Preserve uncommitted changes across pause, session stop and ordinary worker restart. A fresh session must not reset or discard the workspace.
- Provide a managed, versioned build environment. Document its supported tools and resource boundaries before pilot onboarding. Repositories needing additional dependencies can use visible setup steps; arbitrary repository compatibility is not promised.
- Run repository setup scripts with the same isolation and resource boundaries as agent work. Setup output and failures are available in Console.
- Define workspace coordination for simultaneous room sessions. For the first milestone, serialize write-capable work in an agent's shared checkout; do not allow independent sessions to mutate it concurrently without an explicit strategy.
- Show the resulting PR link and preserve useful build/task output. PR merge is not an automatic platform action.

### 4.4 Execution and controls

An enabled agent keeps its hosted environment and room watcher available. Provider sessions start when needed. The MVP does not automatically suspend the environment or shut down idle sessions to save capacity.

| Action | Required behavior |
| --- | --- |
| Close Console | Execution and room watching continue. |
| Interrupt | End the active turn using the provider's supported control; keep conversation and files. |
| Stop session | Stop that session and retain saved state. If the agent remains enabled, a later room mention may create another session. |
| Stop agent | Disable new starts, confirm execution has stopped, release allocated compute and retain persistent workspace/session data. |
| Start stopped agent | Recreate execution, reattach retained storage and restore eligibility for work after ownership and readiness checks. Do not replay uncertain work. |
| Resume session | Explicitly reopen the saved conversation after required recovery and readiness checks. |
| Pause agent | Disable new starts, stop active sessions and confirm completion before showing Paused. Surface any unconfirmed stop. |
| Enable agent | Restore eligibility for room-triggered starts. Do not replay previous uncertain work or automatically repeat a stopped turn. |
| Delete agent | Confirm deletion, disable starts, fence/stop execution and delete active hosted data and credential bindings according to the deletion policy. Report incomplete cleanup. |

Pause must prevent races with incoming messages and provisioning retries. Messages received while paused must not silently start execution. The proposed MVP behavior is no automatic backlog execution on enable; the user explicitly requests new work. The implementation must preserve existing durable-delivery guarantees while making this policy visible.

Approvals and questions use the existing server-authorized SDK request flow. Closing Console does not grant permission; pending requests remain subject to existing expiry behavior. Ordinary transcript output remains in session details, while explicit agent room replies follow the existing messaging path.

## 5. Persistence, recovery and deletion

Persist the workspace, provider home/native conversation, host journals, watcher assignments and required launch metadata. The Switch service retains authoritative session history, command outcomes and request state.

- **Client loss:** Reattach to saved sessions without relaunching the provider or resending work.
- **Recoverable worker crash:** Verify that previous execution stopped, reconcile saved events and obtain the server's recovery epoch before continuing the native conversation.
- **Network loss:** Preserve durable command/event identities and existing lease safety behavior. A timeout does not prove an operation failed or that the provider stopped.
- **Node loss or unavailable state:** Show Needs attention and keep server history readable. Replacement execution requires proof that old execution cannot continue and valid recoverable state. Reattaching a volume alone is insufficient.
- **Uncertain side effects:** Preserve unknown outcomes. Never automatically retry a push, PR creation, build-triggering command or other uncertain provider action.
- **Lost native conversation:** Explain the limitation and offer an explicit fresh conversation where supported; retain available history and workspace.

For the pilot, stop and pause retain user data, with no idle-time purge. Users can explicitly delete hosted agents and their active data. Shared personal credentials are removed only when no longer needed or when the user deletes that credential connection.

Encrypted persistent storage and backups are required. Before pilot launch, engineering must document and test backup coverage, restore procedure, recovery-point/recovery-time targets, backup retention and deletion expiry. Do not promise zero loss of uncommitted changes after storage failure. Credential removal from Switch cannot revoke an externally issued credential at its provider unless that provider exposes and authorizes such an operation.

## 6. Service boundaries and operations

The service runs code and builds supplied by users. Isolate agent files, secrets, processes and network access across users. Select and validate the execution isolation mechanism before admitting independent pilot users. Database tenant isolation does not by itself isolate running code.

Each worker has bounded CPU, memory and disk, and the operator sets a concurrency/capacity ceiling. These are infrastructure boundaries, not a billing system. When capacity is unavailable, show a queued state or actionable failure; do not create unbounded workers. Report disk exhaustion and resource termination clearly.

Operators need provisioning status, worker health, restart/recovery diagnostics, queue depth, storage usage and authentication failure signals without exposing secrets. Record security-relevant lifecycle and credential actions with actor and outcome. Provider consumption remains charged according to the user's provider account; do not imply that supplying a key includes unlimited model usage.

## 7. Architecture direction

Target clarified on 2026-09-18: run the Switch service and hosted controller on the
existing Kubernetes cluster. The controller creates an isolated VM or sandbox per
hosted agent, attaches persistent workspace/session storage and delivers that
agent's scoped credentials. Workers connect to Switch, the repository host and the
model provider. The VM/sandbox technology remains undecided; using Kubernetes for
the controller does not require execution to use ordinary Kubernetes pods.

An explicit **Stop agent** action must release that agent's allocated compute while
retaining its disk and saved identity. It disables new starts until explicitly
started again. Starting recreates execution and reattaches storage after ownership
checks; a stopped worker must not be revived just because an old desired-state
record or room message exists. This is distinct from interrupting a turn, stopping
one session, or closing Console, and does not introduce automatic idle suspension.
Releasing an agent's allocation does not guarantee that a shared cluster node or
its cloud bill disappears immediately. Persistent storage remains allocated.

The controller (also called worker manager) is an infrastructure service, not an
AI agent. An AI onboarding assistant is an optional future UX idea, not required
for provisioning or included in the current MVP.

1. **Console:** Hosted onboarding and lifecycle UI; authenticated configuration and secret submission; existing session discovery and conversation controls.
2. **Switch service:** Authoritative agent placement, desired lifecycle state, owner authorization, sessions, commands, approvals and history. Durable provisioning operations and worker assignments extend this authority.
3. **Optional hosted controller:** Reconcile desired state, provision isolated environments and storage, deliver scoped credentials, monitor execution and report observed state. Infrastructure authority stays here.
4. **Hosted environment:** Existing room watcher, shared SDK host, provider adapter, provider process and persistent coding workspace.

Use one deployment backend for the MVP. Keep the controller boundary explicit, but a multi-backend abstraction and customer-operated hub distribution are not MVP deliverables. Console should manage hosted agents through the service rather than holding infrastructure credentials or requiring direct SSH to workers.

Extract reusable host configuration construction from desktop-specific services. Reuse server-issued epochs, durable commands, journal reconciliation and native provider resume behavior. Add deployment-level assignment/fencing; existing process-group checks apply to a local execution host and do not establish cross-node exclusivity.

The current Helm chart requires a single Switch core replica. Worker scaling must not assume that increasing core replicas is safe. High availability of the control service is a separate design consideration, not an implicit benefit of running workers on a cluster.

## 8. Delivery milestones

| Milestone | Reviewable outcome |
| --- | --- |
| M0: feasibility and design | Verify all five noninteractive provider auth paths; select execution backend, isolation, GitHub authorization and supported build environment; specify recovery/storage guarantees. |
| M1: first vertical slice | Codex or Claude runs a GitHub coding task in a persistent hosted environment. Console can close, a room message can start work, and Console reattaches to the same session. |
| M2: complete management | Safe create/retry, pause/enable, stop/resume, credential replacement/removal, capacity reporting, diagnostics and deletion. |
| M3: provider completion | All five providers pass hosted credential, coding and lifecycle acceptance tests; Claude setup-token onboarding is verified. |
| M4: pilot readiness | Isolation, duplicate prevention, failure recovery, backup/restore and deletion tests pass; operational runbook and supported-environment documentation are ready. |

M1 is a development milestone, not completion of the agreed all-provider MVP. Dates and staffing estimates follow the M0 feasibility work.

## 9. Acceptance criteria

1. A new user provisions an agent from Console without installing providers locally or configuring a server, SSH host or cluster.
2. The agent clones an authorized private GitHub repository, changes a file, runs a representative build/test, pushes a branch and opens a PR. Missing GitHub permissions fail visibly.
3. With Console closed, addressing an enabled agent in a room starts or reaches its session. Reopening Console shows its transcript and continues that conversation without a second launch.
4. Duplicate create/start commands, concurrent Console clients and controller retries produce one authorized execution assignment and do not repeat provider actions.
5. Every provider passes a hosted noninteractive credential test and representative coding task. Claude is tested with a user-supplied setup token. No provider authentication step launches a browser flow in Switch.
6. Expired/rejected credentials produce actionable errors; replacement restores readiness safely. Removing a connection prevents new work and shows any active stop as pending until confirmed.
7. Pause racing with a room message cannot start new work after pause is confirmed. Stop session preserves files and history; its distinct startup behavior is explained in the UI.
8. Worker crash and network interruption preserve journal/command identity. Unknown actions are not replayed. Loss of a node never starts a competing replacement without verified fencing.
9. One user's agent cannot read another user's workspace, credentials or sessions, nor access controller infrastructure credentials. Repository scripts are included in this test.
10. Capacity exhaustion, out-of-memory termination, full disk, clone failure, provider startup failure and build setup failure appear as distinct useful states.
11. Backup/restore tests demonstrate the documented data-loss window. Deletion removes active data and documents when backup copies expire; failed cleanup remains visible.
12. Local and SSH workflows still function and cannot accidentally provision or launch hosted agents. Existing approval authorization and capability-specific controls remain intact.

Measure onboarding completion, time from agent creation to readiness, first-PR success, credential/provisioning failure rates and successful reattachment/recovery. Set numerical performance targets after the first vertical slice; no unmeasured latency or availability promise is part of this draft.

## 10. Non-goals and remaining engineering decisions

Out of scope: provider browser-login flows, non-GitHub hosts, shared team credentials or delegated session ownership, plans/billing, automatic local-to-hosted migration, automatic cross-host session migration, idle scale-to-zero, arbitrary custom VM images, and automatic PR merge.

Before implementation is committed, resolve:

- The verified credential mechanism for every provider. If any cannot meet noninteractive authentication, surface the scope conflict rather than quietly dropping that provider.
- Execution backend, isolation technology, region and environment sizing.
- GitHub authorization mechanism and least-required permissions for private clone/push/PR operations.
- Supported build tools and treatment of repositories requiring privileged containers or unusual services.
- Server-side assignment, pause/message races and workspace scheduling across room sessions.
- Backup objectives, retention/deletion windows and supported node-loss recovery procedure.

These are engineering decisions under the agreed product scope. This document does not claim that hosted infrastructure, provider authentication compatibility or recovery behavior has already been implemented or deployment-tested.

## 11. Source anchors

- `core/switch_core/sessions/service.py`: session authority, ownership, commands and recovery.
- `core/switch_core/gateway/sessions.py`: authenticated session discovery and control API.
- `console/packages/agent-providers/src/host/shared-watcher.ts`: durable room-triggered session assignments.
- `console/packages/agent-providers/src/host/shared-host.ts`: shared host lease and recovery behavior.
- `console/apps/switch-console-desktop/src/main/core/sdk-host/shared-agent-runtime.ts`: desktop-dependent host configuration builder.
- `console/apps/switch-console-desktop/src/main/core/sdk-host/shared-host-deployment.ts`: existing local/SSH deployment.
- `console/apps/switch-console-desktop/src/main/core/locations/location-transport.ts`: current local/SSH transport model.
- `console/docs/sdk-sessions.md`: provider capabilities, persistence and supported recovery boundaries.
- `deploy/remote/helm/switch/values.yaml`: existing deployment settings and core replica constraint.
