# The distributed Discord app — design spike

**Design and plan only — no implementation.** This is the Discord counterpart to
the distributed Slack app (in flight; see `SLACK_DISTRIBUTED_APP.md` and its
phased plan). `DISCORD_SETUP.md` describes the app **an operator registers for
themselves** — they create it, add its bot to their own guild, and paste the bot
token into Switch. This page describes the other one: the app **we** register and
distribute, which a customer installs by clicking **Add to Server** and which
never requires them to see a token.

They are two separate Discord apps and both will exist. Nothing here replaces the
other page. It reuses the multi-tenancy machinery built for the messaging-app
work (the `messaging_installs` table, the signed single-use install state, the
tenant lookup exempt from row-level security) — only what differs from Slack is
argued here.

## Why Discord is not Slack

Three facts about Discord decide the whole design, and each pulls the opposite
way from Slack:

- **One bot token per application, not one per install.** Adding the bot to a
  guild grants no per-guild credential; the OAuth exchange returns the *guild*
  (so we learn its id) and a user token we do not need. The bot authenticates to
  every guild with the single application bot token. There is no per-install
  secret to capture and store.
- **Message events arrive only over the Gateway** — an outbound WebSocket the
  bot opens. Discord has no HTTP delivery for messages (only *interactions* may
  optionally be delivered over HTTP). So the reason the distributed Slack app
  needs a public inbound webhook — that a distributed app cannot use the
  outbound socket — simply does not apply. Discord's outbound connection is
  native and multi-guild.
- **One bot token means one connection topology.** A guild is assigned to a
  Gateway shard by a fixed formula on its id; a connection cannot be subscribed
  to just one tenant's guilds. So a single connection **multiplexes every
  tenant's traffic**. That is not a choice — with one bot token it is the only
  shape — and it is the source of both the design's simplicity (no webhook) and
  its central hazard (isolation on a shared, long-lived connection).

A fourth fact shapes operations rather than architecture: **message content is a
privileged intent**, and an app in 100+ guilds must be **verified** to keep it.

## What a tenant and a guild are here

A *tenant* is a Switch customer — the row-level-security boundary that owns
agents, rooms and installs. A Discord *guild* is one server. The mapping is
many-to-one: a tenant may install into several guilds; each guild belongs to
exactly one tenant, enforced by the deployment-wide unique
`(platform, external_workspace_id)` on `messaging_installs` with
`external_workspace_id` holding the guild id.

Unlike a Slack workspace — which is heavyweight, self-identifying, and carries
its own per-workspace token — a Discord guild is a lightweight **routing label**
with no credential behind it, sharing a global bot and global users with every
other tenant's guilds. So Discord's boundary does none of the isolation work for
us: **Switch enforces it entirely**, by resolving `guild_id → tenant` on every
event and letting row-level security check everything below.

## Decisions

1. **A single, deployment-level Gateway connection**, holding the application
   bot token and multiplexing all tenants; each event is routed by
   `guild_id → tenant`. Sharding is deferred until scale requires it (Discord
   mandates it past 2,500 guilds). The alternative of a connection per tenant
   does not exist for a distributed app: Discord offers no API to create an app
   per customer, and that is exactly the self-registered model this replaces.

2. **No per-install credential.** `messaging_installs.encrypted_bot_token`
   becomes nullable; a Discord install stores no token. The bot token is
   deployment configuration, injected when the connection is opened — it does
   not ride inside `connection_config` the way a Slack workspace token does.

3. **A per-guild bridge row still exists, but is inert.** Each install registers
   a `collaboration_bridges` row so rooms, the operator's bridge list and
   moderation keep working, but a distributed Discord bridge opens no connection
   of its own — its `start()` registers the guild with the shared connection.
   A delivery discriminator on the Discord connection config distinguishes the
   self-registered path (its own connection) from the distributed one (the
   shared connection), the way the Slack config distinguishes Socket Mode from
   webhook delivery.

