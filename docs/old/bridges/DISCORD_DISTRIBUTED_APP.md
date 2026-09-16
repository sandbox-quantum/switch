# The distributed Discord app

`DISCORD_SETUP.md` describes the app **an operator registers for themselves**:
they create it, add its bot to their own server with a token they hold, and
paste that token into Switch. This page describes the other one — the app **we**
register and distribute, which a customer installs by clicking **Add to Server**
and which never requires them to see a token at all.

They are two separate Discord applications and they will both exist. Nothing
here replaces the other page.

The install connects a Discord server (**guild**) to a tenant that **already
exists**. Creating a tenant is Switch Console's job and is not reachable from
Discord: the flow begins with an authenticated admin inside the tenant they are
installing into, so no amount of clicking in Discord brings a tenant into being.

## Why it cannot be the same app

The self-registered app opens its **own** Gateway connection, scoped to one
guild, using a bot token the operator holds. That is the right shape for a
self-hosted operator and the wrong shape here, because a distributed app has no
per-customer token to open a per-customer connection with:

- **Discord grants one bot token per application, not one per install.** Adding
  the bot to a guild returns the *guild* (so we learn its id) and nothing we
  need to keep — there is no per-guild credential to capture or store. The bot
  authenticates to every guild with the single application bot token.
- **One bot token means one connection.** A connection opened with that token
  receives every installing guild's events; it cannot be subscribed to one
  tenant's guilds. So a single connection **multiplexes every tenant's
  traffic**, and each inbound event is routed to a tenant by the `guild_id` it
  carries. That is not a choice — with one bot token it is the only shape.

So the delivery mechanism is the *same* as the self-registered app — an outbound
Gateway WebSocket, no inbound webhook — but the distributed app runs **one
shared connection for all tenants** instead of one per guild, and asks the
customer for nothing. Everything below follows from that.

## The one public URL

Discord delivers both messages and interactions over the Gateway, so unlike the
distributed Slack app there is **no events endpoint, no interactions endpoint,
and no request signature to verify**. The only route that must be reachable from
the internet is the **OAuth callback**:

| Discord Developer Portal setting | Path |
| --- | --- |
| **OAuth2 → Redirects** | `/messaging/discord/oauth/callback` |

The host is **`MESSAGING_PUBLIC_URL`**: scheme and host, no path, https only,
and the origin Discord itself sends the browser back to.

It is deliberately not `GATEWAY_PUBLIC_URL`. That one is the host a *person*
lands on following an "Open in Switch Console" deeplink, and on many deployments
it is reachable only over a private network — which is fine for a person and
useless as an OAuth redirect. Pointing it at an internet-facing host to satisfy
Discord would move every deeplink to that host as a side effect, so the two are
separate settings and a deployment may set either, both, or neither.

`/messaging` is a public prefix in its own right: it is unauthenticated by
nature, because an OAuth callback arrives before there is anything to
authenticate against. It is deliberately not `/gateway` — that prefix is
cookie-authenticated and is not routed to this application from the outside — and
deliberately not `/oauth`, which already belongs to agents authenticating *to*
Switch and would collide in name only, confusingly.

Reaching it from the internet needs the prefix added in two places: the
application's own public-path list, and the deployment's ingress path allowlist.

## Registering the app

Unlike Slack, Discord verifies no Request URL on save (there is none), so the
app can be created and its credentials collected before the callback endpoint is
live. The callback only has to be reachable by the time a customer installs.

