# Switch cloud machines on EC2

A Switch cloud machine is an EC2 VM, one per user whatever workspaces they
use it in, that runs the standard `switch-agent-controller`, the program a
laptop or an SSH host runs agents with, once per workspace. The user's managed
agents placed on it run there, each as a Linux user of its own. Each machine
has a retained, encrypted EBS data disk.

This directory holds what runs the machines:

- `controller/`: the hosted controller, a Python service on the existing EKS
  cluster that creates, starts, stops and deletes the VMs and their disks. It
  keeps desired and observed state in SQLite, behind an exclusive
  reconciliation lock. Operator commands queue desired state for it; it exposes
  no web API.
- `machine/`: the machine image and its boot. See [its README](machine/README.md)
  for how a machine enrolls its controller and starts.
- `terraform/`: a separate VPC, a private subnet with NAT egress and no inbound
  access, the machines' one instance role, which holds no permissions, and an
  IRSA role for the hosted controller.
- `chart/`: the hosted controller's chart: a digest-pinned image, one replica
  with a Recreate rollout, a private retained volume for its database, and no
  exposed port.

Machines never join the cluster. They reach Switch over its public,
authenticated HTTPS API, as any agents controller does.

## How a user gets a machine

Picking "Switch cloud" in Switch Console claims the user's machine
(`POST /gateway/hosted-machines/ensure`), or joins it from this workspace when
the user already has one, and creates a managed agent on the machine's
controller for this workspace once it has reported. A machine serves up to 8
workspaces. Self sign-up claims one too, so it warms
while the user signs in. The hosted controller polls Core for the machines that
should exist, creates the data volume, and launches the VM with a bundle as its
user data. The machine runs one agents controller per workspace seated on it,
and the bundle (version 5) lists them in Core's order, each under its seat key
with either the controller it enrolled as or a one-time enrollment code. The
machine enrolls each controller with its code, and their status reports are
its heartbeat from then on. The machine sleeps only once every controller on it reports no session,
and its disk is retained only once no workspace has an agent on it. An
instance's user data is set when it launches:
when a controller must enroll again or a workspace joins the machine, the hosted controller stops the instance if it is running, terminates
it and launches a new one with the new bundle, on the same data volume. A
bundle that only names the controllers enrolled with the codes the instance
already holds does not replace the instance.

Provider logins are given to the machine on demand from Switch Console, sealed
to its controller's own key: Core relays only ciphertext.

## Enable cloud machines

Core needs agent management (`AGENT_MANAGEMENT_ENABLED`, with
`CONTROLLER_TOKEN_SECRET`): it refuses to start with `HOSTED_LAUNCH_CAPACITY`
above 0 without it.

Mount a private JSON file through `HOSTED_CONTROLLER_CONFIG_PATH` with
`allowed_tenant_ids`, a dedicated `token` of at least 32 characters and the
HTTPS `agent_api_endpoint` the machines enroll against. `allowed_tenant_ids`
lists the workspaces whose members may use cloud machines, or is `null` for
every workspace. Core refuses unknown keys, the old `tenant_id` among them.
`HOSTED_LAUNCH_CAPACITY` is how many machines may exist at once across the
server, one per user, 0–100; 0
disables cloud machines. Keep it no higher than the hosted controller's
`max_machines`. The backend chart exposes
`switchCore.hostedControllerSecret` (file `controller.json`),
`switchCore.hostedLaunchCapacity`, `switchCore.hostedIdleStopMinutes` and
`switchCore.hostedDiskRetentionDays`.

Mount a secret with `gateway.json` for the hosted controller, holding `origin`,
the matching `token` and `instance_type`, and set the chart's
`gatewaySecretName` to it. `instance_type` is used for every new machine and
must be one of `allowed_instance_types` in both Terraform and the controller
configuration; `c7i.2xlarge` is recommended. The token authorizes only the
hosted controller routes, for every machine on the server: their lifecycle
and the controllers they run, never a workspace's agents, rooms or logins. It
is not a user or agent API key.

Keep every value and key out of this public repository.

## Prepare an environment

1. Select a dedicated account and inventory its EKS version, OIDC issuer,
   StorageClass, IAM boundaries, quotas and regional capacity.
2. Bake the machine image as [machine/README.md](machine/README.md) describes.
   It must have the configured root device name and exactly one EBS root
   mapping. Disks are created with `alias/aws/ebs`.
3. Configure Terraform in the private deployment overlay: the image, AZ,
   CIDRs, allowed instance types, and the controller's namespace and service
   account. Review the plan before applying.
4. Build the hosted controller image and record its digest. Put Terraform's
   subnet, security group, AZ and `machine_instance_profile_arn` outputs into
   the controller configuration, and deploy the chart with its IRSA role and a
   CSI-backed StorageClass.

The network has its own NAT gateway and public IPv4 address, which cost money
while machines are stopped too. Machines need the Switch API, the model
providers' APIs and the package registries. There is no peering, no SSH
ingress and no Docker socket. VPC NACLs block RFC1918 egress but not IMDS or the
AWS resolver: agents cannot reach instance metadata (their units deny it), but
grant the instance role no authority anyway. The boot reads the machine's
bundle from instance metadata as root. Anyone in the AWS account who can read
an instance's user data can read its enrollment codes, each spent at the boot
that enrolls its controller and expiring after 30 minutes.

