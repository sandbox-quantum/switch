# Factory Droid

Factory Droid uses provider ID `droid` in Console, Core and the headless
controller. Install Droid on the execution machine using the installer offered
in provider settings. Run `droid` there once to sign in, or configure
`FACTORY_API_KEY` in that machine's execution environment. Do not paste keys into
agent instructions, rooms or command arguments.

## Verified CLI entry point

On 2026-11-06, the official installer and
[ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/agent.json)
both supplied **1.4.1**. The Linux x64 binary was downloaded from Factory and
verified against its published SHA256. Its `exec --help` advertises `acp`;
both commands below answered ACP `initialize` with protocol version 1:

```sh
droid exec --output-format acp
droid exec --output-format acp-daemon
```

Switch uses the registry's `acp-daemon` output format. This is an option to
`exec`, not a standalone subcommand. Factory's
[IDE guide](https://docs.factory.com/ide-integrations) currently documents the
other spelling. There is no fallback to `stream-jsonrpc`, which is a different
protocol.

The actual handshake identified `@factory/cli` 1.4.1 and advertised HTTP/SSE MCP,
images, embedded context, `loadSession`, and session resume/list/close/fork.
These advertisements establish protocol support, not successful authenticated
operation. Older releases have not been validated; use 1.4.1 or newer and rerun
the conformance check when upgrading.

The mode IDs, permission-option scopes, form schema and Factory tool metadata
were also inspected in the shipped 1.4.1 implementation. Unit tests simulate
these shapes; they are not captured authenticated wire traces.

## Readiness and permissions

Readiness runs only:

```sh
droid doctor --checks auth --json --timeout 5000
```

It reads `auth.verify`; it never calls ACP `authenticate`, creates a session,
starts a browser or sends a model prompt. A present key or credential file is
not evidence of valid authentication. Network errors, unreadable diagnostics and
older CLIs without `doctor` report unknown with diagnostic/update instructions.
Raw doctor output is not returned or logged, since it can identify an account.
The signed-out 1.4.1 CLI returned `no usable credentials found (not logged in)`.
Its initialize response still offered both device-pairing and API-key methods.

Sessions explicitly select the advertised `normal` (Auto Off) mode, including
when resuming a session with a saved autonomy preference. If that mode is absent
or refused, startup fails. Switch grants `allow_once` in full access and for
its own registered MCP servers, while connector tools still require approval.
Auto-accept-edits grants edit requests only. `auto` conservatively retains
normal mode; this integration does not enable Droid's autonomy tiers.

Droid's `allow_always` choices include changing autonomy tiers and persistent
tool/server policies. Switch removes all of these choices rather than treating
them as session-only grants. Ordinary approve, deny and cancel remain available.
Auto-approve cannot override organization restrictions or actions for which
Droid never requests permission. Read operations that Droid itself allows in
normal mode do not acquire an extra Switch approval.

The provider preserves its supplied environment and inherits `FACTORY_API_KEY`,
`FACTORY_HOME_OVERRIDE` and `FACTORY_DISABLE_KEYRING` through the existing host
allowlist. Separate-user systemd controllers pass the key and keyring setting,
but exclude the controller user's Factory profile directory. Sign in as the
actual agent user or supply the controller's API-key environment for that setup.

## Models and recovery

Models come from ACP session config options or the session's model list; none
are hardcoded. The generic adapter selects the requested model before prompting,
rejects unavailable advertised IDs, and rejects a config response that echoes a
different selection. A successful configuration exchange alone does not prove
which backend handled inference.

Mid-turn messages queue in arrival order. Interrupt sends `session/cancel`,
cancels outstanding approvals/questions and ignores subsequent interrupted-turn
content until the prompt settles. Form questions share the ACP elicitation
handler used by Antigravity; URL authentication elicitations are not advertised.
MCP attribution uses Droid's `_meta.factory` only for `source: "mcp"`; native
Factory connectors do not gain Switch MCP privileges.

Recovery asks `session/load` for the stored native ID in a fresh CLI process,
or `session/resume` if only that capability is advertised. An absent capability
or a rejected load is surfaced to the host; no transcript is replayed as new
instructions. Factory's note that Zed does not restore sessions is not proof
that native loading works or fails in Switch.

## Local validation record

Checks run on Linux x64, 2026-11-06. Expensive suites used the shared
`/home/ubuntu/project/switch-tests.lock` via `flock`.

From `console/`:

| Command | Result |
| --- | --- |
| `pnpm -r --filter './packages/**' run build` | Passed. |
| `pnpm -r run typecheck` | Passed. |
| `pnpm -r run lint` | Passed; an existing type-import warning remains in desktop's `propagate-server-api-url.db.test.ts`, which this change does not edit. |
| `pnpm -r run format:check` | Passed. |
| `pnpm -r --filter './packages/**' run test` | Shared: 71 passed; runtime: 166 passed; Core package: 162 passed; providers: 1,050 passed / 8 skipped; plugins: 150 passed. Controller initially had two obsolete provider-count assertions; corrected and rerun separately. |

From `console/packages/agent-controller/`, `pnpm run test` passed with 416
tests and 2 existing skips after correcting those assertions. The earlier
focused command `pnpm exec vitest run src/status.test.ts src/systemd-runtime.test.ts`
also passed all 50 tests.

From `console/packages/agent-providers/`:

```sh
pnpm exec vitest run src/droid/droid-acp.test.ts src/acp/acp-adapter.test.ts src/antigravity/antigravity-adapter.test.ts
pnpm exec vitest run src/droid/droid.integration.test.ts --reporter=verbose
```

The final focused run passed all 93 tests, including an additional test
ensuring that full access never substitutes a persistent grant for a missing
allow-once option. With verified Droid 1.4.1 on `PATH`, the real-CLI run passed
initialize and readiness (2 tests); all 10 authenticated scenarios explicitly
skipped because Droid reported signed out.

From `console/apps/switch-console-desktop/`:

```sh
pnpm exec vitest run --project node --project main-db
pnpm exec electron-vite build
pnpm exec vitest run --project node \
  src/main/core/agents/agent-model-catalogue.test.ts \
  src/main/core/providers/agent-provider-catalogue.test.ts \
  src/shared/core/providers/agent-provider-registry.test.ts \
  src/main/core/telemetry/renderer-events.test.ts \
  src/renderer/features/locations/components/agent-model-catalogue.test.ts \
  src/renderer/features/switch-buddy/switch-buddy-drift.test.ts \
  src/renderer/features/switch-buddy/buddy-telemetry.test.ts
```

The broad desktop run had 5,809 passing tests, 6 skips and one provider
telemetry whitelist failure. The missing Droid enum entry was corrected;
the seven affected files then passed all 55 tests. The full desktop suite
was not repeated after that correction. The desktop production build passed
again after the final source changes.

From the repository root:

```sh
just check
just typecheck
uv run --project core pytest -q \
  core/tests/switch_core/providers/test_provider_registry.py \
  core/tests/switch_core/management/test_advanced_config.py
```

Ruff passed; mypy checked 639 source files successfully; all 42 selected Core
tests passed. The updated gateway-route database expectations were not run.
Docker-dependent suites and renderer browser tests were not run.

## Acceptance evidence still required

The implementation has deterministic protocol tests and a ten-scenario real-CLI
suite. The available machine has no Factory credentials: real initialize and
readiness can be checked, but authenticated scenarios must skip with that
explicit reason. In particular, these are **unverified with the real CLI**:

- the selected model handling inference;
- room joins, context, mentions and an actual Switch MCP tool call;
- tool completion, chat approve/deny with denial preventing execution, and
  auto-approve;
- ordered mid-turn input and cancellation during inference or approval;
- conversation context after restarting the CLI/session host;
- authenticated Console, SSH and headless-controller execution.

Run the suite on a signed-in execution machine, optionally selecting an
advertised model:

```sh
cd console/packages/agent-providers
DROID_TEST_MODEL=<advertised-model-id> pnpm exec vitest run src/droid/droid.integration.test.ts
```

The resume scenario starts a fresh adapter/CLI process and checks recall of a
word from the prior conversation. Do not mark it passed from a load response
alone. The standard MCP conformance scenario requests an echo call; exercise
an actual room tool in the Console/headless demo as well. If a required scenario
fails, record its versioned result before adding any upstream-limitation skip.
No authenticated scenario is preemptively skipped in the Droid test.

Record the short video described in [Adding support for a new agent CLI](new-agent-cli.md):
show signed-in detection, create an agent with a chosen model, answer a room
mention, approve and deny shell activity, queue input, interrupt, restart and
demonstrate preserved context. Repeat a room exchange on the headless controller.
Attach the real-CLI summary and video before requesting PR acceptance.