1. [Discord Developer Portal](https://discord.com/developers/applications) →
   **New Application**, in an account we control. Name it (e.g. "Agent Switch").
2. **General Information → Application ID.** This is `DISCORD_APP_APPLICATION_ID`.
3. **OAuth2 → Client ID and Client Secret.** These are
   `DISCORD_APP_CLIENT_ID` and `DISCORD_APP_CLIENT_SECRET`, and are what exchange
   an install code for the guild the app was added to. Add the redirect URL from
   the table above under **OAuth2 → Redirects** — Discord compares it byte for
   byte against the one the install flow sends, so a trailing slash on one side
   is a refused install with a message that does not say so.
4. **Bot → Token.** This is `DISCORD_APP_BOT_TOKEN`. There is exactly one, it
   belongs to the application rather than to any install, and it is deployment
   configuration — it is never stored per install and never revoked when a
   customer disconnects.
5. **Installation → Activate public distribution.** This is what makes the app
   installable outside our own account and produces the *Add to Server* URL. For
   a private test guild you can skip it and install with the URL directly.

There is no slash-command step in the portal: the distributed app registers its
commands **globally**, once for the application, from code at boot (see below).

## The contract this app requests

The *Add to Server* URL asks for two OAuth scopes and a single least-privilege
permission integer, and sends the browser back to the callback. These three
values are the promise the running system has to keep: the scopes it requests
are the scopes the code asks for, the permission integer is the one the code
pins, and the redirect is the path this application serves. Nothing checks them
at runtime — Discord simply refuses a redirect that does not match, and a
permission the code needs but the URL never asked for surfaces as a customer's
bot silently unable to do its job.

So they are pinned in code and here, and a test compares the two. Substitute the
host in `redirect_uri`; `permissions` is a decimal bitfield and is exact.

```json
{
    "scopes": ["bot", "applications.commands"],
    "permissions": "275683314768",
    "redirect_uri": "https://HOST/messaging/discord/oauth/callback"
}
```

`applications.commands` is what lets Switch register its in-room commands as
native Discord slash commands. The permission integer is the sum of exactly the
bits the adapter uses, and nothing more:

| Permission | Bit | Why the adapter needs it |
| --- | --- | --- |
| View Channels | `1 << 10` | See the channels in the guild. |
| Send Messages | `1 << 11` | Post agent replies. |
| Send Messages in Threads | `1 << 38` | Reply inside a thread. |
| Manage Webhooks | `1 << 29` | Mint the per-channel webhook agents post under — without it agents cannot appear under their own names. |
| Manage Channels | `1 << 4` | Provision access to a channel (`set_permissions`, private-room creation). |
| Manage Roles | `1 << 28` | Give each agent a mentionable role so its name completes when you type `@`. |
| Read Message History | `1 << 16` | Reply in context within a thread. |
| Attach Files | `1 << 15` | Relay agent attachments. |
| Add Reactions | `1 << 6` | Mark the message an agent is working on. |

Slash commands need no permission bit — they come from the `applications.commands`
scope. Editing and deleting the bot's own webhook messages needs no Manage
Messages. If you build the URL by hand in **OAuth2 → URL Generator**, selecting
these boxes produces the same integer.

## Three things left out on purpose

**The Message Content intent.** Reading arbitrary message text is a *privileged*
gateway intent, and requesting it while unapproved does not degrade gracefully —
Discord closes the whole connection with code 4014. So the intent is requested
conditionally, controlled by `DISCORD_APP_MESSAGE_CONTENT` and **defaulting
off**. Off, the connection opens fine and content still arrives for the cases the
intent is not needed for — messages that mention the bot and the bot's own
messages — which is exactly mention-only operation. On (once approved), agents
see all message content. Verification is *per application*, not per tenant, and
its ~100-guild threshold counts the total guilds across **every** tenant, so in
the distributed model the app crosses it quickly and verification is worth
starting early rather than deferring.

**Direct messages.** A Discord DM carries no guild id, so it cannot be
attributed to a tenant. DM events are dropped explicitly — never silently — and
the shared connection does not request DM message intents. Attributing a DM (for
example by the sender's single shared installed guild) is deferred, and would
still have to refuse the ambiguous case of a user present in two tenants' guilds.

**Per-guild slash commands.** The self-registered app registers its commands
per guild, because each of its bridges is scoped to one guild. The distributed
app registers them **globally**, once for the application, and routes each
invocation by the guild id it carries — there is no per-install registration
step and no registration traffic that grows with the number of guilds. The cost
is that a command-set change takes minutes to propagate rather than applying
immediately.

## What a customer's install produces

One row in `messaging_installs`: the guild it was installed into (as
`external_workspace_id`), a **null** `encrypted_bot_token` — a Discord install
stores no credential, because the bot token is deployment configuration and not
this install's to hold — the scopes Discord approved, and the tenant and user
who initiated it. `(platform, external_workspace_id)` is unique across the whole
deployment, because an inbound event carries a guild id and no tenant — a guild
claimed by two tenants would be an event with two possible destinations. A
second tenant attempting to claim an already-installed guild is refused by the
database.

Disconnecting ends that row and detaches its rooms, but **revokes no token**:
the credential is the application's, shared by every install, and is never ended
on one customer's disconnect.