## Controller configuration

The chart takes a non-secret `controllerConfig` map:

- `installation_id`, `region`, `availability_zone`, `subnet_id`, `security_group_ids`
- `image_id`, `root_device_name`, `allowed_instance_types`
- `max_machines`: 1–100. It caps both the machines not deleted and the
  running instances.
- `root_volume_gib`, `data_volume_gib`, `poll_interval_seconds`
- `instance_profile_arn`: the machines' instance profile, the Terraform
  `machine_instance_profile_arn` output. An instance that runs with another
  profile needs attention, so do not change it while machines exist.

The chart fixes `state_db_path` and `lock_path` on its retained volume; a
standalone installation must give absolute paths for both. Back up the database.
Never run two installations with the same installation ID, scale the
Deployment, or bypass the lock. The probes check a local progress timestamp, not
cloud or provider readiness.

The hosted controller may change only the data retention of the instances it
tagged as its own, never their user data or security groups.

## Operator commands

Run them in the controller pod, with the same configuration and database. They
queue desired state for the running reconciler.

```sh
switch-hosted-controller --config /etc/switch-hosted/controller.json list
switch-hosted-controller --config /etc/switch-hosted/controller.json status <machine-id>
switch-hosted-controller --config /etc/switch-hosted/controller.json stop <machine-id>
switch-hosted-controller --config /etc/switch-hosted/controller.json start <machine-id>
switch-hosted-controller --config /etc/switch-hosted/controller.json delete <machine-id> --confirm-machine-id <machine-id> --retain-volume
switch-hosted-controller --config /etc/switch-hosted/controller.json upgrade <machine-id> --confirm-instance-id i-0123456789abcdef0
```

Every new instance of a machine launches from the configured image: a
relaunch for new user data, a recovery, or a retained machine starting again
moves it onto a new `image_id`, keeping its disk. `upgrade` does it for a
stopped machine whose instance is terminated. A queued command is not confirmation that
AWS has done it. Deletion needs `--confirm-machine-id` and exactly one of
`--retain-volume` or `--delete-volume`. Deleting a machine does not remove
snapshots, roles, the NAT gateway or the controller's database.

## Machine lifecycle

When the last managed agent leaves a user's machine, its instance is
terminated and its disk kept for `HOSTED_DISK_RETENTION_DAYS`. A new agent in
that time starts the machine again on the kept disk; after it, the disk is
deleted and the machine with it.

An idle machine is put to sleep after `HOSTED_IDLE_STOP_MINUTES`: its
controller reports no running session and nothing kept it active. A message
addressed to one of its agents wakes it, and the room is told so. A machine its
owner stopped stays stopped.

| Setting | Default | Meaning |
|---|---|---|
| `HOSTED_LAUNCH_CAPACITY` | 0 | Machines at once, at most 100. 0 disables. |
| `HOSTED_IDLE_STOP_MINUTES` | 30 | Idle minutes before a machine sleeps. 0 disables. At most 1440. |
| `HOSTED_DISK_RETENTION_DAYS` | 7 | Days a disk is kept after its last agent leaves. 1–90. |

A machine that does not start, or whose controller does not report, within 10
minutes goes to error. Use Retry in Switch Console.

## Moving to one machine per user

A machine used to belong to one workspace. It now belongs to its owner and
runs a controller per workspace. To upgrade:

1. Bake an image from this `machine/`, which reads bundle version 5, set it as
   `image_id`, and deploy it before or with the new hosted controller: a
   running machine on an older image is relaunched from the new one at its
   next revision.
2. Replace `tenant_id` in `controller.json` with `allowed_tenant_ids`: the
   old workspace's id in a list to keep cloud machines to it, or `null`.
3. Upgrade Core. Each machine keeps its id, its controller and its agents.
   The migration refuses to run while one user has machines that are not
   deleted in two workspaces.

## Moving off machine slots

Machines used to borrow one of a fixed pool of slots, each an IAM role and an
assignment secret the machine read its bundle from at boot. A machine placed on
a slot cannot move off it: its image reads the slot's secret, which is gone.
Before upgrading an installation that has cloud machines:

1. Remove every cloud agent in Switch Console and wait until Core shows no
   cloud machine, or remove the machines in Core directly.
2. Terminate their instances and delete their data disks.
3. Delete the hosted controller's state database, or let it start: it forgets
   a slot-era database whose machines are all deleted, and refuses one that
   still has a live machine.
4. Apply Terraform, which removes the slots' roles, and delete the slots'
   assignment secrets and their KMS key yourself.
5. Bake an image from this `machine/` and set it as `image_id`.

## GitHub connections

GitHub connections are not part of cloud machines. To let users link their
GitHub account, set `HOSTED_GITHUB_CONFIG_PATH` to a private JSON file with
`client_id`, `client_secret`, `slug` and the public HTTPS Switch `origin`
(chart: `switchCore.githubConnectionsSecret`, key `github.json`), and register
`<origin>/gateway/provider-connections/github/callback` as the GitHub App
callback with expiring user tokens. Sign-in flows live in the Switch API
process, so run it with one replica. Keep query strings out of every access
log in front of the callback: its URL carries a single-use OAuth code.
