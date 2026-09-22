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

Only same-instance stop/start is supported in this slice. The worker rejects a
disk from a different instance or assignment generation. Automatic replacement,
cross-AZ migration and arbitrary retained-disk adoption remain disabled. A retained
disk can be recovered through a separately reviewed operator recovery workflow;
blind deletion of ownership locks is not that workflow.

## GitHub App credential preparation

The backend helper `switch_core.providers.github_installation` can issue a
repository-scoped installation token after checking that the initiating user's
GitHub account still has access to that repository in the selected installation.
It signs with an operator-supplied RSA key and requests only contents and pull
request write access. Credentials must stay on the backend and in the worker's
private credential transport, never in Console responses or persisted launch specs.

Console uses the shared New Agent form, saved Claude connection and a selected
GitHub repository. The gateway reserves an identity from the operator-configured
pool. The controller creates the data volume, writes the assignment secret with
that volume ID, and then starts the VM. A worker is ready only after its shared
watcher connects. Cloud creation currently requires automatic sessions; manual
cloud session control is not available.

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

This API does not yet deliver credentials into worker assignment bundles. Worker
provisioning and GitHub setup remain separate from connecting a provider.

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
Worker installation tokens and webhook handling are not part of this increment.
