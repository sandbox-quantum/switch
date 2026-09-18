# EC2 infrastructure checkpoint

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

- Controller: locked dependencies, 14 unit/cloud-request tests passed, Ruff, Docker build,
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

Independent Sol adversarial review and orchestration integration review were
used for this implementation. Astra could not be started/resumed because the
session reached its agent-thread limit; this checkpoint is not Astra-reviewed.

## Required before pilot acceptance

Build and inspect the real Linux AMI; verify controller IRSA and worker IAM/KMS
permissions; prove network and cross-agent isolation; run provider authentication
with test credentials; exercise write/stop/restart persistence and process cleanup;
verify GitHub work; establish worker/provider readiness; test backups and the
separate fenced replacement/recovery design. Review the actual deployment plan,
including ongoing NAT, IPv4, storage and secret charges.

No live AWS resources were created, no cluster deployment was made, and no
provider login or GitHub coding task was exercised by this checkpoint.
