# Switch Helm chart

Deploys Switch into a Kubernetes cluster: switch-core (the API and all bridge
adapters), the gateway dashboard, and Postgres.

```bash
helm install switch oci://ghcr.io/<owner>/charts/switch --version <version> -f my-values.yaml
```

Everything is configured through `values.yaml`, which is commented per value —
read it as the reference. This page covers the two things that are not obvious
from a values file: **what has to be reachable from where**, and the operational
constraints you cannot configure away.

For backup and restore, see [`BACKUP.md`](BACKUP.md).

---

## What has to be reachable, and from where

Switch has three network surfaces, and they have genuinely different exposure
requirements. Getting this wrong is the most common deployment problem, because
two of the three fail *silently* — the pods are healthy and the dashboard works.

| Surface | Port | Who must reach it | Consequence if unreachable |
| --- | --- | --- | --- |
| Gateway dashboard | 3000 | Your operators | You cannot administer Switch |
| Agent API + MCP | 8000 | Agents, wherever they run | Remote agents cannot connect; local ones are fine |
| Teams bridge listener | 3978 | **Microsoft, from the public internet** | The Teams bridge half-works, silently |

**Only the Teams listener requires public internet exposure**, and only if you
run a Microsoft Teams bridge. Slack, Discord and Telegram connect *outbound*
over a WebSocket and need no ingress at all.

If your agents all run inside the cluster or on operator machines that can reach
it privately, nothing here needs to be on the public internet.

### The agent API

Port 8000 serves the agent bridge, MCP, and OAuth/MCP discovery. Expose it as
widely as your agents live and no wider — a VPN or private load balancer is
fine, and is the better default. `ingress.agentApiPaths` lists the prefixes
routed there.

Note it is Bearer-token authenticated, not unauthenticated, but it is still the
control plane: agents post messages and read room context through it.

### The Teams bridge listener

Unlike every other bridge, Teams pushes to you. Microsoft calls two paths —
`/api/messages` (Bot Framework activities) and `/api/teams/notifications` (Graph
change notifications) — and the adapter serves them from its own HTTP server on
port 3978, separate from the API on 8000.

That means:

- The address must resolve in **public DNS**. Tailscale, a VPN or an
  internal-only load balancer will not do; Microsoft's servers are on the
  internet.
- It must be **HTTPS with a certificate Microsoft trusts**. Graph answers a new
  subscription by calling your notification URL and expecting the validation
  token echoed back within 10 seconds, so a self-signed cert, a redirect or an
  auth proxy in front all fail the handshake.
- Those two paths are unauthenticated *at the network layer* by necessity — the
  adapter authenticates each request itself (Bot Connector JWT, and the
  `clientState` shared secret respectively). Do not put an auth proxy in front.

Because it is only two paths, you do not have to expose anything else. Set
`switchCore.teamsBridge.ingress.mode=dedicated` and the chart renders a second
Ingress carrying just those paths on their own hostname, leaving the gateway and
agent API wherever you put them:

```yaml
switchCore:
  teamsBridge:
    enabled: true
    ingress:
      mode: dedicated
      className: nginx
      host: teams.switch.example.com
      annotations:
        cert-manager.io/cluster-issuer: letsencrypt-prod
      tls:
        enabled: true
        secretName: switch-teams-tls
```

The other modes are `shared` (add the paths to the chart's managed Ingress, so
Teams shares the gateway's hostname) and `external` (you route them yourself —
see [`samples/ingress.example.yaml`](samples/ingress.example.yaml)).

**Enabling the bridge without choosing a mode is a render-time error.**
Publishing the port with nothing routing to it produces a bridge that creates
channels and posts messages while receiving nothing back, which is a failure you
would otherwise discover days later. The chart refuses instead.

Note the dedicated Ingress takes its annotations only from
`teamsBridge.ingress.annotations`; the top-level `ingress.annotations` are not
merged in, so anything org-wide has to be repeated there.

After install, `helm test` runs Graph's validation handshake against the Service
to prove the listener is bound and published. **It fails until a Teams bridge is
registered** — the chart opens the port, but only a configured bridge puts a
listener behind it — so keep it out of any automated gate that reads a failure
as broken. And it runs *inside* the cluster, so it cannot tell you whether
Microsoft can reach you. Check that from outside:

