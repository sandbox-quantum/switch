# Remote Execution: Hosts, Reachability, and the SDK Host

All paths are relative to `apps/switch-console-desktop/` unless noted.

**Switch Console is not local-only.** An agent runs either on the local machine or on an SSH
host. That choice reaches almost every layer — execution context, agent runtime,
dependency detection, SDK deployment — so a change that only handles the local case is a change that
silently does less on a remote host. This page is the map of the remote half.

## The pieces

| Concern | Where |
|---|---|
| SSH host records, keyed by `~/.ssh/config` alias | `src/main/core/remote-hosts/`, table `remote_hosts` |
| Reachability state machine | `remote-hosts/host-reachability-service.ts`, `src/shared/core/remote-hosts/reachability.ts`, table `remote_host_reachability` |
| SSH config, connection, transport | `src/main/core/ssh/` |
| Where a command runs | `src/main/core/execution-context/` — `local-execution-context.ts` / `ssh-execution-context.ts` |
| How a session is launched | `src/main/core/sdk-host/shared-agent-runtime.ts` |
| Remote dependency detection and install | `dependencies/remote-dependency-manager.ts`, `dependencies/ssh-install-runner.ts` |
| The persistent SDK host | `packages/agent-providers/src/host/`, `src/main/core/sdk-host/` |
| A Switch Console-managed Switch server | `src/main/core/managed-switch-server/` |
| A remote server's shared state: published settings, who uses it | `managed-switch-server/stack-state.ts`, `console-register.ts` |
| Renderer surfaces | `src/renderer/features/remote-hosts/` |

## Reachability is a state machine, not a boolean (CHOO-1682)

Before it existed, "can we reach host X?" was answered independently by every caller — the
pooled connection's in-memory state, an on-demand `testConnection`, or just attempting the
work and interpreting the ssh2 error. That produced unbounded retry loops against dead
hosts and raw transport errors in the UI. Now there is **one per-host state** that every
host-dependent path consults up front:

- `unknown` — never probed this run. **Work is allowed through**; the first attempt is what
  establishes reachability.
- `reachable` — a probe or live connection succeeded.
- `unreachable` — probes failing. Background work pauses; a bounded backoff probe keeps
  checking so recovery is automatic.
- `suspended` — **authentication** failed. Retrying a rejected key never self-heals, so
  there is no automatic probing; the user must fix auth and retry explicitly.

The backoff is `1s, 5s, 15s, 30s, 60s, 300s` (capped and repeated). Early steps are tight
because the common cause is a credential the user is actively re-establishing (VPN,
`aws sso login`); the long tail keeps a genuinely dead host from costing anything. A manual
retry short-circuits the schedule.

**When adding a host-dependent path, gate it on reachability rather than discovering the
failure yourself.** The distinction between `unreachable` and `suspended` is the point: one
is worth retrying automatically and the other is not.

### Never report "fine" for something you did not observe

A check that could not run is **not** a passing check. Collapsing "couldn't determine" into
"satisfied" is the stale-green bug (CHOO-1780) — the UI claims a host is ready, the user
acts on it, and the failure surfaces somewhere less obvious. Keep `unknown` as a
first-class answer all the way to the surface.

## Host setup is a persisted plan (CHOO-1809)

Onboarding a host used to be a single boolean — a row existed or it didn't — with every
prerequisite probed independently by whichever component happened to render. There was no
notion of *where a host got to*, so nothing could be resumed or ordered, and a failure
halfway through left no record.

A **setup plan** is that missing object: an ordered list of steps, persisted per host in
`remote_host_setup_plans`, answering "what still needs to happen on this host, and what
went wrong last time?".

- Model: `src/shared/core/remote-hosts/setup.ts`, `host-status.ts`
- Main: `src/main/core/remote-hosts/setup/` — `plan-builder.ts`, `host-setup-runner.ts`,
  `host-setup-service.ts`, `setup-plan-store.ts`, `step-outcomes.ts`
- Renderer: `src/renderer/features/remote-hosts/setup/`, `host-readiness.ts`

Two properties worth preserving:

- **Nothing advances the plan on its own.** Each step runs when the user asks for that
  step; the ordering is guidance, not automation. There is deliberately no
  run-everything button.
- **A check outcome is richer than a boolean** — `satisfied`, `missing`, `not-running`,
  `wrong-version`, `unknown`. `not-running` matters because `docker` being on `PATH` tells
  you nothing about whether `dockerd` is up, and running an installer over a stopped
  service would misreport the cause.

## A remote Switch server is shared (CHOO-2893)

A server Switch Console runs on a remote host is used by everyone with access
to that host, from their own Consoles and often under their own accounts. The
access boundary is being able to run Docker there — which already means being
able to read every secret the stack has — so nothing here pretends otherwise.

**The host is the source of truth for its stack.** A remote stack's ports and
credentials used to live only in the encrypted store of the Console that
started it; a second Console had neither, generated its own, rewrote the
stack's `.env` and took the running server down. Now:

- The `.env` the stack was last started with is published into a Docker volume
  beside the stack's own (`<project>_console-state`, labelled outside compose's
  project so `compose down -v` leaves it). Every account that can reach the
  daemon can read it, where the working dir holding the real `.env` belongs to
  whoever started the stack first. It is read and written through a throwaway
  container of the stack's own Postgres image, with secrets on stdin, never in
  a command line — see `stack-state.ts`.
