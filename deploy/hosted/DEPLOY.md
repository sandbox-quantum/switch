# Hosted agents v2: deploying it

The order of steps to put hosted agents v2 on a cluster, once the cluster's platform team has set up the box side.
What each part is and does is in `README.md` and `k8s/README.md`; the Helm values are in
`../remote/helm/switch/README.md` ("Hosted agents v2").

## What has to come back from the platform team first

These can't be done from the repo. Each later step names the one it waits on. **Secrets, tokens and the filled
cluster files never go in git or in chat.**

1. **The gVisor node group**, labelled `switch.dev/pool=agents`, with the `runsc` containerd runtime registered,
   IMDSv2 required with a hop limit of 1. (`runsc-tuned` and the `gvisor-tuned` RuntimeClass are optional; nothing
   uses them.)
2. **The zones** boxes may run in.
3. **Addresses:** the Switch server's private address that boxes reach over HTTPS, the cluster API server's two
   private endpoint addresses, and the agents node subnets (one per zone).
4. **The CA certificate** that signs the server's certificate (its public CA, if it's publicly trusted). Boxes
   always verify it.
5. **A container registry** the box nodes pull from, with push access for whoever builds the images.
6. **Secrets, made in the cluster and the secret store, never sent over chat:**
   - in `switch-hosted`: `switch-hosted-provisioner-core` (`token`), `switch-hosted-controller-core` (`token`),
     `switch-operator-actions-bearer` (`bearer`), and `box-map`, created empty;
   - in the Switch server's namespace: three Secrets, their names given to the chart as
     `hostedControllerSecret`, `visibilityKeyedIdKeySecret` and `visibilityOperatorsSecret`, holding the keys
     `controller.json` (the hosted controller config), `keyed-id.key` and `operators.json` (the operator list). The three tokens in `controller.json` equal the
     three token Secrets above.
   - **Who gives what:** platform generates the three tokens and the keyed-id key. We give them the operator user
     ids for `operators.json`, and `controller.json`'s `allowed_tenant_ids` and `agent_api_endpoint`.
7. **The cluster's `kubernetes` Service address** (`kubectl get svc kubernetes -n default`), which the cluster
   services' NetworkPolicies allow.

## Our steps

### 1. Build and push the images (waits on 5)

```sh
DRY_RUN=1 deploy/hosted/build-push-images.sh <registry>/<path> <tag>   # shows what it will run
deploy/hosted/build-push-images.sh <registry>/<path> <tag>
```

It builds the box image (`box/image/build.sh --from-source`) and the hosted controller image
(`controller/Dockerfile`) from a clean checkout of this branch, pushes both, and prints their digests for the next
step. Log in to the registry first (it holds no credentials), use a dated tag (it refuses `latest`), and build on
the same architecture as the gVisor nodes. Note the pause image's digest from the registry you use for it.

### 2. Fill the cluster files (waits on 2, 3, 4, 7 and step 1)

```sh
deploy/hosted/fill-placeholders.py --out <new folder> \
  --server-ip <ip> --api-server-ip <ip> --api-server-ip <ip> \
  --agents-subnet <cidr> [--agents-subnet <cidr> ...] --zone <zone> [--zone <zone> ...] \
  --box-image <repo@sha256:...> \
  --controller-image <repo@sha256:...> --pause-image <repo@sha256:...> \
  --kubernetes-service-ip <ip> --ca-cert <file.pem> --daily-calls <n>
```

`--daily-calls` is every box's daily **ceiling** on AI calls through its gateway. A box enforces the lower of this
ceiling and its workspace's daily AI budget (set in the dashboard), so a budget above the ceiling is held to it: set
`--daily-calls` at or above the largest workspace budget you want honoured. A workspace with no budget set gets the
ceiling in full, so choose a number you'd be content to see any one box spend in a day, not a large placeholder. Each
box counts its own calls, one box per person. It's required and finite, and the provisioner refuses to start without it. A box made before a change keeps
the ceiling it was made with, as it keeps its image, until it's updated.

