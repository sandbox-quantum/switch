# Switch cloud machines on EC2

A Switch cloud machine is an EC2 VM, one per user, that runs the standard
`switch-agent-controller`: the program a laptop or an SSH host runs agents
with. The user's managed agents placed on it run there, each as a Linux user
of its own. Each machine has a retained, encrypted EBS data disk and uses one
slot of the operator's pool.

This directory holds what runs the machines:

- `controller/`: the hosted controller, a Python service on the existing EKS
  cluster that creates, starts, stops and deletes the VMs and their disks. It
  keeps desired and observed state in SQLite, behind an exclusive
  reconciliation lock. Operator commands queue desired state for it; it exposes
  no web API.
- `machine/`: the machine image and its boot. See [its README](machine/README.md)
  for how a machine enrolls its controller and starts.
- `terraform/`: a separate VPC, a private subnet with NAT egress and no inbound
  access, the machines' roles, and an IRSA role for the hosted controller.
- `chart/`: the hosted controller's chart: a digest-pinned image, one replica
  with a Recreate rollout, a private retained volume for its database, and no
  exposed port.

Machines never join the cluster. They reach Switch over its public,
authenticated HTTPS API, as any agents controller does.

## How a user gets a machine

Picking "Switch cloud" in Switch Console claims the user's machine
(`POST /gateway/hosted-machines/ensure`) and creates a managed agent on its
controller once the machine is ready. Self sign-up claims one too, so it warms
while the user signs in. The hosted controller polls Core for the machines that
should exist, creates the data volume, writes the slot's assignment secret
with a bundle that carries a one-time enrollment code, and launches the VM. The
machine enrolls its controller with that code, and its status reports are its
heartbeat from then on.

Provider logins are given to the machine on demand from Switch Console, sealed
to its controller's own key: Core relays only ciphertext.

## Enable cloud machines

Core needs agent management (`AGENT_MANAGEMENT_ENABLED`, with
`CONTROLLER_TOKEN_SECRET`): it refuses to start with `HOSTED_LAUNCH_CAPACITY`
above 0 without it.

Mount a private JSON file through `HOSTED_CONTROLLER_CONFIG_PATH` with
`tenant_id`, a dedicated `token` of at least 32 characters, `machine_slots` and
the HTTPS `agent_api_endpoint` the machines enroll against. `machine_slots` is a
list of 1–100 unique slot IDs, the keys of the Terraform `machine_slots`
variable. Core refuses unknown keys. Set `HOSTED_LAUNCH_CAPACITY` no higher than
the number of slots; 0 disables cloud machines. The backend chart exposes
`switchCore.hostedControllerSecret` (file `controller.json`),
`switchCore.hostedLaunchCapacity`, `switchCore.hostedIdleStopMinutes` and
`switchCore.hostedDiskRetentionDays`.

Mount a secret with `gateway.json` for the hosted controller, holding `origin`,
the matching `token` and `instance_type`, and set the chart's
`gatewaySecretName` to it. `instance_type` is used for every new machine and
must be one of `allowed_instance_types` in both Terraform and the controller
configuration; `c7i.2xlarge` is recommended. The token authorizes only the
hosted controller routes for its tenant. It is not a user or agent API key.

Only the configured tenant may claim machines. Keep every value and key out of
this public repository.

## Prepare an environment

1. Select a dedicated account and inventory its EKS version, OIDC issuer,
   StorageClass, IAM boundaries, quotas and regional capacity.
2. Bake the machine image as [machine/README.md](machine/README.md) describes.
   It must have the configured root device name and exactly one EBS root
   mapping. Disks are created with `alias/aws/ebs`.
3. Create one assignment secret per machine slot, outside Terraform, with no
   value. The hosted controller writes the bundle itself; it never holds a
   long-lived credential.
4. Configure Terraform in the private deployment overlay: the image, AZ,
   CIDRs, allowed instance types, the controller's namespace and service account,
   and each slot's secret in `machine_slots`. Review the plan before applying.
   Each machine can read only its own slot's secret.
5. Build the hosted controller image and record its digest. Put Terraform's
   subnet, security group, AZ and `machine_slots` outputs into the controller
   configuration, and deploy the chart with its IRSA role and a CSI-backed
   StorageClass.