- A start reads the host first (`inspectStack`) and takes the published copy,
  then this account's `.env`, then this desktop's cache. New credentials are
  made **only** on a host with nothing of the stack at all. Another account's
  unpublished stack, or a host that cannot be read with no cache to fall back
  on, is refused before anything is written. The cache may fill gaps in a
  partial `.env` only when it agrees with every port and credential the file
  does carry — a cache from before someone else's reset would otherwise put
  the old database password back.
- The published copy is stamped with the creation time of the Postgres volume
  it was written for (after compose up on a first start, when the volume did
  not exist at publish). A copy whose stamp no longer matches is ignored: a
  Console from before settings were shared can reset the stack without
  knowing the copy exists, leaving it naming credentials that open nothing.
- Every account's Console writes the published `.env` verbatim. Compose run
  from a second working dir with a byte-identical `.env` recreates nothing
  (measured; it follows from the bundled compose referencing nothing by path),
  which is what lets several accounts run one stack.
- **Connect** joins a running stack without writing its settings differently or
  running compose. **Disconnect** leaves it running for everyone else; only
  **Delete for everyone** resets it.
- A Console re-reads the host at launch, on reachability recovery, and when a
  running stack stops answering (rate-limited), so a stack another Console
  stopped, restarted on new ports or reset shows as it is. The status carries a
  `notice` for what this Console did not do.

**Updating a shared stack is an update for everyone.** A Console brings a
managed stack up to its own switch-core pin when it takes the stack up
(`managed-upgrade.ts`), and on a shared host that restarts it for everyone
using it, from the account that happened to do it — the pre-update backup lands
in that account's working dir. So:

- **Connect** joins as-is only at this build's own version. An older stack is
  brought up to date as a start from the host's settings (the connect step
  says so and names who else uses it); a newer one is refused, since its
  database has migrated past anything this build can run.
- At launch or reachability recovery, a running stack behind the pin is updated
  on its own only when no other Console has used it in the last
  `RECENTLY_SEEN_DAYS` (the register on the host says who). Otherwise its
  upgrade is `held`: the stack is still forwarded, sessions on it wait
  (`ensureReady`), and the server page offers *Update for everyone*, naming
  who it reaches. A register that cannot be read counts as others using it. An
  update this account already started (its journal is there) is resumed
  regardless.

**Identity is shared; attribution is not.** Everyone signs in as the stack's one
seeded admin — sessions are owner-only on the server with no admin override, so
per-person accounts would hide each person's sessions from the others. Instead:

- Each Console has a random id (`console-identity.ts`, deliberately not the
  telemetry install id) and a `user@host` name, sent as `X-Switch-Console-Id` /
  `X-Switch-Console-Name` to managed servers only; switch-core stamps them on
  its log lines. A server someone else runs signs each person in as themselves
  and is told nothing about the desktop.
- Each Console records itself in the state volume (`console-register.ts`): a
  register of who uses the stack and an activity log of starts, connects,
  stops, resets and disconnects. Every action refreshes the Console's entry;
  otherwise it is refreshed at most once a day, since each write is a
  container run on the host. A disconnect takes the Console off the register
  and keeps its line of activity. A reset keeps the activity. The
  record is for people, never a control, and a write that fails does not fail
  the operation: the server page says what could not be recorded
  (`recordWarning`) until a later record gets through.

**Several Consoles, one agent.** Under one account, each Console holds its own
row for the same agent and writes the agent's one watcher on the host. Model
and instructions come from the agent's config file on the host, so they agree.
Auto-approve lives in each row, so the watcher's saved spec on the host is
what they share: every watcher write takes auto-approve from it and brings the
row in line, except the write that follows the person changing it
(`pushRemoteAutoApprove`). When the watcher is not starting sessions — stopped,
or automatic sessions off — nothing rewrites the spec now, so that change goes
into it directly (`recordAutoApproveOnHost`).

Two Consoles under one account acting on one session do not collide: prompts
queue in the session's SDK host and run in turn, and either one's interrupt or
stop ends the turn for both — it is one session, reached through the same
sidecar.

**Removing an agent.** A plain remove takes the row out of this Console and
leaves the agent running on its host, for its automatic sessions and anyone
else using it there. *Also remove it from the host* stops it there and deletes
the files Console provisioned. Deleting it in Switch implies that: a deleted
identity has nothing left to run.

**Agents another account runs are not loaded.** Their working directories,
credentials, watchers and sessions are in that account's home, which this
account cannot read — and a session is reached through its owner's sidecar — so
Load existing agents does not offer them. They are on the shared server all the
same, and can be talked to in its rooms.

**Limitations.** Rootless Docker gives each account its own daemon, so there is
nothing to share. A remote server's port numbers must also be free on each
desktop, because the forward mirrors them and agent endpoints depend on the
number. Two different Console versions on one account restart each other's SDK
hosts. Agents that run on someone's laptop appear in the server view but cannot
be loaded.

## Persistent execution

The same SDK host implementation serves local and SSH sessions, hosted
differently: an SSH session's host is deployed to the remote machine and runs
detached, while a local session's host is supervised by Console. SSH carries
bundle deployment and management commands; it does not own provider process
lifetime. Closing Console leaves SSH execution running and stops local
execution. A reconnect reads the saved transcript and never repeats an
uncertain command.

The execution machine needs Node 20.3 or newer, Git, the selected provider,
its own authentication and network access. Setup plans list only supported
SDK providers. Installer commands use pipes with closed input and report
failures in the setup log.

See [SDK sessions](../../docs/sdk-sessions.md) for recovery fencing and remote
integration-test requirements. Check reachability before host-dependent work,
and verify changes against both local and SSH execution.