**Upgrading a cluster that already runs v2:** add `--daily-calls` (it becomes `"daily_calls"` in
`switch-box-operator-config`) and apply the filled files **before** rolling the new hosted controller image. The new
provisioner refuses to start with a config that has no `daily_calls`, so no new boxes are made until it's set.

**A box made before this version has no per-box cap until it's recreated.** Such boxes keep working and are re-used
as before (the provisioner logs a warning naming each one it re-uses in the older shape), but the provisioner may
create a box's StatefulSet, not change it, so the cap reaches a box only when the box is made again. Bringing old
boxes up to date in place is a later change, with the admission policy extended to cover it.

**Changing `daily_calls` reaches only new or recreated boxes.** An existing box keeps the cap it was made with (the
provisioner logs the difference when it re-uses one). So **lowering** it, say to stop abuse, does not cut existing
boxes' caps: an urgent cut needs those boxes recreated, or the workspace's daily AI budget lowered in Core, since
the box enforces the lower of the two.

**A box made by a build older than this provisioner's reviewed template (the old all-in-one builds) can't be
re-used and must be recreated**, as was already true before the cap: only today's template and the shapes it lists
as earlier (`_earlier_templates`) count as a box's own.

It writes filled copies of `k8s/*.yaml`, `box/priorityclass-switch-box.yaml` and
`egress/egress-proxy-networkpolicy.yaml` into the new folder, and refuses, writing nothing, if a value is malformed
or any placeholder would be left. The folder must be outside this repo, so a filled copy is never committed, and
the repo's files don't change. It also sets admission policy P4's zone pattern to the given zones, and the
cluster's `kubernetes` Service address in the NetworkPolicies. Later image updates add the older digests with
`--previous-box-image` (oldest first, up to two: policy P8 admits the current image and two older ones).

### 3. Apply them (platform, cluster-admin)

**First, the namespaces, then three objects nothing in the folder creates.** egress-lists patches `squid-boxes`
and `squid-passwd` and only reads `egress-settings`, and rightly has no right to create any of them, so on a new cluster
they're made once, empty, before the rest is applied. Each command creates its object only if it's missing and
never overwrites one that's there, so running the step again changes nothing:

```sh
kubectl apply -f <folder>/10-namespaces.yaml
kubectl -n egress-proxy get configmap squid-boxes >/dev/null 2>&1 \
  || kubectl -n egress-proxy create configmap squid-boxes
kubectl -n egress-proxy get secret squid-passwd >/dev/null 2>&1 \
  || kubectl -n egress-proxy create secret generic squid-passwd --from-literal=passwd=
kubectl -n egress-lists get secret egress-settings >/dev/null 2>&1 \
  || kubectl -n egress-lists create secret generic egress-settings --from-literal=egress.json='{}'
```

Empty means deny: no box files and no logins, so squid lets nothing through until egress-lists fills
`squid-boxes` and `squid-passwd` for each box. `egress-settings`' `{}` gives every box the default parts; per-box
settings go in it later through the secret store, never in this file.