4. **Direct messages are out of scope for the first version.** A Discord DM
   carries no guild id, so it cannot be attributed to a tenant. DM events are
   dropped explicitly — never silently — and the shared connection does not
   request DM message intents. Attributing a DM (for example, by the sender's
   single shared installed guild) is deferred, and would still have to refuse
   the ambiguous case of a user present in two tenants' guilds.

5. **Message content is treated as a launch gate.** The mechanism can be built
   and tested with the intent enabled in the developer portal; going past the
   verification threshold requires Discord's review. Whether agents can operate
   on **mentions only** — whose content is delivered without the privileged
   intent — is an open question that, if answered yes, removes the verification
   dependency for the first version.

6. **Interactions are delivered over the Gateway**, Discord's default. No HTTP
   interactions endpoint, and therefore no request-signature verification and no
   second inbound path to keep from drifting against the message path.

7. **Slash commands are registered globally** — once for the application, across
   every guild — rather than per guild as the self-registered adapter does
   today. Each invocation is routed by the guild id it carries. The cost is that
   command-set changes take minutes to propagate; the benefit is no per-install
   registration step and no registration traffic that grows with the number of
   guilds.

8. **The install callback is mandatory, and out-of-band joins are inert.** When
   the bot is removed from a guild the install is marked inactive rather than
   deleted. A guild the bot joins with no matching install row — added outside
   the OAuth flow — is logged and ignored; there is no default tenant to fall
   back to. The callback cannot be skipped in favour of the join event, because
   the join says a guild appeared but not which tenant added it — only the
   signed install state carries the tenant.

9. **The only public route is the OAuth callback.** There are no event or
   interaction endpoints to expose, no signatures to verify at an HTTP boundary,
   and the ingress change is limited to making the callback path publicly
   reachable over HTTPS at the deployment's public origin (the same value the
   redirect is built from).

10. **Registration is the feature flag.** The distributed Discord app exists for
    a deployment when its application credentials are configured — client id,
    client secret, bot token and application id — together with the public
    origin the redirect is built from. Setting some but not all is a startup
    error, as with the Slack app; there is no separate on/off switch.

11. **The requested guild permissions are minimal and pinned.** The authorize
    URL asks for `bot` and `applications.commands` and a least-privilege
    permission integer, both fixed in code and in this document and compared by
    a test, so the walkthrough and the code cannot drift.

## Architecture

A deployment-level Gateway client owns the single connection, holds the bot
token, and binds no tenant. For each event it reads the guild id, resolves the
tenant through the existing exempt lookup, binds that tenant for the scoped work,
and dispatches into that guild's rooms:

```
one Gateway connection (application bot token, no tenant bound)
    │  MESSAGE_CREATE / INTERACTION_CREATE  (carries guild_id)
    ▼
tenant_of_messaging_install("discord", guild_id) → tenant
    │  (unknown guild → drop; no active bridge → skip)
    ▼
bind tenant, re-read the install scoped to it, dispatch into the guild's rooms
```

The existing single-guild `DiscordAdapter` — which today opens its own Gateway
connection and filters events to its one guild — is split into a *connection
owner* (the socket, readiness, reconnection, global command sync) and *per-guild
logic* (room mapping, posting, slash dispatch). The self-registered bridge keeps
its own connection; the distributed bridge routes through the shared one.

## Security: isolation on a shared, multi-tenant connection

Event authenticity is *stronger* than Slack's: events arrive down an
authenticated, TLS-protected outbound connection, so an attacker cannot forge an
event carrying a victim's guild id without the bot token — the class of attack
Slack's webhook signature exists to stop is absent here. Credential blast radius
is *worse*: one bot token controls the bot in every tenant's guild, and Discord
offers no per-tenant key, so its compromise is a cross-tenant breach. It is kept
in deployment secrets, never in the database or a connection config, and must be
rotatable and monitored — this is the design's dominant residual risk and should
be reviewed as such.

