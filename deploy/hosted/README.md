# Hosted EC2 workers: operator-controlled implementation

This directory implements the first EC2 infrastructure slice. It includes a
single-controller service, a trusted VM launcher, a Kubernetes chart and generic
Terraform. It does **not** implement Console onboarding or make the controller the
source of truth for production Switch placements. Operator commands maintain a
local durable assignment database until that service integration is implemented.

Start from [the architecture proposal](../../docs/planning/hosted-execution-backend-proposal.md).
One ordinary EC2 VM runs one assigned Claude session with a retained encrypted
EBS data disk. The controller runs on existing EKS; workers never join that cluster.

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

## Prepare a deployable environment

1. Select a dedicated test account/environment and read-only inventory its EKS
   version, OIDC issuer, StorageClass, IAM boundaries, quotas and regional capacity.
   Do not copy internal resource identifiers or secret values into this public tree.
2. Build a pinned Linux x86 AMI using the worker installer and its documented
   prerequisites. The runtime artifact must include this branch's reviewed
   bootstrap and ownership identity support; an older released runtime is insufficient.
   After installing the console workspace dependencies, build self-contained files:
   `node deploy/hosted/build-runtime.mjs /path/to/runtime-output`. Copy the two
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
