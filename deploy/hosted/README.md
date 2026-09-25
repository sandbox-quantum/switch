# Hosted EC2 workers

This directory implements the bounded cloud-worker pilot: a controller service,
a trusted VM launcher, a Kubernetes chart and generic Terraform. Console submits
durable launch requests to the authenticated gateway. The controller consumes
those requests and maintains its own durable AWS assignment database. Operator
commands remain available for lifecycle management.

Start from [the architecture proposal](../../docs/planning/hosted-execution-backend-proposal.md).
One ordinary EC2 VM runs one agent with a retained encrypted EBS data disk.
The shared watcher starts a separate session for each addressed room on that VM.
Creating an agent does not create a room. The controller runs on existing EKS;
workers never join that cluster.

## Components

- `controller/`: Python CLI/service using boto3, SQLite durable desired/observed
  state and an exclusive reconciliation lock. Create/start/stop/delete requests
  are local operator actions, not an unauthenticated web API.
- `worker/`: root-owned AMI launcher. It validates the exact attached EBS volume,
  retrieves one scoped Secrets Manager document, prepares tmpfs credential files
  and starts the runtime as an unprivileged account. Retained boot identity prevents
  old process IDs from being treated as ownership evidence after a reboot.
- `terraform/`: a separate worker VPC, private worker subnet, NAT egress, no inbound
  worker access, restricted worker roles, and an IRSA role for the controller.
- `chart/`: a digest-pinned controller image, one replica with Recreate rollout,
  private durable database volume and no exposed application port.

Stop/start preserves the disk and saved sessions. Automatic replacement requires
confirmed termination of the old VM, a detached disk, and matching assignment
identity. The new worker accepts only that exact predecessor. Recovery attempts
are bounded. Cross-AZ migration and arbitrary disk adoption remain disabled.
See [worker image upgrades](worker/README.md) for the explicit operator workflow.

## GitHub App credential preparation

The backend helper `switch_core.providers.github_installation` can issue a
repository-scoped installation token after checking that the initiating user's
GitHub account still has access to that repository in the selected installation.
It signs with an operator-supplied RSA key and requests only contents and pull
request write access. Credentials must stay on the backend and in the worker's
private credential transport, never in Console responses or persisted launch specs.

Console uses the shared New Agent form, a saved provider connection and a selected
GitHub repository. The gateway reserves an identity from the operator-configured
pool. The controller creates the data volume, writes the assignment secret with
that volume ID, and then starts the VM. A worker is ready only after its shared
watcher connects. Agents can start sessions automatically when addressed or use
manual sessions. Both paths use the existing session form and conversation view.

Cloud sessions appear in the agent sidebar and under their connected rooms.
The conversation supports messages, permission requests, interruption, stop,
resume and restart. Worker cards provide start, stop, restart, retry and removal.
Removal retains the data disk and history. Uncertain operations are reported
explicitly and are not automatically repeated.

`HOSTED_AGENTS_PER_OWNER` limits agents per user (default 3).
`HOSTED_SESSIONS_PER_AGENT` limits sessions per worker (default 8).
`HOSTED_IDLE_STOP_MINUTES` stops an auto-session worker after that many idle
minutes (default 0, off); addressing the agent starts it again.
The server launch capacity and controller assignment pool impose separate global
limits. Each agent has its own VM, encrypted disk and scoped credentials.

Managed workers request a fresh installation token before checkout and each Git
or GitHub CLI command. The agent-authenticated renewal route checks the saved
assignment, workspace membership and current GitHub repository access. It never
accepts a caller-selected repository. Personal tokens remain an operator option.

### Enable Console launches

Mount a private backend JSON file through `HOSTED_CONTROLLER_CONFIG_PATH` with
`tenant_id`, a dedicated `token` of at least 32 characters, reserved UUID
`agent_ids`, `github_private_key_path` and the HTTPS `agent_api_endpoint`.
Set `HOSTED_LAUNCH_CAPACITY` no higher than that pool. Zero disables creation.
The backend chart exposes `switchCore.hostedControllerSecret` (files
`controller.json` and the referenced key) and `switchCore.hostedLaunchCapacity`.

Mount a controller secret with `gateway.json` containing `origin`, the matching
`token`, an allowed `instance_type`, and a pinned `mcp_runtime`. Set the controller
chart's `gatewaySecretName` to that secret. The token authorizes only the hosted
controller routes for its configured tenant. It is not a user or agent API key.
The assignment UUIDs must match the Terraform and controller configurations.
Keep all values and private keys outside this public repository.

## Prepare a deployable environment

1. Select a dedicated test account/environment and read-only inventory its EKS
   version, OIDC issuer, StorageClass, IAM boundaries, quotas and regional capacity.
   Do not copy internal resource identifiers or secret values into this public tree.