```bash
curl -i "https://teams.switch.example.com/api/teams/notifications?validationToken=ping"
```

Expect `200` with `ping` echoed back as `text/plain`. A timeout means it is not
public; a 404 means the path is missing or aimed at port 8000.

Full walkthrough, including the Azure side:
[`docs/old/bridges/TEAMS_SETUP.md`](../../../../docs/old/bridges/TEAMS_SETUP.md).

---

## Ingress modes

`ingress.mode` controls the main web Ingress:

- **`existing`** (default) — the chart renders no Ingress. Wire the Services up
  with your own manifest; [`samples/ingress.example.yaml`](samples/ingress.example.yaml)
  is copy-pasteable.
- **`managed`** — the chart renders one path-routed Ingress on `ingress.host`:
  `agentApiPaths` to switch-core, everything else to the gateway SPA — or, with
  `gateway.enabled: false`, everything to switch-core, which serves the
  dashboard itself. That drops the separate gateway Deployment.

`switchCore.teamsBridge.ingress.mode` is independent of this — `dedicated` works
under either.

TLS is yours to arrange. `ingress.tls.enabled` renders a `spec.tls` stanza;
supply `secretName`, or add a cert-manager annotation and let it create the
Secret. If your controller configures TLS by annotation instead (AWS ALB, for
example), leave `tls.enabled` false and annotate.

---

## Upgrading from a release that deployed Mattermost

The chart no longer deploys Mattermost or its setup Job. Upgrading removes the
Mattermost Deployment and Service but leaves its data in place:

- The `mattermost` database stays in Postgres; nothing drops it.
- The `<release>-mattermost-data` volume is kept: `helm upgrade` finds it and
  re-renders it annotated `helm.sh/resource-policy: keep`, so no later upgrade
  or uninstall deletes it. Tools that render without cluster access
  (`helm template`, Argo CD, Flux) cannot find it: set
  `retainMattermostData: true` (and `retainedMattermostDataSize` to the old
  `mattermost.persistence.size`) so they keep it too.

Back both up before upgrading (see [`BACKUP.md`](BACKUP.md)). Once you no
longer want them:

```bash
kubectl delete pvc <release>-mattermost-data
kubectl exec <release>-postgresql-0 -- psql -U postgres -c 'DROP DATABASE mattermost;'   # managed mode; on an external DB, drop it there
```

Console chat replaces Mattermost and is always on; `agent_chats` and
`group_chats` no longer need to be listed in `featureFlags.enabled`, and may
stay listed. With several switch-core replicas, finish rolling out every
replica before people use group chats, because an older replica ignores the
group-chat fields.

`switchCore.collaborationCallback` and `secrets.mattermostAdminPassword` /
`mattermostUserPassword` are gone; remove them from your values. A
`secrets.existingSecret` may drop its `MATTERMOST_*` keys.

## Constraints you cannot configure away

**switch-core can run more than one replica.** `switchCore.replicaCount` sets
how many. Shared state lives in the database: replicas signal each other through
Postgres notifications, and each bridge's listener and outbound relay and each
command reader is owned by one replica at a time through a lease. That includes the shared Discord gateway connection of the
distributed Discord app, whose Discord bridges run beside it on the same
replica, and each Teams bridge's Graph subscriptions, which only the replica
holding the bridge makes and renews. Any replica can hold any client's
connection, and a platform webhook can reach any replica.

One replica upgrades with `Recreate`, so an upgrade has a brief outage. More
than one rolls (`switchCore.rollingUpdate`, one extra pod at a time by
default) and gets a PodDisruptionBudget (`switchCore.podDisruptionBudget`) and
a soft spread across nodes (`switchCore.topologySpread`). On SIGTERM a pod
hands its owned work to the others before it stops, inside
`switchCore.terminationGracePeriodSeconds`.

**Bridges are created at runtime, not in values.** You register a collaboration
bridge in the gateway dashboard, with its credentials, after the chart is
installed. That is why `switchCore.teamsBridge.enabled` exists at all: the chart
cannot see your bridges, so it cannot infer that you need port 3978 published.

**A bridge that fails to start is dropped, not retried.** It is restarted when
switch-core restarts. If a bridge is missing after a configuration change,
restart the deployment.

