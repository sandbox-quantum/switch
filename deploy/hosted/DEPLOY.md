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
  --kubernetes-service-ip <ip> --ca-cert <file.pem>
```

It writes filled copies of `k8s/*.yaml`, `box/priorityclass-switch-box.yaml` and
`egress/egress-proxy-networkpolicy.yaml` into the new folder, and refuses, writing nothing, if a value is malformed
or any placeholder would be left. The folder must be outside this repo, so a filled copy is never committed, and
the repo's files don't change. It also sets admission policy P4's zone pattern to the given zones, and the
cluster's `kubernetes` Service address in the NetworkPolicies. Later image updates add the older digests with
`--previous-box-image` (oldest first, up to two: policy P8 admits the current image and two older ones).

### 3. Apply them (platform, cluster-admin)

Apply the filled folder in name order: `kubectl apply -f <folder>/` does that (`10-` to `71-`; the box
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

## Known limits

- The provisioner's config has room for three older box images, but admission policy P8 admits only two, so the
  filler allows two.
- Box namespaces carry the label `app.kubernetes.io/part-of: hosted-agents-test`. Policy P1 requires it and the
  provisioner writes it, so it works as is; renaming it needs both changed together.
- Existing boxes don't take a new box image by themselves yet; a manual update is needed.