2. Build a pinned Linux x86 AMI using the worker installer and its documented
   prerequisites. The runtime artifact must include this branch's reviewed
   bootstrap and ownership identity support; an older released runtime is insufficient.
   After installing the console workspace dependencies, build self-contained files:
   `node deploy/hosted/build-runtime.mjs /path/to/runtime-output`. Copy the three
   `.mjs` files and SHA256 manifest to the worker installer's documented location;
   pin and verify those hashes as part of the AMI build.
   Validate the AMI has the configured root-device name, exactly one EBS root mapping,
   and an approved source-snapshot encryption key. This slice creates disks with
   `alias/aws/ebs`; customer-managed EBS keys need additional reviewed permissions.
   No provider credential is baked in.
3. Create a distinct assignment secret per agent outside Terraform using the worker
   secret schema. Use synthetic credentials for transport tests first. Keep the
   secret ARN stable on rotation. Reserve its ARN before provisioning, then populate
   the bundle with the controller-reported data volume ID; until those identities
   match, the worker refuses to start and retries. The model key and Switch credential are separate
   values in the bundle, scoped to that assignment.
4. Configure Terraform in the **private deployment overlay**, selecting the worker
   AMI/AZ, CIDRs, allowed instance types, controller namespace/service account and
   per-agent secret/KMS references. Review its plan before applying. The module does
   not create secret values, and workers can read only their assignment's secret.
5. Build the controller image and record its immutable digest. Put Terraform's
   worker subnet/security-group/AZ/role outputs into the controller configuration;
   root/data disk sizes must match the Terraform policy bounds. Deploy its chart
   with the controller IRSA role and a CSI-backed persistent StorageClass.
6. Test authorization with EC2 DryRun where available and exercise the bounded
   lifecycle experiment before onboarding real users. Terraform validation and
   boto3 stub tests are not evidence of successful AWS authorization.

The module deliberately provisions a new NAT gateway and public IPv4 allocation.
Their charges continue when agents are stopped; they must be included in the
reviewed plan and removed with the test network when no longer needed. This is
not a reuse of a developer VM's network or IAM role.

Workers require a publicly reachable, authenticated HTTPS Switch API, GitHub HTTPS,
model-provider APIs and package registries. They cannot reach a Kubernetes-only
Service or private control-plane database. There is no peering, SSH ingress,
Git-over-SSH egress, host Docker socket or blanket sudo for repository scripts.
The dedicated network blocks RFC1918 outbound traffic, but VPC NACLs do not block
IMDS or the AWS DNS resolver. Treat access to the assignment's instance role as
possible for code in that assignment, and grant it no infrastructure authority.
DNS/private-address access and any organization-specific address ranges still
require live isolation tests. Workloads requiring other ports need a reviewed
supported-environment change.

## Controller configuration

The chart accepts a non-secret `controllerConfig` map with:

- `installation_id`, `region`, `availability_zone`, `subnet_id`, `security_group_ids`
- `image_id`, `root_device_name`, `allowed_instance_types`, `max_agents`
- `root_volume_gib`, `data_volume_gib`, `poll_interval_seconds`
- `worker_assignments`: agent ID to `{instance_profile_arn, assignment_secret_arn}`

The chart fixes `state_db_path` and `lock_path` on the same retained PVC. A standalone
operator installation must supply absolute paths for both. Keep the database and
assignment configuration private and backed up. Do not run two installations
against separate databases with the same cloud installation ID. Do not manually
scale the Deployment or bypass its reconciliation lock. Startup/readiness/liveness
probes check a local progress timestamp, not cloud or provider readiness; handled
AWS failures remain visible in assignment status without causing restart loops.

Before a standalone controller upgrade, stop the old reconciler and back up its
SQLite database. The Helm chart uses Recreate so the old pod stops before the new
one starts. The observation-schema upgrade preserves assignment and cloud resource
identities, but old observations must be refreshed before they can authorize deletion.
Do not run an older controller binary against the upgraded database.

The controller is trusted to provision all configured assignments. Its IAM role
can pass the configured worker roles; IAM is not a substitute for the controller's
agent-to-role binding checks. Audit secret resource policies and KMS key policies
as well as the supplied identity policies; an external broad resource policy can
invalidate the intended cross-agent denial.

## Operator commands

Install the controller with its locked dependencies, then supply an absolute path
to the private controller JSON. In Kubernetes, run state commands inside the
controller pod using the same config and database; they queue desired state for
the resident reconciler.