---

## Secrets

Either let the chart manage them — set the values under `secrets:` and it
renders `<release>-secrets` — or set `secrets.existingSecret` to the name of a
Secret you produced yourself (External Secrets Operator, sealed-secrets, …). The
required keys are listed above the `secrets:` block in `values.yaml`.

Bridge credentials are **not** among them. Those are entered in the gateway and
stored in the database.

## Avatars from outside services

An agent with no icon of its own is drawn by api.dicebear.com with its name as
the seed, and a person relayed from another platform by ui-avatars.com with their
name in the URL, so the services see the name. Slack and Discord fetch the image
on their own servers and serve their copy, Teams draws it inside each card (some
Teams clients may load it from the service directly), and Switch Console loads it
on each user's machine.
To send no such URL:

```yaml
switchCore:
  thirdPartyAvatars:
    enabled: false
```

Each platform then shows its own default icon (Slack the app's icon, Discord its
default avatar, Teams no image),
icons already stored on those services are withheld too, and new agents get no
generated icon. Setting an icon on one of those services is refused with the
reason. Switch Console asks the server and stops drawing them for its agents. An
icon an owner set on any other host is unaffected.

## Follow the conversation

Off by default. With the `follow_the_conversation` feature flag on, a person's
message that names nobody can still reach an agent: a reply in a thread the
agent owns, their next channel message in an exchange with the agent that
nobody else interrupted, or any message in a room whose assigned agent it is.
People turn the follow-ups off per room with `!follow-ups off`.

```yaml
switchCore:
  featureFlags:
    enabled: ["follow_the_conversation"]
  followTheConversation:
    windowSeconds: 300
```

The chart sets `FOLLOW_THE_CONVERSATION_WINDOW_SECONDS` from `windowSeconds`
only while the flag is on (1 to 3600 seconds). A channel exchange counts only
while every gap in it, from a person's request to the agent's answer and from
that answer to their next message, is within the window; after a break, people
mention the agent again.

## Agent management

Managed agents, and the agent controllers that run them on users' machines, are
off by default. The `agent_management` feature flag turns them on:

```yaml
switchCore:
  featureFlags:
    enabled: ["agent_management"]
secrets:
  controllerTokenSecret: "<openssl rand -hex 32>"
```

With `secrets.existingSecret`, put the token secret in that Secret as
`CONTROLLER_TOKEN_SECRET` instead. The chart sets `FEATURE_FLAGS_ENABLED`,
`CONTROLLER_TOKEN_SECRET` and `CONTROLLER_STATUS_INTERVAL_SECONDS` on switch-core
and its migration Job, so enabling it is one rollout. Controllers enroll and
connect under `/v1`, which `ingress.agentApiPaths` routes to switch-core by default.

`switchCore.agentManagement.enabled` is gone: the chart refuses to render with it
set to true, and switch-core refuses to start with `AGENT_MANAGEMENT_ENABLED=true`.
Move it to the flag list instead.

A deployment that set these variables with `kubectl set env` should remove them
before the first upgrade that renders them (`kubectl set env deployment/<release>-switch-core
AGENT_MANAGEMENT_ENABLED- CONTROLLER_TOKEN_SECRET-`). Otherwise Helm merges its
`valueFrom` into the live `value` and the API server rejects the Deployment.

### Controller updates

`switchCore.controllerRelease` names the agent controller release switch-core
tells every controller to run (cloud machines, and `switch-agent-controller`
on SSH hosts and laptops; Switch Console's own controller updates with Console):

```yaml
switchCore:
  controllerRelease:
    version: "0.31.0"
    url: "https://github.com/sandbox-quantum/switch/releases/download/switch-agent-controller-v0.31.0/switch-agent-controller-0.31.0.tgz"
    sha256: "<sha256 of that file>"
```

A controller running another version downloads the package, refuses it unless
its SHA-256 matches, and installs it and restarts once none of its agents has a
session running. The chart published with a Switch release has these filled in
with that release's controller package, so upgrading Switch upgrades the
controllers too. Set all three or none (the chart refuses to render otherwise);
with none, controllers are told nothing and keep their version. To roll
controllers back, point the three values at the previous release's package and
upgrade.
