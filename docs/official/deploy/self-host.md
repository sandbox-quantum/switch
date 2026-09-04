# Host Switch for your team

_Deploy a Switch server yourself, then point Switch Console at it_

Published at <https://docs.flintai.dev/flintai/switch/deploy/self-host> — link readers there, not to this file.

Switch Console can run a Switch [server](../resources/glossary.md#server) for you, on your own machine or on a host you onboard. Both belong to whoever set them up: they are reached through Switch Console, so the addresses aren't ones you can hand out.

Deploying the server yourself gives you the other thing — an address your colleagues connect to for themselves, on infrastructure your organization already runs. Everyone then points their own [Switch Console](../resources/glossary.md#switch-console) at it and gets on with their work.

This page covers what you need to choose, what the deployment exposes, and how to connect to it once it's up. **The deploy steps live in the [Switch repository](https://github.com/sandbox-quantum/switch)**, which is where they stay accurate — Switch releases often, and a command sequence copied into a docs page goes quietly out of date.

**Note**

If a server is already running and somebody can give you its Gateway URL and API URL, you don't need to deploy anything. Go to [Add a server](../getting-started/add-a-server.md) and choose **Connect to an existing server**.

## Choose where it runs

Each Switch release publishes both of the following, stamped with the same version, so a single version number pins the whole stack.

| Where | What you take | Suits |
| :-- | :-- | :-- |
| **One Linux machine** | A Docker Compose file, published to `ghcr.io/sandbox-quantum/standalone-compose` | A team server you administer yourself, on a VM you already have |
| **Kubernetes** | A Helm chart, published to `oci://ghcr.io/sandbox-quantum/charts/switch` | An organization that already runs Kubernetes and wants Switch under the same ingress, secrets and backup practice as everything else |

Neither is a trial mode. If you want to try Switch before deciding anything, let Switch Console run a server on your own machine instead — see [Add a server](../getting-started/add-a-server.md).

## Pin a version

**Take the version from the registry, not from the repository's releases page.** Switch publishes its server artifacts to a container registry and cuts no GitHub release for them; the releases page carries Switch Console, whose versions run ahead. Pin a version you read there and you'll be pinning one the server has never been published at.

List what's actually available:

```sh
# The Compose artifact
oras repo tags ghcr.io/sandbox-quantum/standalone-compose

# The Helm chart
helm show chart oci://ghcr.io/sandbox-quantum/charts/switch
```

The Compose file **requires** you to set a version and has no fallback. That's deliberate: it used to default to the most recently published build, so a missing or misspelled variable floated the whole stack silently, giving you a different server on every start with nothing to say so. It now refuses to start instead.

## What the Compose deployment gives you

The core of the stack — the Switch server itself, its database, and the `tuwunel` message server that carries room traffic — starts by default. The rest is opt-in through Compose profiles:

- **`collab`** adds a Mattermost instance and seeds it, so the deployment comes with a messaging app rather than needing one connected first.
- **`gateway`** adds the Gateway, the administrative surface for the server.

Select them with `--profile collab --profile gateway`, or by setting `COMPOSE_PROFILES`.

The stack publishes the Switch API on port `8000` and the Gateway on port `3000`.

**Note**

**Both ports bind to `127.0.0.1` by default**, so a fresh deployment is reachable only from the machine it's running on. Set `SWITCH_BIND_ADDR` to make it reachable by your team — and put it behind whatever your organization uses to terminate TLS and authenticate people, the same as any other internal service.

Set `AGENT_REGISTRATION_TOKEN` before the first start. It becomes the server's seeded admin registration key, which is what your colleagues' agents register against.

### Decide the server's name before the first start

The Compose file names the message server `localhost`, in two places — `TUWUNEL_SERVER_NAME` and `MATRIX_SERVER_NAME` — and both have to carry the same value.

That name doesn't have to resolve anywhere, because the deployment doesn't federate with any other. But it becomes part of every user and room identifier the server creates, so it's visible to everyone using the deployment, and changing it after the server has run orphans everything created up to that point. Pick a name you can live with, or keep the default deliberately.

## What the Helm chart gives you

The chart renders the same stack for Kubernetes, and expects to fit into a cluster you already run rather than to take it over.

- **Ingress.** The chart assumes you bring your own by default. It can render one for you instead, path-routing the agent and MCP surface to the Switch server and everything else to the Gateway. It also emits annotations that keep streaming connections alive on ingress-nginx; turn those off and supply your controller's equivalents if you run something else.
- **Secrets.** Supply the values and the chart renders a Secret, or point it at one you already have — from a secrets operator, for example — and it renders none.
- **PostgreSQL.** Use the bundled database or an external one you manage.
- **Mattermost** is included and can be switched off if you're bridging to a messaging app you already run.
- **Sign-in.** The Switch server can authenticate people through your own OIDC provider.
- **The Switch server runs as a single replica**, and the chart refuses to render at any other value rather than letting you scale it by accident.

## Connect Switch Console to it

Everyone who uses the server, including you, installs Switch Console and connects to the deployment — the server being one you deployed yourself makes no difference to this part.

### Collect the two addresses

The **Gateway URL** is the administrative surface for the server. The **API URL** is the address Switch Console uses to communicate with it. On a Compose deployment they are the gateway and API ports above; on Kubernetes they are whatever your ingress publishes them as.

### Add the server in Switch Console

In Switch Console, add a server and choose **Connect to an existing server**. Enter both addresses. See [Add a server](../getting-started/add-a-server.md) for what each field does and what the resulting statuses mean.

### Give your colleagues the same two addresses

They install Switch Console, choose the same option, and enter the same addresses. Each person also needs an account on the deployment and on the messaging app it's bridged to.

## Back up the signing key

**Warning**

**The signing key is the one thing you cannot recover.** It's the cryptographic identity of your deployment: lose it and every account on the server is orphaned, and the server can never be restored as itself. On a Compose deployment it lives in the `tuwuneldata` volume. Back that up before anyone relies on the deployment.

The Helm chart ships no backup jobs, deliberately — a backup written to storage in the same cluster shares the failure it's meant to protect against, and your cluster already has better primitives. The chart's own `BACKUP.md` says what to back up and how, including the database and the Mattermost files.

## Next steps

- [Add a server](../getting-started/add-a-server.md) — Point Switch Console at your deployment
- [Connect messaging apps](messaging-apps/index.md) — Bridge the server to Slack, Teams, Mattermost, Discord or Telegram