```sh
switch-hosted-controller --config /etc/switch-hosted/controller.json create example-agent --instance-type m7i.large
switch-hosted-controller --config /etc/switch-hosted/controller.json status example-agent
switch-hosted-controller --config /etc/switch-hosted/controller.json stop example-agent
switch-hosted-controller --config /etc/switch-hosted/controller.json start example-agent
```

For standalone reconciliation:

```sh
switch-hosted-controller --config /etc/switch-hosted/controller.json reconcile-once
switch-hosted-controller --config /etc/switch-hosted/controller.json serve
```

A queued command is not confirmation that AWS has completed it. Desired-state
changes invalidate prior observations; stopped evidence must belong to the current
operation before deletion is accepted. A delayed response from an older operation
cannot certify a newer one. After deletion is accepted, a late-started instance is
stopped and terminated before disk cleanup proceeds. `Running` describes
the infrastructure, not provider authentication/readiness. Inspect worker service
status and Switch session state before calling the coding agent ready. Stop/start
retains disk contents and native state; it does not promise to resume an interrupted
provider action or automatically replay a room message.

Deletion requires a matching confirmation ID and an explicit retain/delete-volume
choice; consult `delete --help` and the controller's documented stop precondition.
Retaining a disk retains its charges and sensitive state. Deleting compute/disk
through this controller does not remove Secrets Manager documents, snapshots, IAM
roles, NAT gateways or the controller's own database. Their lifecycle remains the
private deployment workflow's responsibility.

See [the implementation verification record](VERIFICATION.md) for local results and
remaining acceptance gates.

## Verification and rollout boundary

Local checks cover state transitions/retries, cloud request shapes, ownership,
credential transport, retained boot state and infrastructure rendering. All live
AWS/AMI, block-device, IAM/KMS, network, provider-authentication and end-to-end
GitHub gates remain mandatory before deployment acceptance. A generated chart or
an EC2 instance in `running` state alone proves none of those gates.

The controller PVC is annotated `keep` so Helm uninstall retains it. That is not a
backup and does not override the underlying StorageClass/PV reclaim policy. Back
up the assignment database and retain resource identities before uninstalling; a
fresh empty database must not be used to guess ownership of existing workers.

### GitHub authentication slice

