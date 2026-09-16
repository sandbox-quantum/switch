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
   `guild_id → tenant`. It is owned by the one switch-core process — which is
   already a **forced singleton** (the Helm chart hard-fails on
   `switchCore.replicaCount != 1`, because the event buffer, the invite bus, the
   presence bus and the message-listener subscriber registry all live in process
   memory, not the database). So "which replica holds the socket" — the question
   that forced the distributed Slack app onto webhooks — does not arise here: the
   connection is one more thing the single pod owns, alongside every existing
   bridge. It follows the pod's lifecycle (a `Recreate` rollout reconnects it on
   restart; discord.py auto-reconnects transient drops). Sharding is deferred
   until scale requires it (Discord mandates it past 2,500 guilds), and true
   multi-replica ownership (leader election) becomes relevant only if switch-core
   is ever made horizontally scalable — a larger effort that would first have to
   move those in-memory buses out of the process. The alternative of a
   connection per tenant does not exist for a distributed app: Discord offers no
   API to create an app per customer, and that is exactly the self-registered
   model this replaces.

2. **No per-install credential.** `messaging_installs.encrypted_bot_token`
   becomes nullable; a Discord install stores no token. The bot token is
   deployment configuration, injected when the connection is opened — it does
   not ride inside `connection_config` the way a Slack workspace token does.
   Nullable does not weaken the invariant for token-based platforms: a Slack
   install still must carry a token, but that is enforced where it already is —
   `SlackConnectionConfig.bot_token` is a required field, so a token-based bridge
   fails config validation at registration without one. The column's nullability
   is not the guard; the per-platform connection-config validator is.

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

5. **Message content is a runtime flag, defaulting to mention-only.** Requesting
   the privileged message-content intent while unapproved does not degrade
   gracefully — Discord closes the whole Gateway connection with code 4014. So
   the intent request must be conditional (e.g. `DISCORD_APP_MESSAGE_CONTENT`,
   default off): off, the connection opens fine and content still arrives for
   the cases the intent is not needed for — messages that mention the bot, DMs,
   and the bot's own messages — which is exactly mention-only operation; on
   (once approved), agents see all message content. Same connection code either
   way, and the fallback is reversible by flipping the flag. Verification is
   *per app*, not per tenant, and its ~100-guild threshold counts the total
   guilds across **every** tenant — so in the distributed model the app crosses
   it quickly and verification should be started early, not deferred.

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
tenant through the existing exempt lookup and re-reads the install *scoped* to
that tenant, then dispatches into that guild's rooms **with no tenant bound** —
each handler binds the tenant of the room it acts on, exactly as the socket and
webhook delivery paths already do (see decision below and G1):

