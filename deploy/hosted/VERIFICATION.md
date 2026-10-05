# Hosted integration verification

## Console and worker integration

The current implementation adds cloud sessions to the existing Console, manual
session control, worker lifecycle actions, provider credential refresh, quotas
and automatic replacement with a retained disk.

Verification includes 361 backend tests, 367 provider tests, 36 controller tests,
25 worker tests, and 55 focused Console tests. Backend and desktop type checks
pass. All five provider executables pass startup probes in a clean Linux image.

Live Claude checks passed for manual creation, initial prompts, approval and
denial, interruption, stop/resume, session restart and worker restart. A worker
image upgrade retained conversation history and native context. Automatic VM
replacement retained the same disk and a command marker with exactly one write.
The interrupted command was not repeated. Two workers ran independently, and a
cross-worker operation update was rejected. Credential revocation denied worker
access and stopped compute; reconnect plus explicit retry restored the sessions.
Worker removal terminated compute and retained its encrypted disk.

The live checks found and corrected termination-state validation, saved-path
compatibility and an expensive controller health probe. The deployed lightweight
probe completed in under one second under the configured CPU limit.

Authenticated model requests for Codex, Cursor, OpenCode and Antigravity remain
an acceptance gate. Clean-image startup checks do not replace those account tests.
Quota concurrency and tenant isolation have database-backed coverage; live scale
verification used two workers. This is not a large-scale load test.

## Historical infrastructure checkpoint

Branch: `codex/hosted-ec2-workers`, based on committed SDK revision `522da979`.
The reviewed headless runtime foundation is included. Uncommitted SDK workspace
changes are not part of this branch.

## Implemented boundary

Operator CLI and durable controller; EC2 create/start/stop/delete; encrypted,
retained EBS; per-assignment roles and secret references; root launcher and
unprivileged runtime; retained machine/boot identity; generic Terraform and Helm;
standalone runtime artifact build and AMI installer contract.

This is not full hosted onboarding. Switch service authorization/assignment APIs,
Console creation, GitHub credential/setup flow, agent readiness reporting,
additional provider enablement and safe cross-instance recovery remain follow-up
work. One ordinary VM runs one configured Claude session. A stopped instance can
restart on its original disk; a different instance cannot adopt that disk through
this implementation.

## Local verification

- Controller: locked dependencies, 24 unit/cloud-request tests passed, Ruff, Docker build,
  nonroot identity, CLI and health-probe smoke checks.
- Worker: 16 Python unit tests passed with mocked OS/cloud effects; installer shell syntax passed.
  Tests cover credential validation/cleanup, disk inspection, boot identity and
  interrupted ownership quarantine. They do not exercise real mounts or systemd.
- TypeScript: 34 focused tests passed across hosted bootstrap, identity,
  ownership, supervisor and watcher; typecheck, package build, lint and format passed.
- Standalone bootstrap/daemon bundles built; both entrypoints loaded successfully
  and returned their expected missing-argument errors.
- Terraform formatting/validation and two mocked tests passed. Mocked `apply`
  executes no real cloud operations. Helm lint and template rendering passed.
- Broader recovery tests: 10 failed because the sandbox denies `ps` process
  inspection (`EPERM`), consistent with the previously observed environment limit.
  Focused desktop tests: 13 passed, one failed on the same restriction.
  Three SSH integration cases skipped because test credentials were unavailable.

The initial Sol review was followed by a fresh Astra medium adversarial review,
which found two P1 lifecycle defects: terminal responses were validated as live
instances, and stale stopped observations could admit deletion during startup.
Both were fixed and covered by 10 additional lifecycle regression cases. Astra's
follow-up review found no remaining actionable defects and independently passed
all 24 controller tests. Orchestration checks also reproduced both fixes and
verified legacy database migration. No live cloud acceptance is implied.

The fix binds observations to the desired revision and operation, invalidates them
on desired-state changes, and discards stale success/error writes. Accepted deletion
stops late-started compute before terminating it. Terminal identity and ownership
checks no longer require live network attachments, and confirmed termination remains
usable after EC2 stops returning the instance. Disk cleanup still requires terminal
evidence and honors the explicit retain/delete choice.

## Required before pilot acceptance

Build and inspect the real Linux AMI; verify controller IRSA and worker IAM/KMS
permissions; prove network and cross-agent isolation; run provider authentication
with test credentials; exercise write/stop/restart persistence and process cleanup;
verify GitHub work; establish worker/provider readiness; test backups and the
separate fenced replacement/recovery design. Review the actual deployment plan,
including ongoing NAT, IPv4, storage and secret charges.

No live AWS resources were created, no cluster deployment was made, and no
provider login or GitHub coding task was exercised by this checkpoint.