The network has its own NAT gateway and public IPv4 address, which cost money
while machines are stopped too. Machines need the Switch API, the model
providers' APIs and the package registries. There is no peering, no SSH
ingress and no Docker socket. VPC NACLs block RFC1918 egress but not IMDS or the
AWS resolver: agents cannot reach instance metadata (their units deny it), but
grant the instance role no infrastructure authority anyway.

## Controller configuration

The chart takes a non-secret `controllerConfig` map:

- `installation_id`, `region`, `availability_zone`, `subnet_id`, `security_group_ids`
- `image_id`, `root_device_name`, `allowed_instance_types`
- `max_machines`: 1–100, no more than the number of slots. It caps both the
  machines not deleted and the running instances.
- `root_volume_gib`, `data_volume_gib`, `poll_interval_seconds`
- `machine_slots`: slot ID to `{instance_profile_arn, assignment_secret_arn}`,
  from the Terraform output.

The chart fixes `state_db_path` and `lock_path` on its retained volume; a
standalone installation must give absolute paths for both. Back up the database.
Never run two installations with the same installation ID, scale the
Deployment, or bypass the lock. The probes check a local progress timestamp, not
cloud or provider readiness.

The hosted controller may provision every configured slot. Audit the secrets'
resource policies as well as the identity policies: a broad resource policy can
undo the separation between machines.

## Operator commands

Run them in the controller pod, with the same configuration and database. They
queue desired state for the running reconciler.

```sh
switch-hosted-controller --config /etc/switch-hosted/controller.json create example-slot --instance-type c7i.2xlarge
switch-hosted-controller --config /etc/switch-hosted/controller.json status example-slot
switch-hosted-controller --config /etc/switch-hosted/controller.json stop example-slot
switch-hosted-controller --config /etc/switch-hosted/controller.json start example-slot
switch-hosted-controller --config /etc/switch-hosted/controller.json delete example-slot --confirm-slot-id example-slot --retain-volume
switch-hosted-controller --config /etc/switch-hosted/controller.json upgrade example-slot --confirm-instance-id i-0123456789abcdef0
switch-hosted-controller --config /etc/switch-hosted/controller.json list
```

`upgrade` moves a stopped machine whose instance is terminated onto the
configured image, keeping its disk. A queued command is not confirmation that
AWS has done it. Deletion needs `--confirm-slot-id` and exactly one of
`--retain-volume` or `--delete-volume`. Deleting a machine does not remove
secrets, snapshots, roles, the NAT gateway or the controller's database.

## Machine lifecycle

When the last managed agent leaves a user's machine, its instance is
terminated and its disk kept for `HOSTED_DISK_RETENTION_DAYS`. A new agent in
that time starts the machine again on the kept disk; after it, the disk is
deleted and the slot returns to the pool with a new generation.

An idle machine is put to sleep after `HOSTED_IDLE_STOP_MINUTES`: its
controller reports no running session and nothing kept it active. A message
addressed to one of its agents wakes it, and the room is told so. A machine its
owner stopped stays stopped.

| Setting | Default | Meaning |
|---|---|---|
| `HOSTED_LAUNCH_CAPACITY` | 0 | Machines at once. No more than the slots. 0 disables. |
| `HOSTED_IDLE_STOP_MINUTES` | 30 | Idle minutes before a machine sleeps. 0 disables. At most 1440. |
| `HOSTED_DISK_RETENTION_DAYS` | 7 | Days a disk is kept after its last agent leaves. 1–90. |

A machine that does not start, or whose controller does not report, within 10
minutes goes to error. Use Retry in Switch Console.

## GitHub connections

GitHub connections are not part of cloud machines. To let users link their
GitHub account, set `HOSTED_GITHUB_CONFIG_PATH` to a private JSON file with
`client_id`, `client_secret`, `slug` and the public HTTPS Switch `origin`
(chart: `switchCore.githubConnectionsSecret`, key `github.json`), and register
`<origin>/gateway/provider-connections/github/callback` as the GitHub App
callback with expiring user tokens. Sign-in flows live in the Switch API
process, so run it with one replica. Keep query strings out of every access
log in front of the callback: its URL carries a single-use OAuth code.
