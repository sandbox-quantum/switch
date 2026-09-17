# Hosted agents: phase 1 review checkpoint

Base: `c0d489e83ca0e84ff0d0ec0e3d584a6b2a31b4c4` on `codex/sdk-server-split`.
Product baseline: [Hosted Agents PRD](hosted-agents-prd.md).

## Scope

The first implementation checkpoint establishes a headless runtime foundation:

- Build shared SDK configuration outside Electron from explicit, resolved inputs.
- Bootstrap one hosted worker from an operator specification and mounted credentials.
- Reuse existing SDK commands, identity, execution and recovery boundaries.
- Record noninteractive authentication evidence and gaps for all five providers.

This is a prerequisite to the PRD's M1 vertical slice, **not completion of M1 or
the MVP**. It does not supply managed sign-up, GitHub authorization/cloning, cloud
provisioning, Console Hosted onboarding, multi-user execution isolation, encrypted
secret storage or a hosted room-start controller. The operator supplies an existing
Switch agent identity, workspace and credentials. A private provider home is
configuration separation, not a sandbox for untrusted code.

## Repository and runtime boundaries

Reusable product/runtime code belongs in `switch`. Operated infrastructure,
environment configuration and secret-store integration belong in the private
deployment repository. This checkpoint modifies only the product repository and
does not deploy infrastructure or change a live Switch instance.

The worker starts one assigned session. Its room binding can deliver messages to
that session. A watcher creating additional sessions needs controller supervision
of those sessions in a later step. Stopping a detached watcher's parent does not
establish that every provider it launched stopped.

## Review gates

1. Shared builder parity for all five providers, model options, native resume and
   room identity; desktop caller migrated with regression coverage.
2. Bootstrap rejects invalid inputs and mismatched identity; saved state preserves
   identifiers on retry and cannot be silently repurposed.
3. Secrets enter the explicit runtime environment, not persisted launch specs or
   command-line arguments. No unrelated ambient credentials are inherited.
4. Shutdown and duplicate-start behavior are tested at the process boundary, with
   restrictions on real process/fencing verification called out.
5. Provider evidence distinguishes implementation support from live authentication.
   Unverified paths remain blockers to the all-provider MVP.

Stop at this checkpoint for user review. The next phase should join the runtime to
durable hosted assignments and provisioning, with isolation and credential delivery,
then expose that path through Console and GitHub onboarding.

## Verification record

Baseline before implementation: the agent-providers package had 268 passing tests
and 12 failing tests across launch/shared-host/recovery suites. Those failures trace
to the execution sandbox denying `ps` (`spawn EPERM`), which the existing process
fencing requires. Do not remove that check or describe mocked coverage as proof of
real process recovery. The baseline desktop initial-prompt/deployment tests passed
(13 tests), and the provider-package typecheck passed.

Post-change integration results:

- Provider package: 296 passed, 12 failed. The same baseline launch/recovery
  failures remain because `ps` is denied; four associated unhandled errors have
  the same cause.
- Desktop SDK-host suite: 66 passed, 3 skipped, 1 failed. The failure is the
  unchanged remote watcher inspection test, also denied `ps`.
- Final focused bootstrap/builder/log/supervisor suite: 36 passed, including an
  additional regression for paths whose names begin with `..`.
- Both provider-package and desktop TypeScript checks passed.
- Changed TypeScript files pass lint; changed code/config passes formatting checks.
  `git diff --check` passes.
- Provider distribution build passed; built CLI usage smoke passed through both
  canonical and symlinked temporary-directory paths.
- Four hosted supervisor tests use real subprocesses to exercise shutdown,
  inherited output pipes, refusal and error propagation. Their injected fencing
  checks do not establish that the production `ps` fencing works in this sandbox.

Commands (from the respective package directories, using installed tools directly):

```sh
node ../../node_modules/vitest/vitest.mjs run --exclude '**/*.integration.test.ts'
# Desktop SDK-host regression suite:
node ../../node_modules/vitest/vitest.mjs run --project node src/main/core/sdk-host --exclude '**/*.integration.test.ts'
# Both packages:
node ../../node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p tsconfig.json
# Provider package:
node ../../node_modules/tsdown/dist/run.mjs
```

Run the process/recovery suites in an environment that permits process inspection
before accepting this as ready for deployment. Unit-test success does not establish
live provider authentication, cloud deployment or GitHub mutation behavior. Claude
API-key and setup-token environment mapping is implemented but not live verified;
Antigravity's non-browser authentication route remains unresolved. See the
[provider authentication review](hosted-provider-auth-feasibility.md).
