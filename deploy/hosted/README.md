# Switch Cloud machines

Every new Switch Cloud machine is a box. Hosted agents v1, where a machine is
an EC2 VM the v1 hosted controller runs (`chart/`, `machine/`, `terraform/`),
is frozen: a person who already has a v1 machine keeps it, running, waking and
managed as before, and no new v1 machine is made. The rest of this section
describes boxes.

A box is a Kubernetes StatefulSet named `box` in a
namespace of its own (`agents-user-<keyed id>`) on the box cluster, one per
user whatever workspaces they use it in. It runs the standard
`switch-agent-controller`, the program a laptop or an SSH host runs agents
with, in box mode (`--box` and the image's `/etc/switch/box` marker). The user's managed agents placed on it run there, each as a Linux
user of its own. Each box keeps its agents' disk on a volume (a PVC) that
sleeping never touches.

This directory holds what runs the boxes:

- `controller/`: the hosted controller package. Its box operator makes a
  user's box from one fixed template when Core asks; its box scaler scales the
  box to match the state Core wants and reports back; its egress lists, node
  gate, placer and remover keep each box to its own network allowances,
  machines and lifetime.
- `box/image/`: the box image and the controller update image.
- `contract/`: what the deployment repository checks its cluster manifests
  against.

The box cluster's own manifests and policies live in the deployment
repository. Boxes reach Switch over its public, authenticated HTTPS API, as any
agent controller does.

## How a user gets a machine

Picking "Switch Cloud" in Switch Console claims the user's machine
(`POST /gateway/hosted-machines/ensure`) and creates a managed agent on the
machine's controller for this workspace once it has reported. Someone who
already has a live v1 machine is served by it, as before, and never gets a box.
Anyone else gets a box; on a server with no box cluster (no `provisioner_token`
in the hosted controller config, or no keyed-id key) the claim says "Hosted
agents aren't available here yet." With a warm pool (`HOSTED_POOL_SIZE`), the claim takes a box made
ahead of time; otherwise Core writes a provision action and the box operator
makes the box (`HOSTED_BOX_PROVISIONING`, capped by
`HOSTED_PROVISIONS_PER_MINUTE` and `HOSTED_BOX_CEILING`). A box is given only to
someone who presses start: neither sign-up nor sign-in claims one when a warm
pool is configured. The box scaler gives the box a one-time enrollment code from Core and starts
it; the controller enrolls with it, and its status reports are the machine's
heartbeat from then on. The machine sleeps only once every controller on it
reports no session, and its disk is retained only once no workspace has an
agent on it.

Provider logins are given to the machine on demand from Switch Console, sealed
to its controller's own key: Core relays only ciphertext.

## Enable cloud machines

Switch Console offers cloud machines on a server whose `hosted_agents` feature
flag is on. The server runs them only once it is set up as below. A server with the
flag on and nothing set up answers a claim with "This server does not support
cloud agents."

Mount a private JSON file through `HOSTED_CONTROLLER_CONFIG_PATH` with
`allowed_tenant_ids`, a dedicated `token` of at least 32 characters and the
HTTPS `agent_api_endpoint` the machines enroll against. `allowed_tenant_ids`
lists the workspaces whose members may use cloud machines, and the optional
`allowed_user_ids` the accounts within them. **With hosted agents v2 off,**
as before: `null` (or leaving `allowed_user_ids` out) means every one, and a
list means whom it names. **With hosted agents v2 on**
(`HOSTED_BOX_PROVISIONING`), `null` or a missing list admits **nobody**, and
`"*"` (alone, as `"*"` or `["*"]`) means every one: a server turning v2 on
must name its workspaces and accounts, or set `"*"`, on both lists. Core
warns at start when a list is unset, and refuses `"*"` beside other entries.
An empty list admits nobody either way. Core refuses unknown keys, the old
`tenant_id` among them.

The optional `management_tenant_ids` is separate: when set, only the listed
workspaces may use agent management at all (`/v1/management`,
`/v1/controllers` and the gateway's `/management` routes). Every other
workspace is refused with 403 `workspace_not_enabled`, its own computers
included. Left out or `null`, agent management is open to every workspace, as
before. Set it only when turning agent management on for the first time:
setting it later cuts off every unlisted workspace's existing machines. One
limit, for now: the setting lives in this hosted controller file, which also
needs `token`, `agent_api_endpoint` and `allowed_tenant_ids`. So a server that
runs agent management without cloud machines has to write a full hosted config
to set it (with `HOSTED_LAUNCH_CAPACITY` left at 0, nothing else changes).
`HOSTED_LAUNCH_CAPACITY` is how many machines may exist at once across the
server, one per user, 0–100; 0
means the server cannot run them. **With hosted agents v2 on,**
`HOSTED_LAUNCH_CAPACITY_PER_WORKSPACE` (0–100) caps the live machines serving
any one workspace under that, so one workspace can't take them all; a box
serving several workspaces counts in each. 0 means no per-workspace limit, and
Core warns at start. Choose it, with the allow-lists, before v2 serves more
than one workspace. With v2 off it's ignored. Keep it no higher than the hosted controller's
`max_machines`. The backend chart exposes
`switchCore.hostedControllerSecret` (file `controller.json`),
`switchCore.hostedLaunchCapacity`, `switchCore.hostedIdleStopMinutes` and
`switchCore.hostedDiskRetentionDays`.

Mount a secret with `gateway.json` for the hosted controller, holding `origin`,
the matching `token` and `instance_type`, and set the chart's
`gatewaySecretName` to it. `instance_type` is the type of every machine, not
only of the machines created after it is set: changing it resizes existing
machines too, each the next time it gets a new instance (a recovery, new user
data, a start after being retained, or `upgrade`), so it changes the cost and
vCPU quota of the whole fleet. A machine that only stops and starts keeps its
instance and its type. See "Operator commands" for moving a machine on purpose.
It must be one of `allowed_instance_types` in both Terraform and the controller
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

## Box eviction alerts (Kubernetes boxes)

The box scaler (`box_scaler.py`) also notices when a user's box is pushed off
its machine: a node-pressure eviction, a preemption, a taint-based eviction, a
drain or scale-down, or the machine going away (`evictions.py`). Each eviction
is alerted once, with ids and a fixed reason code only:

- one WARN line in the scaler's log;
- a Warning event `BoxPushedOff` on the user's `box` StatefulSet;
- a per-machine count in the scaler's owner-only status file;
- when `SWITCH_SCALER_REPORT_EVICTIONS=1`, the number of evictions since Core's
  last accepted observation, in the next observation (`evictions`). Core logs
  one WARN for it and stores nothing.

**Rollout order:** deploy a Core that accepts the `evictions` field **first**,
and only then set `SWITCH_SCALER_REPORT_EVICTIONS=1` on the scaler. An older
Core refuses unknown observation fields, so turning it on early would make
every observation from that box fail. The other three alerts need no setting.

The scaler's Role in each box namespace needs `events: list, create` on top of
its `pods: list`, and nothing cluster-wide.

## Operator commands

Run them in the controller pod, with the same configuration and database. They
queue desired state for the running reconciler.

```sh
switch-hosted-controller --config /etc/switch-hosted/controller.json list
switch-hosted-controller --config /etc/switch-hosted/controller.json status <machine-id>
switch-hosted-controller --config /etc/switch-hosted/controller.json stop <machine-id>
switch-hosted-controller --config /etc/switch-hosted/controller.json start <machine-id>
switch-hosted-controller --config /etc/switch-hosted/controller.json delete <machine-id> --confirm-machine-id <machine-id> --retain-volume
switch-hosted-controller --config /etc/switch-hosted/controller.json --gateway-config /etc/switch-hosted-gateway/gateway.json upgrade <machine-id> --confirm-instance-id i-0123456789abcdef0
```

Every new instance of a machine launches from the configured image, as
`gateway.json`'s `instance_type`: a relaunch for new user data, a recovery, or
a retained machine starting again moves it onto a new `image_id` and instance
type, keeping its disk. So does a stopped machine starting again: if its
instance was launched from another image or as another type, the controller
terminates it and launches a new one on the same data volume instead of
starting it. A running machine is not stopped for this; it moves at its next
start (machines stop after `HOSTED_IDLE_STOP_MINUTES` without a session). An
instance whose data volume is not yet marked to survive termination is started
as it is and moves at a later start.

To move a machine onto the configured image and type now, without waiting for
it to stop:

1. `stop` it, and wait for `status` to report `observed_state` `stopped`.
2. Terminate its instance (`instance_id` in `status`) with the EC2 API or
   console, and wait until it is terminated and the data volume is detached.
3. `upgrade` it with `--gateway-config` and the terminated `instance_id`.
   Without `--gateway-config`, `upgrade` keeps the machine's instance type.
4. `start` it. Its next instance launches on the same data volume.

On a server whose Core runs the machine, Core may ask for it to run again
while it is stopped; move it when no agent needs it.

`allowed_instance_types` may change while machines exist: add the new type,
set it in `gateway.json`, move every machine as above, and drop the old type
once `list` reports `instance_type_allowed` true for each. IAM refuses to
launch a dropped type but not to start an existing instance of one, so a
machine left unmoved keeps running it. The other placement settings
(installation, region, zone, subnet, security groups, root device and volume
sizes) are bound to the state database and cannot change. A queued command is not confirmation that
AWS has done it. Deletion needs `--confirm-machine-id` and exactly one of
`--retain-volume` or `--delete-volume`. Deleting a machine does not remove
snapshots, roles, the NAT gateway or the controller's database.

## Stop and isolate a machine

Use this to cut one machine off at once, for instance one you suspect is
compromised or misused, while keeping its data disk to look at. Its owner
cannot start it again, and neither can a message to one of its agents.

The hosted controller's own `stop` does not hold: the controller takes the
machine's desired state from Core on every poll, so the owner's Start or Retry
undoes it. What holds is moving the instance onto the isolation security group,
the Terraform `isolation_security_group_id` output, which allows no traffic
either way. The controller treats an instance with any security groups other
than the configured ones as needing attention and makes no further call on it:
it does not start, stop, terminate or replace it, whatever Core asks, and its
IAM role cannot change an instance's groups back. Core then shows the machine
as needing repair and refuses to claim it.

You need AWS credentials in the machines' account that can modify instance
attributes, stop instances and create snapshots, and `kubectl exec` into the
hosted controller and Switch Core pods. Below, `ctl` stands for
`switch-hosted-controller --config /etc/switch-hosted/controller.json` in the
controller pod and `core-admin` for `switch-cloud-machine` in a Core pod.

Use `core-admin stop` only once every Core pod runs a version that has it. A
pod still on an older version, during a rollout for instance, sees the machine
as stopped by its owner, and its Start or a new claim starts it again.

1. Find the machine. `core-admin find --owner-email <email>` lists the
   person's machine and its `machine_id`. `ctl status <machine-id>` gives its
   `instance_id` and `data_volume_id`.
2. Isolate it:

   ```sh
   aws ec2 modify-instance-attribute --instance-id <instance-id> --groups <isolation-security-group-id>
   ```

   Within one poll `ctl status` reports `observed_state` `needs_attention`
   with "instance security groups differ from immutable spec", and Core shows
   the machine in error. Its controllers stop reporting.
3. Stop it in Core, so that nobody can start it again even once its
   security group is put back: `core-admin stop <machine-id> --reason "<why>"`.
   The reason goes to the server audit log.
4. Stop the instance with EC2. A security group change does not always end
   connections already open, and a stop does:

   ```sh
   aws ec2 stop-instances --instance-ids <instance-id>
   aws ec2 wait instance-stopped --instance-ids <instance-id>
   ```

   **Never terminate it.** A terminated instance is not checked for its
   security groups, so the controller would launch a new instance on the
   same data disk, with the regular security group.
5. Snapshot the data disk. It stays attached to the stopped instance.

   ```sh
   aws ec2 create-snapshot --volume-id <data-volume-id> --description "isolated machine <machine-id>"
   ```

While the machine is isolated, leave the controller's `stop`, `start`,
`delete` and `upgrade` alone and do not detach the disk. The owner sees
"Stopped by an administrator" in Switch Console, with nothing to click, and
the machine's agents answer that an administrator stopped their device.

An installation applied before the isolation group existed gets it from the
next Terraform apply. To isolate a machine before then, create a security
group in the machines' VPC and delete the allow-all egress rule AWS adds to
every new group; check that `describe-security-group-rules` lists no rule for
it.

### Release or retire it

To give the machine back:

1. Move the instance back onto the worker security group, the Terraform
   `worker_security_group_id` output, first. The instance stays stopped.
   Released while still isolated, the machine goes back to needing repair,
   which its owner cannot clear.
2. `core-admin release <machine-id>`. It clears the error, and within one
   poll the machine is stopped as though its owner had stopped it.
3. The owner presses Start in Switch Console, which starts the same instance
   on the same disk. A message to one of its agents does not start it.

Not releasing it is safe to leave: while it is stopped by an administrator,
Core keeps its disk past any retention and starts nothing, and the snapshot
stays until you delete it.

## Machine lifecycle

When the last managed agent leaves a user's machine, its box is scaled to
zero, or a v1 machine's instance terminated, and its disk kept for
`HOSTED_DISK_RETENTION_DAYS`. A new agent in that time starts the machine again
on the kept disk; after it, the disk is deleted and the machine with it.

An idle machine is put to sleep after `HOSTED_IDLE_STOP_MINUTES`: its
controller reports no running session and nothing kept it active. A message
addressed to one of its agents wakes it, and the room is told so. A machine its
owner stopped stays stopped.

A box is never rebooted by the agent; a new box image is rolled out by the
platform. A v1 machine installs security updates every day and reboots itself
within 7 days of one that needs a reboot, a new kernel say, even while sessions
run ([machine/README.md](machine/README.md), "Security updates and reboots");
its controllers stop reporting for the minute or two the reboot takes.

| Setting | Default | Meaning |
|---|---|---|
| `HOSTED_LAUNCH_CAPACITY` | 0 | Boxes at once, at most 100. 0 disables. v1 machines are not counted. |
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
GitHub account and grant agents repositories, set up the GitHub App with
`switch-connector-apps` (see "Accounts, organizations and connector apps"),
or in the chart with
`switchCore.githubConnectionsSecret` and `switchCore.githubAppPrivateKeyPath`
([GitHub App setup](../../docs/old/github-app-setup.md)). Register
`<GATEWAY_PUBLIC_URL>/gateway/provider-connections/github/callback` as the
App's callback, with expiring user tokens. Sign-in flows live in the Switch
API process, so run it with one replica. Keep query strings out of every
access log in front of the callback: its URL carries a single-use OAuth code.

## The cluster report and box facts

Two switches on the box scaler, both off by default, for the operator's
Machines tab and its alerts. Turn each on only once Core accepts it.

- **`SWITCH_SCALER_REPORT_BOX_FACTS=1`**: each observation also carries the
  box's container restarts since Core last accepted one, and the node it runs
  on. It needs the eviction watch, and reuses the pods the watch lists. The run
  script passes `restart_counter_from_env(env)` to `box_scaler.run(box_facts=...)`.
- **`SWITCH_CLUSTER_REPORT=on`**: every 30 s the scaler posts
  `/hosted-controller/cluster`. That's each agents machine's zone, memory used
  (metrics-server) and booked (box pods' requests) as shares of allocatable,
  and its safety-check state. It also covers the listed shared services' ready
  and wanted copies. It needs `SWITCH_CLUSTER_PROXY_NAMESPACE` and
  `SWITCH_CLUSTER_OPERATOR_NAMESPACE`, and optionally
  `SWITCH_CLUSTER_OPERATOR_DEPLOYMENT` (the operator's Deployment name, by
  default `hosted-controller`) and `SWITCH_CLUSTER_DATADOG_NAMESPACE` (lists
  kube-state-metrics). The run script passes
  `cluster_watch_from_env(kube._call, core, env, box_pods=...)` to
  `box_scaler.run(cluster=...)`, where `box_pods` returns the pods the eviction
  watch listed this pass (`watch.last_pods`). Booked memory then needs no
  cluster-wide pod read.

A listed service is read from its Deployment's own `spec.replicas` and
`readyReplicas`. The autoscaler and kube-state-metrics exist only in some
clusters, so a 404 on either leaves it out of the report. A 404 on any other
service is reported as short.

The extra reads are in `placer/cluster-report-rbac.PROPOSED.yaml` in the deployment repository, for review
before they're applied. They're for the hosted controller's account
(`switch-hosted-controller` in `switch-hosted`):
- `list` on nodes, and `get` on node totals in `metrics.k8s.io`;
- `get` on each listed Deployment by name, one Role per namespace.

Nothing is written, there's no cluster-wide pod read, and there's no `list`
on Deployments.

## Accounts, organizations and connector apps

The dashboard has no pages for the platform operator. What spans the whole
deployment, rather than one organization, is done with commands in a Switch
Core pod, as `switch-cloud-machine` is, with the same configuration. Each
change goes in the server's audit log as made by a platform operator
command, with no account named. Below, `core` stands for
`kubectl exec -it <core-pod> --`; use `-i` without `-t` to pipe something
in.

- `switch-orgs list` prints every organization: its id, slug and name, its
  organization admins' e-mails, and its workspaces with their ids and how
  many people each has. It changes nothing.

  ```sh
  core switch-orgs list
  ```

- `switch-accounts` lists, creates and deletes accounts, signs one out
  everywhere, and makes one a platform operator or a regular account again.
  `create` puts the account in no workspace: it signs in to an empty start
  page until an invitation or a domain join places it. The password is read
  from standard input, or from `--password-file`, never from the command
  line; on a terminal it is asked for twice.

  ```sh
  core switch-accounts list --operators
  printf '%s' "$PASSWORD" | kubectl exec -i <core-pod> -- switch-accounts create <email> --name "<name>"
  core switch-accounts sign-out <email>
  core switch-accounts grant-operator <email>
  core switch-accounts revoke-operator <email>
  ```

  `delete` is a dry run unless given `--execute`: it shows the workspaces
  the account leaves, the organizations it stops being an admin of, and in
  each workspace its agents, devices, open chats, API keys and service
  connections, and what passes to another admin. It refuses while the
  account owns agents, devices or open chats, which only a running server
  can remove: an admin of the workspace, or the person, removes them
  first. With `--execute` you type the account's e-mail to confirm, on a
  terminal; `--yes` skips that. Either way it looks again just before
  deleting, and deletes nothing if the account has changed since it was
  shown.

  ```sh
  core switch-accounts delete <email>
  core switch-accounts delete <email> --execute
  ```

- `switch-connector-apps` sets up the apps connectors sign in through, for
  every workspace. On a deployment with one organization its admins can do
  this in the dashboard too; with several, this is the way. `set` checks the
  app with the vendor and saves it only if the vendor accepts it. Its JSON
  file, `app.json` below, holds `client_id`, the secrets the app has
  (`client_secret`, and for GitHub `private_key`) and `replace`, true to
  switch to a different app. Pipe it in rather than copying it into the
  pod. Nothing the command prints is a secret.

  ```sh
  core switch-connector-apps list
  kubectl exec -i <core-pod> -- switch-connector-apps set github --file /dev/stdin < app.json
  core switch-connector-apps remove <service>
  ```

  `set` and `remove` take effect in every Core pod at once; there is no dry
  run.

- `switch-promote-org-admin` is break-glass: it makes someone an admin of an
  organization whose admins can't, for example when none is left who can
  sign in. They must already be in one of its workspaces. It is a dry run
  unless given `--execute`, and needs `--reason`, which the organization's
  admins read in its audit log, where the change is recorded as platform
  access. They, and the person promoted, are e-mailed. An organization whose
  admins are kept in WorkOS is refused: make them an admin there.

  ```sh
  core switch-promote-org-admin <organization-id-or-slug> <email> --reason "<why>"
  core switch-promote-org-admin <organization-id-or-slug> <email> --reason "<why>" --execute
  ```