```
one Gateway connection (application bot token, no tenant bound)
    │  MESSAGE_CREATE / INTERACTION_CREATE  (carries guild_id)
    ▼
tenant_of_messaging_install("discord", guild_id) → tenant
    │  (unknown guild → drop; no active bridge → skip)
    ▼
re-read the install scoped to that tenant, then dispatch (no tenant bound) into
the guild's rooms; handlers bind per-room
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

## Implementation stages

Phase 1 is the mechanism, and — like the distributed Slack app (PR #435, which
landed as schema → install protocol → the completing flow → inbound routing) —
it lands as an ordered series of reviewable commits, each one testable on its
own. Discord inherits most of Slack's first two commits unchanged: the
`messaging_installs` and `messaging_install_states` tables, the signed
single-use install state, the `tenant_of_messaging_install` lookup, the
`MessagingAppInstaller` ABC and its registry, the `/messaging` public-path
allowlist, and the operator's authenticated first leg at
`POST /messaging-apps/{platform}/install`. So the Discord series is shorter than
Slack's and weighted almost entirely towards its one large piece, the
connection. Each stage below names the real seams it touches, so it can be
reviewed against the code rather than against this prose.

**Stage 0 — depends on the distributed Slack app.** None of this is reachable
until PR #435 has merged; that work is the substrate. (If Discord were to land
first, the generic install-protocol layer would be built here instead of
inherited — but the plan assumes Slack first.)

**Stage 1 — the tokenless-grant seam.** A Discord install stores no credential,
and decision #2's "nullable `encrypted_bot_token`" is only the first of *four*
places in the shared layer that today assume a per-install token:

- a migration making `messaging_installs.encrypted_bot_token` nullable, with the
  `MessagingInstall` model column following;
- `InstallGrant.bot_token` becoming `str | None` — a Discord grant is a guild
  and a name, no token;
- `MessagingInstallStore.record_install` accepting a nullable
  `encrypted_bot_token`;
- `MessagingInstallService.complete` skipping `encrypt_token(...)` when the grant
  carries no token. It encrypts unconditionally today; that call is the seam
  decision #2 actually cuts, and the spike's "what is new" list omits it.

*Tests:* the RLS catalogue and frozen-DDL comparisons pick up the nullable
column; a store test records a tokenless install and reads it back through the
scoped path; the existing claim-conflict test is unaffected. This is a change to
shared code and lands first, because the Discord installer cannot be written
against the old signatures.

**Stage 2 — configuration and the Discord installer** (Slack's "install
protocol" commit, minus everything now inherited):

- `config.py`: `discord_app_client_id`, `discord_app_client_secret`,
  `discord_app_bot_token`, `discord_app_application_id` (env `DISCORD_APP_*`),
  an all-or-nothing `_validate_discord_app` mirroring `_validate_slack_app`, and
  the same requirement that `GATEWAY_PUBLIC_URL` be set if any is (decision #10).
  Note the bot token lives *here*, in deployment config, not in a per-install
  row — the one shape difference from Slack that everything else follows from.
- `discord/install.py`: `DiscordAppInstaller(MessagingAppInstaller)`,
  `platform = "discord"`. `authorize_url` builds the *Add to Server* URL with
  the pinned `bot applications.commands` scopes and the least-privilege
  permission integer (decision #11); `redeem` exchanges the code and reads the
  guild id and name back, returning a tokenless `InstallGrant`;
  `connection_config` renders `{guild_id, event_delivery: "shared"}` and no
  token.
- **The ABC mismatch.** `MessagingAppInstaller` declares `verify_webhook`,
  `parse_webhook` and `workspace_of_event` as abstract, and Discord has no
  webhook (decisions #6, #9). **Decision: stub the three to raise** in the
  Discord installer for now — the cheapest change, touching only Discord's file
  — and leave the cleaner refactor (splitting the ABC into an install half,
  which Discord needs, and a webhook-delivery half, which only HTTP platforms
  implement) as a follow-up once a second non-webhook platform makes it pay off.
  The stubs are never reached: Discord mounts no `/messaging/discord/events`
  traffic, so nothing calls them.
- `DiscordConnectionConfig`: a hidden delivery discriminator mirroring Slack's
  `event_delivery` — `SkipJsonSchema[Literal["own_connection", "shared"]] =
  "own_connection"` — with a `model_validator` refusing the half-states (a
  shared config carrying a bot token; an own-connection config without one), and
  `bot_token` optional under shared delivery.
- `main.py`: register `DiscordAppInstaller` when its credentials are configured,
  in the same boot block that registers the Slack one; everything downstream is
  platform-generic already.

*Tests:* a doc-vs-code test mirroring `test_slack_distributed_app.py`, parsing
the scopes, the permission integer, the redirect and the command set out of this
markdown and comparing them against what the installer asks for and the code
registers (decision #11); the `_validate_discord_app` all-or-none test; the
`DiscordConnectionConfig` half-state validator test.

**Stage 3 — the completing install and the inert bridge** (Slack's "install
completes" commit). The generic `begin`/`complete` already drive both OAuth
legs, and the finishing order (verify → bind → burn+commit → exchange → claim →
register → attach) is inherited; Discord supplies the tokenless `redeem` and the
shared-delivery `connection_config`. Discord-specific:

- the registered bridge is **inert** (decision #3): under shared delivery
  `DiscordAdapter.start()` opens no Gateway connection of its own and instead
  registers the guild with the shared connection built in Stage 4;
- removal and out-of-band joins (decision #8): the bot removed from a guild
  marks the install inactive rather than deleting it; a guild the bot is added
  to outside the OAuth flow, with no matching install row, is logged and ignored
  (G3) — there is no default tenant;
- DMs are dropped (decision #4, G4).

*Tests:* a full OAuth round trip against real Postgres producing a tokenless
install pointed at an inert bridge; a second tenant claiming an already-installed
guild refused by `uq_messaging_installs_workspace`; a removal marking the install
inactive; an out-of-band join ignored.

**Stage 4 — the shared connection, the adapter split and the four guards**
(Slack's "route inbound events" commit — and the largest, riskiest piece).
Slack routes inbound over HTTP through `install_routes`; Discord has no webhook,
so the equivalent routing lives inside a new deployment-level Gateway client:

- **Split the single-guild `DiscordAdapter`** into a *connection owner* (the
  `discord.Client` socket, `wait_until_ready`, reconnection — including where
  re-identify and global command re-sync live, which today happen only once at
  first ready — the bot user id, and global command registration) and *per-guild
  logic* (the `BridgeCore` room map, posting through per-channel webhooks, slash
  dispatch, and the per-guild role state — `_agent_role_ids` and the
  `_agent_roles_off_reason` latch — re-keyed by guild id, since a role lives in
  one guild). The channel→room map already lives in `BridgeCore` keyed by the
  globally-unique channel id, so that layer is not guild-coupled and helps.
- **A deployment-level `DiscordGatewayClient` singleton**, started at boot when
  the Discord app is configured, holding the bot token from config and binding
  no tenant. On each `MESSAGE_CREATE` / `INTERACTION_CREATE` it reads the guild
  id, resolves the tenant, re-reads the install scoped to it, and dispatches
  into that guild's per-guild logic. **Ownership needs no new machinery**
  (decision #1): it starts alongside `collab_lifecycle.start_all()` in the boot
  sequence and stops next to `collab_lifecycle.stop_all()`, living in the one
  switch-core pod like every other bridge — the forced singleton means there is
  never a second owner. `DISCORD_APP_*` rides the existing `switch.coreEnv`
  secret; no new Helm deployment or process is introduced.
- **Route resolution through the existing service, not a new caller.**
  `tenant_of_messaging_install` is a row-level-security exemption whose callers
  are a closed set — `test_only_the_allowed_modules_reach_the_exemption` fails
  unless the calling module is in `_ALLOWED_MODULES` (and any raw-session caller
  in `_RAW_SESSION_FACTORY_MODULES`). Reusing `MessagingInstallService.resolve`
  keeps the caller inside the module already on that list and inherits the scoped
  re-read for free; a brand-new caller would have to be added to the allowlist
  deliberately. The spike does not mention this.
- **Dispatch with `no_tenant()`.** Each handler binds the tenant of the room it
  acts on, matching Slack's `deliver` path — `dispatch_event` is designed to run
  unbound. The architecture prose's "binds that tenant ... and dispatches"
  should be read as this, not as binding held across the whole dispatch.
- **Global command registration** (decision #7), once for the application.

The four isolation guards land here, each with a test that fails without it:
per-event scoping in its own task, the binding reset on exit and on exception,
nothing cached on the connection (G1); every user- and puppet-keyed record keyed
by (tenant, Discord user id) (G2); no default tenant, an unmapped or inactive
guild dropped (G3); no guild-less routing, a DM dropped before routing and DM
intents not requested (G4).

**Phase 2 — self-serve and operator surface**: a customer-facing entry point
that establishes the tenant without an operator's session; the callback becoming
a redirect where there is somewhere to send people; and the operator's bridge
list distinguishing a shared-connection install from a self-registered bridge,
with revoke and status.

## Open questions the stages surface

- **Connection ownership — resolved, with a note.** One bot token forces one
  Gateway connection, which for the distributed Slack app was the reason it went
  to webhooks (a single socket cannot be shared across replicas). Here it is not
  an open question: switch-core is a forced singleton (decision #1), so the one
  pod is the one owner and no leader election is needed. The only residual is a
  *future* one — if switch-core is ever made horizontally scalable, the four
  in-memory buses would move out of the process first, and this connection would
  then need the same leader-election treatment as any other in-memory-stateful
  component. Until then, nothing to decide.
- **Credential blast radius (unchanged residual risk).** One bot token controls
  the bot in every tenant's guild; its compromise is a cross-tenant breach. Kept
  in deployment secrets, rotatable, monitored — this, not connection ownership,
  is the design's dominant residual risk (see Security).
- **When to seek verification / turn on message content** (decision #5): the
  first version runs mention-only (flag off) and needs no verification; full
  message content needs Discord's review, and the ~100-guild threshold counts
  across all tenants, so the question is *when* to start verification, not
  whether the mechanism works without it.

## Testing

The cross-cutting test is the one the isolation story rests on: against real
PostgreSQL under the restricted role, with two tenants installed into two
guilds, driving the real shared Gateway client and asserting each event reaches
one tenant's rooms and no part of it reaches the other's. Beyond that and the
per-stage tests above — the installer's unit tests, the inherited state, claim
and round-trip tests, and the doc-vs-code comparison — each guard has a test
that fails without it: interleaved events from two guilds with no bleed and a
scope that resets after a handler raises (G1); one Discord user in two guilds
yielding two scoped records (G2); an event for an unmapped or inactive guild
dropped (G3); a guild-less event dropped (G4); and a wrong lookup answer turning
into a scoped miss rather than a cross-tenant read.

## What is missing

- **No Discord app is registered.** Nothing here is reachable until one is,
  activated for public distribution, and configured with the credentials above.
- **The public origin is the deployment's**, joined to the callback path; only
  that path needs to be publicly reachable, which is a change to the deployment's
  ingress path allowlist (deployment-specific, outside this repository).
- **Verification for the message-content intent** is required past ~100 guilds
  (counted across all tenants). The first version runs mention-only (the intent
  flag off, decision #5) and does not need it; full message content does, and
  that review should be started early.
- **Direct messages are unsupported** and dropped.
- **The adapter split is the largest piece of work** and the main schedule risk.
  If it or verification proves too costly, an interaction-only variant — slash
  commands over an HTTP interactions endpoint, no Gateway and no message content
  — remains available as a smaller first step, at the cost of not reading
  ordinary messages.
