# Switch Helm chart

Deploys Switch into a Kubernetes cluster: switch-core (the API and all bridge
adapters), the gateway dashboard, a Tuwunel Matrix homeserver, Postgres, and
optionally Mattermost.

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
run a Microsoft Teams bridge. Every other collaboration bridge — Slack,
Mattermost, Discord, Telegram — connects *outbound* over a WebSocket and needs
no ingress at all.

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

After install, `helm test` runs Graph's validation handshake against the Service
to prove the listener is bound and published. It runs *inside* the cluster, so
it cannot tell you whether Microsoft can reach you — check that from outside:

```bash
curl -i "https://teams.switch.example.com/api/teams/notifications?validationToken=ping"
```

Expect `200` with `ping` echoed back as `text/plain`. A timeout means it is not
public; a 404 means the path is missing or aimed at port 8000.

Full walkthrough, including the Azure side:
[`docs/bridges/TEAMS_SETUP.md`](../../../../docs/bridges/TEAMS_SETUP.md).

---

## Ingress modes

`ingress.mode` controls the main web Ingress:

- **`existing`** (default) — the chart renders no Ingress. Wire the Services up
  with your own manifest; [`samples/ingress.example.yaml`](samples/ingress.example.yaml)
  is copy-pasteable.
- **`managed`** — the chart renders one path-routed Ingress on `ingress.host`:
  `agentApiPaths` to switch-core, everything else to the gateway SPA.

`switchCore.teamsBridge.ingress.mode` is independent of this — `dedicated` works
under either.

TLS is yours to arrange. `ingress.tls.enabled` renders a `spec.tls` stanza;
supply `secretName`, or add a cert-manager annotation and let it create the
Secret. If your controller configures TLS by annotation instead (AWS ALB, for
example), leave `tls.enabled` false and annotate.

---

## Constraints you cannot configure away

**switch-core runs exactly one replica.** It holds live Matrix sync sessions and
bridge connections in memory; a second replica would duplicate every client and
split session state. `switchCore.replicaCount` other than 1 fails the render,
and the deployment strategy is `Recreate`, so upgrades have a brief outage
rather than two pods fighting.

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