The persistent, multi-tenant connection is a hazard the stateless Slack webhook
did not have, and the isolation of the design depends on four guards, each of
which must have a test that fails without it:

- **G1 — Per-event scoping.** Each event is handled in its own task so its
  tenant binding cannot leak into another; the binding always resets on exit,
  including on exception; no tenant is cached on the connection; the tenant is
  resolved fresh for every event.
- **G2 — Tenant-scoped identity.** Every user- or puppet-keyed record and cache
  is keyed by (tenant, Discord user id), never by the global user id alone, so
  the same person acting in two tenants' guilds yields two independent scoped
  records.
- **G3 — No default tenant.** An event for a guild with no active install is
  dropped, never routed to a default or first tenant. The system fails closed.
- **G4 — No guild-less routing.** An event with no guild id (a DM) is dropped
  before routing, and DM intents are not requested.

Two inherited properties must be preserved rather than shortcut: the install is
re-read *scoped* to the resolved tenant, so a wrong lookup is a miss rather than
a cross-tenant read; and the install state is signed, single-use and short-lived,
so a captured callback cannot be forged or replayed. As with Slack, the state
names the tenant but not the guild, so its confidentiality within its short life
still matters.

## What is reused, and what is new

Reused unchanged: the `messaging_installs` table, its deployment-wide uniqueness
and its row-level-security policy; the `tenant_of_messaging_install` lookup (now
consulted inside the event loop rather than at an HTTP boundary); the
single-use install state and the signed round trip; the installer registry and
the feature-flag-by-configuration pattern.

New or different: a Discord installer that builds the authorize URL and reads the
guild id back from the code exchange, and renders a connection config carrying
the guild id and no token; a nullable `encrypted_bot_token`; the delivery
discriminator on the Discord connection config; the deployment-level Gateway
client and the adapter split; global command registration; and the absence of
any webhook, signature or status-code layer.

## Phased plan

**Phase 1 — the mechanism**, mirroring the distributed Slack app and not
self-serve: the schema change; the configuration and its all-or-nothing
validator; the Discord installer registered when configured; the install
completion path handling the no-token credential; the shared Gateway client with
per-event tenant resolution and the four isolation guards; the adapter split and
the shared-connection delivery mode; global command registration; join and
removal handling with the explicit DM drop; and this walkthrough with a test
comparing its scopes, permissions and command set against the code.

**Phase 2 — self-serve and operator surface**: a customer-facing entry point
that establishes the tenant without an operator's session; the callback becoming
a redirect where there is somewhere to send people; and the operator's bridge
list distinguishing a shared-connection install from a self-registered bridge,
with revoke and status.

## Testing

Against real PostgreSQL under the restricted role, with two tenants installed
into two guilds, asserting each event reaches one tenant's rooms and no part of
it reaches the other's. Beyond the installer's own unit tests and the reused
state, claim and round-trip tests, each isolation guard has a test that fails
without it: interleaved events from two guilds with no bleed and a scope that
resets after a handler raises (G1); one Discord user in two guilds yielding two
scoped records (G2); an event for an unmapped or inactive guild dropped (G3); a
guild-less event dropped (G4); and a wrong lookup answer turning into a scoped
miss rather than a cross-tenant read.

## What is missing

- **No Discord app is registered.** Nothing here is reachable until one is,
  activated for public distribution, and configured with the credentials above.
- **The public origin is the deployment's**, joined to the callback path; only
  that path needs to be publicly reachable, which is a change to the deployment's
  ingress path allowlist (deployment-specific, outside this repository).
- **Verification for the message-content intent** is required past 100 guilds,
  unless the mention-only question is answered so as to avoid needing it.
- **Direct messages are unsupported** and dropped.
- **The adapter split is the largest piece of work** and the main schedule risk.
  If it or verification proves too costly, an interaction-only variant — slash
  commands over an HTTP interactions endpoint, no Gateway and no message content
  — remains available as a smaller first step, at the cost of not reading
  ordinary messages.