Then apply the filled folder in name order: `kubectl apply -f <folder>/` does that (`10-` to `71-`; the box
PriorityClass and squid's NetworkPolicy are numbered `70-` and `71-`). The admission policies and NetworkPolicies are the safety rules: apply them
unchanged. Have a second person review the filled folder before it's applied.

### 4. Deploy the Switch server with the switch off

First, take a database backup: the upgrade changes the database, and an older server image won't start on the
upgraded one. Then deploy Core and the gateway from this branch with the environment's usual values. With
`switchCore.hostedBoxProvisioning` left out or false, the chart renders as before and the server runs v1.

Check v1 still works as a user, an admin and an operator.

### 5. Switch v2 on (waits on 6)

Add the v2 values, starting from `../remote/helm/switch/values-hosted-v2.example.yaml`: the switch, the launch
capacity, the `hosted_agents` and `agent_management` flags, the three Secret names, and a short
`allowed_tenant_ids` list in `controller.json`. The chart refuses to render v2 if any required piece is missing.
Roll out: the server reads the switch once, at start-up.

Check end to end: a new user's box is made by itself, their agent answers, and sleep and wake work.

**To go back to v1:** drain every box to 0 first, then set `hostedBoxProvisioning: false` and roll out. Boxes
keep their data, and switching on again resumes them.

### 6. A test Console from this branch

On a tester's machine, in a checkout of this branch:

```sh
cd console
pnpm install --frozen-lockfile
pnpm -r --filter './packages/**' run build
SWITCH_CONSOLE_USER_DATA_DIR=switch-v2-test pnpm --filter @switch-console/desktop run dev
```

The dev run keeps its own data folder (`switch-v2-test`), so it doesn't touch the tester's everyday Console. A
packaged stable build (`package:mac` and the like) ignores that variable and would share the everyday Console's
data, so don't hand one out for testing.

## Removing a person's box and disk (manual, for now)

Nothing removes a box automatically yet. The operator has no right to delete anything, and a deleted or
released machine's box is only scaled to 0, with its disks kept. That includes a box finished after Core had already
given up on its request. The operator makes a box's two disk claims (`data-controller` and `data-agents`) when it
makes the box, so they exist even for a box that never started; with a storage class that binds on first use, the
cloud disks behind them are made only when a pod first uses them. A kept box still holds the person's files, and its
namespace holds a working proxy login. For a box that has run, the disk also holds its controller's credential and
the person's saved logins. So when a
person's account is deleted, or a box is to go for any other reason, a cluster admin removes it by hand, with a
second person checking.

This relies on the cluster's `gp3` StorageClass having `reclaimPolicy: Delete`, so that deleting a disk claim also
deletes the cloud disk behind it. With any other policy, removed boxes leave their disks behind.

1. **In Switch first:** delete the person's cloud machine (or their account), so Core no longer asks for a box for
   it. Note the machine id.
2. **Find the box's namespace** in the box map, which maps each machine id to its namespace (`agents-user-…`):

   ```sh
   kubectl -n switch-hosted get secret box-map -o json | jq -r '.data["<machine-id>"] | @base64d'
   ```

3. **Remove the machine's entry from the box map first.** With the entry gone, the scaler no longer touches the box,
   and the proxy login isn't written into its namespace again. Policy P5 only stops the provisioner removing
   entries, not an admin. `kubectl replace` carries the Secret's version, so it fails, rather than overwriting, if the
   map changed in the meantime; read it again and repeat:

   ```sh
   kubectl -n switch-hosted get secret box-map -o json | jq 'del(.data["<machine-id>"])' | kubectl replace -f -
   ```

4. **Delete the namespace.** That removes the box, both its Secrets (the enrolment code and the proxy login) and
   its disk claims:

   ```sh
   kubectl delete namespace <namespace>
   ```

5. **Check everything is gone.** Each of these must come back empty:

   ```sh
   kubectl get namespace <namespace>        # NotFound: the box and both Secrets are gone
   kubectl get pv | grep "<namespace>/"      # no volume left for its claims
   aws ec2 describe-volumes \
     --filters Name=tag:kubernetes.io/created-for/pvc/namespace,Values=<namespace> \
               Name=tag:ebs.csi.aws.com/cluster-name,Values=<cluster> \
     --query 'length(Volumes)'                # 0: no cloud disk left in this cluster
   ```

   If a disk is left (a StorageClass that keeps them), delete it, and say so in the record of the removal.

Doing this automatically, at least when an account is deleted, is required before v2 is offered to real users.

## Known limits

- The provisioner's config has room for three older box images, but admission policy P8 admits only two, so the
  filler allows two.
- Box namespaces carry the label `app.kubernetes.io/part-of: hosted-agents-test`. Policy P1 requires it and the
  provisioner writes it, so it works as is; renaming it needs both changed together.
- Existing boxes don't take a new box image by themselves yet; a manual update is needed.
- Nothing removes a box or its disk automatically yet: see "Removing a person's box and disk" above.