The optional worker secret fields described in [the worker contract](worker/README.md#optional-github-credential-delivery)
provide a personal GitHub.com token to Git HTTPS and GitHub CLI without storing
it in a workspace/config or passing it as a command argument. Bootstrap checks
the token before starting the provider. Repository permission checks and actual
clone/build/push/PR operations remain the coding task's responsibility; managed onboarding uses the renewable installation-token flow described above.

## User-owned Claude connections

The gateway exposes authenticated `GET`, `PUT`, and `DELETE` routes at
`/gateway/provider-connections/claude`. The PUT body has `kind` (`api-key` or
`setup-token`) and `credential`. GET returns connection status, kind and the last
successful verification time, never the credential. Operations are scoped to the
signed-in user's tenant and user ID; administrator status does not grant access
to another user's connection. Concurrent changes to the same connection return
409 so deletion and verification cannot race.

The verifier is opt-in. Build the ordinary switch-core image from this checkout,
then build the Linux amd64 hosted variant:

```sh
docker build --platform linux/amd64 -f deploy/hosted/Dockerfile.connections \
  --build-arg SWITCH_CORE_IMAGE=your-built-core-image \
  -t switch-core-with-claude .
```

Pin the base image by digest for deployment. The variant includes a checksum-pinned
Claude Code executable and sets `HOSTED_CLAUDE_VERIFIER_PATH`. A non-container
installation can set that variable to an absolute executable path. An invalid
configured path fails startup; an unset path leaves connections unavailable.
Run the normal database migration before rolling out the backend.

Each check uses a temporary private home and a minimal environment with only the
chosen credential. It runs one fixed Haiku request with tools, MCP servers, skills
and session persistence disabled. It accepts only a successful Claude result.
Checks time out after 25 seconds, process groups are killed on exit/cancellation,
and temporary files are removed. There are at most two checks per gateway process.
The verification process runs as the service user and accepts no user prompts,
commands, repository paths or tool configuration; it is not a worker sandbox.

Only verified credentials are written, using the existing server encryption key
and the tenant-scoped `provider_connections` table. Failed replacement leaves the
previous connection intact. Back up and rotate the server encryption key with the
same care as other encrypted credentials. Removal deletes the database record;
revocation at Anthropic and database-backup retention are separate concerns.

Worker assignment bundles contain no provider credential. Managed runtimes fetch
current credentials from the authenticated worker
API. Revocation denies further credential and control requests and stops the
affected workers. Reconnect the provider, then use Retry to start them again.

Codex, Cursor, OpenCode and Antigravity use the same owner-scoped connection API
under their provider IDs. Enable `HOSTED_PROVIDER_VERIFICATION_ENABLED` (Helm:
`switchCore.hostedProviderVerificationEnabled`) after deploying the verification
API, controller IAM policy, and a worker image with `--verify-credential` support.
This requires a hosted controller. With the setting off, credentials keep the
existing configured-until-worker-check behavior.

With verification enabled, saving a credential queues a durable connection check.
Console polls its status and shows **Checking connection**. A temporary worker
uses the native provider adapter to send one fixed model request in an empty
workspace. It has no repository, agent assignment, instance profile, or retained
data volume. Its encrypted root volume is deleted on termination. The controller
allows at most two checks at a time. Each worker schedules its own shutdown after
eight minutes; the controller also terminates checks past their ten-minute deadline.
Checks and cleanup continue when Console closes.

The connection becomes verified only after the model replies and the controller
observes instance termination. Refreshed subscription credentials are saved with
the result. Failed checks preserve an existing verified credential and show a retry
action. Job credentials and bootstrap tokens are cleared when the job finishes.
Test each provider with its intended account before deployment acceptance.

### GitHub App connections

To enable browser authorization, set `HOSTED_GITHUB_CONFIG_PATH` to a private JSON
file containing `client_id`, `client_secret`, `slug`, and the public HTTPS Switch
`origin`. In the backend Helm chart, `switchCore.githubConnectionsSecret` mounts
an existing Secret's `github.json` key. Never put the client secret in image layers
or Console build configuration.

Register `<origin>/gateway/provider-connections/github/callback` as the GitHub App
callback. Enable expiring user tokens. Contents and pull requests need read/write
permissions for the planned coding workflow; metadata read access is mandatory.
The Console requests user authorization, confirms the account, and offers GitHub
App installation to select repositories. Organization approval may be required.

Stored credentials are encrypted and scoped to the current user and tenant.
The backend refreshes expiring user tokens and asks GitHub for current repository
access. Disconnect deletes local connection storage, not the installation on
GitHub. Authorization attempts expire after ten minutes and on backend restart.
Workers receive repository-scoped installation tokens. GitHub uninstall and suspend
webhooks are not implemented; access is checked again when tokens are issued.

### Removed worker retention

Removing a stopped worker revokes its Switch API key, removes its agent and room
memberships, and frees the agent name. Server-side sessions are removed with the
agent. The worker data disk remains available for administrator recovery.

A removed worker keeps its pool identity reserved. Do not assign that identity or
its retained disk to a new owner. To add capacity, create a new worker assignment
with a new identity and fresh disk. Automatic identity recycling is not supported.

### GitHub sign-in availability

Run the Switch API (`switchCore`) with one replica. The shipped Helm chart pins
`switchCore.replicaCount` to `1` and rejects other values. GitHub sign-in flows
live in that process alongside the live agent state. A restart interrupts an
unconfirmed sign-in; start it again from Switch Console. Multiple API replicas
require shared flow storage before they can be supported.

### GitHub credential revocation

Repository tokens are encrypted and bound to the workspace, owner, worker, and
worker revision. Stop, removal, disconnect, relink, and owner removal queue their
revocation after the access change commits. A bounded batch retries failed
revocations on each controller poll; expired records are deleted. Disconnect and
relink revoke only the old OAuth token, not the user's entire GitHub App grant.
A failed revoke shows a warning and does not undo the access change.

Tokens minted before token tracking was deployed, or minted just before a lost
response or request cancellation, can remain valid until expiry (up to one hour for repository
tokens). Stored tokens use the same encryption key as other provider credentials;
separate encryption keys and key rotation remain a follow-up.

Keep query strings out of access logs on every proxy in front of the GitHub
callback. Its URL carries a single-use OAuth code in the query on
`/gateway/provider-connections/github/callback`. Exclude this path if you later
enable ALB access logs or WAF request logging.
The API strips query strings from access logs, and the shipped nginx gateway
disables access logging for that path. An external ingress, load balancer, WAF,
or CDN needs the same protection before GitHub sign-in is enabled.

Worker cards show general provider and GitHub recovery guidance for setup failures.
They do not yet distinguish each GitHub access failure, such as missing write
permission or a missing App installation.

The controller uses an attached managed policy for assignment secret access.
The deploy identity needs IAM policy create, version, attach, detach, and delete
permissions for that policy. The pool is limited by AWS policy size: 6,144
characters for assignment access and 10,240 for inline controller permissions.
Terraform checks these limits during planning. The supported assignment count
depends on ARN lengths; use a smaller pool if a size check fails.

The loopback callback URL can remain in browser history. Its authorization code
is single-use, consumed during sign-in, and bound to the flow's PKCE verifier.
