# Host Switch for your team

_Deploy a Switch server yourself, then point Switch Console at it_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/self-host> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";

Switch Console can run a Switch [server](../resources/glossary.md#server) for you on your own machine or on a remote host that you onboard. A Console-run server is run through the Switch Console of the person who creates it. It doesn't provide a shared server address for your colleagues to use.

To give your team a shared server, deploy Switch yourself on infrastructure your organization runs. The deployment gives you a server address. Share it with your colleagues so each person can point their own [Switch Console](../resources/glossary.md#switch-console) at the server and work in the same environment.

Use this page to decide which deployment approach fits your team, understand what the deployment creates, and connect Switch Console after the server is running. When you're ready to deploy, follow the latest steps in the [Switch repository](https://github.com/sandbox-quantum/switch). To have your coding agent guide you, see [Use these docs](https://docs.switchagents.ai/use-these-docs).

**Note**

If a server is already running and you have its address, you don't need to deploy anything. In Switch Console, add a server and choose **Connect to an existing server**. See [Add a server](../getting-started/add-a-server.md).

## Before you begin

You'll need:

- **Somewhere to run Switch.** Use a Linux machine you administer or a namespace in a cluster where you can deploy. Start with whoever provisions infrastructure in your organization. This request often has the longest lead time on this page.
- **A way for colleagues to reach the server.** A fresh deployment is reachable only from the machine running it. Your organization will need to expose it through the service that terminates TLS and handles sign-in. The person who runs that service is often not the person who deploys the server.
- **A messaging-app administrator**, if you plan to connect Switch to an app your team already uses. See [Connect messaging apps](messaging-apps/index.md) for what each app requires from its administrator. You don't need one to get started: both deployment options can start a Mattermost instance for you.
- **A name for the server.** Choose this before you start the server. Switch uses the name for every account and room it creates, and you can't change it afterward. See [Decide the server name before deploying](#decide-the-server-name-before-deploying).
- **The values the server won't start without.** Set them before you start the server for the first time:
  - `AGENT_REGISTRATION_TOKEN`: the deployment's bootstrap key, for registering agents before anyone has an account. Agents registered with it belong to a separate account that isn't an administrator, so don't give it to colleagues: they create their own registration keys. The Helm chart reads it from `secrets.agentRegistrationToken`.
  - `SECRET_KEYS`: the server's master keys, as `<id>:<secret>` pairs separated by commas, with the current key first. Each secret must be at least 32 characters. Every signing and encryption key derives from them. The Helm chart reads it from `secrets.secretKeys`.
  - `GATEWAY_ADMIN_EMAIL` and `GATEWAY_ADMIN_PASSWORD`: the first admin account, which the server creates at its first start. The Helm chart reads them from `secrets.gatewayAdminEmail` and `secrets.gatewayAdminPassword`.

## Pin a version

This page assumes you've chosen Docker Compose on one Linux machine or Helm on Kubernetes. To compare them, see [Choose how to run Switch](index.md).

**Tip**

For a low-friction way to try Switch before deploying formally, let Switch Console run a server on your own machine. See [Add a server](../getting-started/add-a-server.md).

Each Switch release publishes the Compose file to `ghcr.io/sandbox-quantum/standalone-compose` and the Helm chart to `oci://ghcr.io/sandbox-quantum/charts/switch`, with the same version number. Set that one version to pin the entire stack.

**Choose the server version from the container registry.** The GitHub releases page lists versions of Switch Console, which is versioned separately. Those version numbers may not exist for the server.

**Upgrade the server before your team updates Switch Console.** Each person updates Switch Console when they choose, and each Switch Console release needs the server release it was built with, or a later one. The [changelog](../resources/changelog.md) entry for each Switch Console release names that server release. Upgrading the server first is safe for anyone still on an older Switch Console, except for connecting a service: from Switch 0.31.0, that needs Switch Console 0.40 or later. The exception applies only to a server that offers service connections, through a GitHub App or with service connections turned on.

To list what's available:

### Docker Compose

```sh wrap
oras repo tags ghcr.io/sandbox-quantum/standalone-compose
```

**Warning**

**You must set a version in the Compose file.** Compose refuses to start if no version is set.

### Helm

```sh wrap
oras repo tags ghcr.io/sandbox-quantum/charts/switch
```

## Configure a Compose deployment

By default, the stack starts the Switch server and its database. The database stores room traffic and everything else the deployment keeps. To add more, turn on these Compose profiles:

- `collab`: Adds a Mattermost instance and seeds it, so the deployment has a messaging app without connecting one first.
- `gateway`: Adds the Gateway, the administrative surface for the server.

To turn them on, pass `--profile collab --profile gateway`, or set `COMPOSE_PROFILES`.

The stack publishes the Switch API on port `8000` and the Gateway on port `3000`.

**Note**

**Both ports bind to `127.0.0.1` by default,** so a fresh deployment is reachable only from the machine it runs on. To make the server reachable by your team, set `SWITCH_BIND_ADDR`. Put the server behind the service your organization uses to terminate TLS and handle sign-in, as you would any other internal service.

The Compose file also declares a `tuwuneldata` volume. Leave it in place. On a new deployment it stays empty and uses no space.

### Decide the server name before deploying

The Compose file sets the server name to `localhost`, in `ID_SERVER_NAME`. Older deployments set it in `MATRIX_SERVER_NAME`, which still works but is deprecated. The server itself has no default name and won't start without one.

The name is a naming scheme, not an address. Nothing contacts the server at that name, so the name doesn't have to resolve anywhere. It becomes the second half of every user and room identifier the server creates, so everyone using the deployment sees it. Changing the name after the server has run orphans everything created up to that point. Choose a name you can keep, or keep `localhost` deliberately.

## Configure a Helm deployment

The chart renders the same stack for Kubernetes, in a cluster you already run.

- **Ingress:** By default, you bring your own. The chart can render one instead, which routes the agent, MCP, and bridge paths to the Switch server and everything else to the Gateway. The chart also adds annotations that keep streaming connections alive on ingress-nginx. If you run a different ingress controller, turn those annotations off and add the equivalents for your controller.
- **Secrets:** Supply the values and the chart renders a Secret. To use a Secret you already have, such as one from a secrets operator, point the chart at it with `secrets.existingSecret` and the chart renders none. That Secret then has to include every required value itself, including `AGENT_REGISTRATION_TOKEN`, `SECRET_KEYS`, `GATEWAY_ADMIN_EMAIL`, `GATEWAY_ADMIN_PASSWORD`, and `POSTGRES_PASSWORD`.
- **PostgreSQL:** Use the bundled database or an external one you manage.
- **Mattermost:** The chart includes it. Turn it off if you connect Switch to a messaging app you already run.
- **Sign-in:** The Switch server can sign people in through your OIDC provider.
- **Replicas:** Set the number of Switch server replicas with `switchCore.replicaCount`. <Since version="Switch 0.31" /> One replica upgrades with a short outage. More than one upgrades one replica at a time by default (`switchCore.rollingUpdate`). On an older release, the chart runs a single replica and refuses any other count.
- **Old file volume:** On a new deployment, set `retainTuwunelData` to `false`. It's on by default and provisions 10Gi of storage that only a deployment upgraded from a release before 0.24.0 uses.

## Set the server's public address {#set-the-servers-public-address}

**Set `GATEWAY_PUBLIC_URL` to the public address of the Switch API:** the scheme and host your colleagues' Switch Console connects to, with no path. Despite its name, it isn't the Gateway's address.

Set it in the Compose `.env` file, or as `switchCore.gatewayPublicUrl` in your Helm values. To change it on a running server, apply the change the way you deployed: `docker compose up -d` or `helm upgrade`. `docker compose restart` isn't enough.

Without it:

- **Links to Switch Console don't work in Slack, Teams, Discord, or Telegram.** Those apps open only web addresses. An **Open in Switch Console** link doesn't open, or is removed or posted as plain text, and a link an agent posts to a Switch Console page arrives as the page's name in words. With the address set, both arrive as web links that open the page in Switch Console.
- **The Gateway can't enroll agent controllers.** Its **Add machine** dialog shows no enrollment command, so set the address before you turn on agent management.

## Turn on agent management

Agent management lets the people on your server allow their agents to create agents on their machines. On a server you deploy, agent management is off by default. It's active by default on a server Switch Console runs. <Since version="Switch Console 0.40" />

Turn on agent management when you deploy. To turn it on for a server that's already running, apply the change the way you deployed: `docker compose up -d` recreates the containers, and `helm upgrade` updates the release. `docker compose restart` isn't enough, because it keeps the old environment.

Tell the people on your server before you turn it on. Once it's on, each person's Switch Console moves the agents it runs for them onto a managed machine on the computer where each agent already runs, and sets the machine up first if it needs to. Agents that someone else owns stay where they are. Any turn an agent is partway through is cut off.

Agent management needs the `agent_management` feature flag and a secret of at least 32 characters that signs the agent controllers' access tokens. Generate the secret with the tool your team uses for secrets, for example:

```sh
openssl rand -hex 32
```

### Docker Compose

Set both in the environment the Compose file reads, such as an `.env` file next to it:

```sh .env
FEATURE_FLAGS_ENABLED=agent_management
CONTROLLER_TOKEN_SECRET=<the secret you generated>
```

`FEATURE_FLAGS_ENABLED` takes a comma-separated list, so keep any flags already set there.

### Helm

Set both in your values file, or pass them with `--set`:

```yaml values.yaml
switchCore:
  featureFlags:
    enabled:
      - agent_management
secrets:
  controllerTokenSecret: "<the secret you generated>"
```

If you point the chart at an existing Secret with `secrets.existingSecret`, for example one from a secrets operator, add the secret to it under the key `CONTROLLER_TOKEN_SECRET` instead.

The chart fails to render if the secret is missing or shorter than 32 characters. Agent management also needs `/v1` routed to the Switch server. The chart's own ingress does that by default. If you run your own ingress, add the route yourself.

The server won't start if a flag name is misspelled, or if the secret is missing or too short. Once the server is running, **Can manage agents** appears on each agent's page in the Gateway, and under **General** on the agent's page in Switch Console.

## Let people connect services

Connectors let the people on your server give their agents access to services such as Atlassian, Datadog, GitHub, and Google Workspace. On a server you deploy, connectors are off by default. They're on by default on a server Switch Console runs.

What each connector needs from you:

| Connector | What you set up |
| :-- | :-- |
| Atlassian | Nothing. Switch registers itself with Atlassian. |
| Datadog | Nothing. Each person enters their own Datadog keys. |
| GitHub | A GitHub App, and an `https` public address for the server. |
| Google Workspace | A Google web application client, and a public address for the server. |

### Turn connectors on

Add the `service_connections` feature flag, the same way as [agent management](#turn-on-agent-management): to `FEATURE_FLAGS_ENABLED` for Docker Compose, or to `switchCore.featureFlags.enabled` for Helm, then apply the change. It's one list, so if agent management is already on, add `service_connections` beside `agent_management` rather than in a second block. Flags are read once, when the server starts, and the server refuses to start with a flag name it doesn't know.

### Set the server's public address

GitHub and Google Workspace need it. See [Set the server's public address](#set-the-servers-public-address).

### Register the GitHub and Google apps

Sign in to the Gateway as the administrator of the Switch server and select **Connectors**. Only that account sees the page. You can also use Switch Console: select **Admin**, then **Connector apps**, which shows only for the administrator of the Switch server. **Admin**, then **Connectors** is a different page, where admins turn connectors off for their workspace.

Select the connector, then follow the steps its dialog gives. The dialog shows the exact callback address to copy into GitHub or Google, and asks for the **Client ID** and **Client secret**, plus a **Private key** file for GitHub.

### Check that people can connect

People now see **Connectors** in the Switch Console sidebar. A connector that still needs setting up shows **Unavailable** on its card, with the reason.

[Admins](../resources/glossary.md#admin) can turn a connector off for their workspace. See [Turn a connector off for your workspace](../administer/people-and-agents.md#turn-a-connector-off-for-your-workspace).

## Connect Switch Console to the server

Everyone who registers agents or administers the server, including you, installs Switch Console and connects it to the deployment. People who only work with agents in a messaging app don't need it.

### Collect the server address

The server address is the one Switch Console and agents connect to, and the server serves the Gateway there too. On a Compose deployment, it's the API port above. On Kubernetes, it's the address your ingress publishes for the Switch server.

### Add the server in Switch Console

In Switch Console, add a server and choose **Connect to an existing server**, then enter the address as the **Server address**. See [Add a server](../getting-started/add-a-server.md) for what the resulting statuses mean.

### Give your colleagues the same address

Colleagues who register agents install Switch Console, choose the same option, and enter the same address. Each of them needs an account on the deployment. Colleagues who only use the messaging app don't.

To create their accounts, sign in to the Gateway as the administrator of the Switch server, open **Users**, and select **Add User**. Without single sign-on, people sign in with an email address and password.

**Warning**

Leave **Role** set to **User**. Choosing **Admin** makes the person another administrator of the server and an owner of the workspace you're working in.

## What to back up

**Warning**

**Back up the PostgreSQL database before anyone relies on the deployment.** It holds every room, message, shared file, and account.

The Helm chart doesn't include backup jobs. Use your cluster's existing backup tooling, and consult the chart's `BACKUP.md` for what to back up and how.

Store these values wherever your organization keeps secrets. They're provided through the environment, not stored on disk, so database and volume backups won't capture them:

- `SECRET_KEYS`: Protect this value especially carefully. If you restore the deployment with different keys, everyone is signed out, and the stored secrets it protects stop working: messaging-app bot tokens, service connections, OAuth client secrets, and agent registration tokens. Agents' API keys will still work, but the server won't be able to read them.
  - **To recover:** Add the old `<id>:<secret>` entry back to the list unchanged, after the current one. The next start re-encrypts everything under the current key.
  - **If the old key is lost:** Those secrets can't be recovered. Reconnect each messaging app and service connection, and register the agents again. Anyone who hasn't kept a copy of their API key will need a new one issued.
- `AGENT_REGISTRATION_TOKEN`: The deployment's bootstrap key.

If your deployment predates `SECRET_KEYS`, it also sets `JWT_SECRET_KEY`. Keep it set through your first upgrade to a release that uses `SECRET_KEYS`, then remove it.

The server reads `GATEWAY_ADMIN_EMAIL` and `GATEWAY_ADMIN_PASSWORD` only the first time it starts. Restoring the database brings back the administrator password as it was last set in the Gateway, not the value in your environment file.

### If you upgraded from a release before 0.24.0

Files shared before the upgrade are still in one volume: `tuwuneldata` on Compose, or a retained claim on Kubernetes. Switch doesn't read that volume, and it holds the only copy of those files. Back it up separately from the database, and don't delete it unless you've decided to let those files go.

On Kubernetes, leave `retainTuwunelData` on, which is the default, and set `retainedTuwunelDataSize` to the size the volume was created at. Kubernetes rejects a smaller claim. Turn `retainTuwunelData` off only after you've copied those files elsewhere or decided to let them go. The claim isn't deleted, but the release no longer protects it.

## Upgrade to 0.30 <Since version="Switch 0.30" />

Check each item that applies to your deployment before you upgrade.

- **Helm:** Remove `switchCore.agentManagement.enabled` from your values. The chart fails to render while it's on. To keep agent management on, add `agent_management` to `switchCore.featureFlags.enabled` instead.
- **Helm, with `global.imageRegistry` set as a mirror:** An image value that already names a registry, such as `ghcr.io/…`, is now used as written and no longer goes through the mirror. To pull that image through the mirror, write the mirror's address into the image value.
- **Helm, with an image value that names no registry:** The published chart sets `global.imageRegistry` to the registry Switch releases to, and now adds that registry in front of the image value. To pull from Docker Hub, write the full reference, such as `docker.io/library/postgres`.
- **Your own ingress:** Route `/agent-sessions`, `/version`, `/deeplink`, and `/v1` to the Switch server, alongside the paths you already route there. If the chart renders the ingress for you, it already does.
- **Switch server run without Compose or Helm, over plain HTTP:** Set `GATEWAY_COOKIE_SECURE=false`, or people won't stay signed in to the Gateway. The Compose file and the Helm chart already set this correctly for how they serve the Gateway.

## Next steps

- [Add a server](../getting-started/add-a-server.md) — Point Switch Console at your deployment
- [Connect messaging apps](messaging-apps/index.md) — Connect the server to Slack, Teams, Mattermost, Discord, or Telegram
