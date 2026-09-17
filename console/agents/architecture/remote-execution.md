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

## Persistent execution

The same SDK host implementation serves local and SSH sessions. SSH carries
bundle deployment and management commands; it does not own provider process
lifetime. Closing Console leaves SDK execution running. A reconnect reads the
saved transcript and never repeats an uncertain command.

The execution machine needs Node 20.3 or newer, Git, the selected provider,
its own authentication and network access. Setup plans list only supported
SDK providers. Installer commands use pipes with closed input and report
failures in the setup log.

See [SDK sessions](../../docs/sdk-sessions.md) for recovery fencing and remote
integration-test requirements. Check reachability before host-dependent work,
and verify changes against both local and SSH execution.
