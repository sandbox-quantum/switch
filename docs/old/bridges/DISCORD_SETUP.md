# Discord collaboration bridge setup

Connects a Discord server (**guild**) to Switch. A **single bot application**
backs every Switch agent; per-agent presentation is done with **per-channel
webhooks** (Discord webhooks accept a per-message username and avatar), the
username carrying the agent's display name or its identifier when it has none.
Inbound events arrive over an outbound **Gateway WebSocket** scoped to the
configured guild, so **no public ingress is required**; outbound goes through
the REST API.

Rooms are provisioned **lazily**: Discord has no "app invited to channel" signal
(the bot sees every channel its permissions allow), so a channel's Switch room is
created on the first bridged message rather than eagerly for the whole guild.

## Prerequisites

- A Discord server (guild) where you can add a bot and manage channels.
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the Discord application + bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**. Name it (e.g. "Agent Switch").
2. Open the **Bot** tab. The bot is created with the app; copy its **token** —
   this is the `bot_token`. (Reset the token if you need a fresh one.)

## 2. Enable privileged gateway intents

The adapter requests these gateway intents: `guilds`, `guild_messages`,
`dm_messages`, `message_content`, `members`. Two of these are **privileged** and
must be toggled on under **Bot → Privileged Gateway Intents**:

- **Message Content Intent** — required to read message text.
- **Server Members Intent** — required for member lookups and per-channel
  membership grants.

(For a bot in 100+ servers these require Discord verification; a
single-workspace deployment does not.)

## 3. Invite the bot with the right permissions

Build an OAuth2 invite URL (Developer Portal → **OAuth2 → URL Generator**):

- **Scopes:** `bot` **and `applications.commands`**. The second one lets the
  bridge register Switch's in-room commands as native slash commands (see
  [Slash commands](#slash-commands)). Without it the bridge still runs, but the
  slash sync fails at startup — logged, not fatal — and only `!`-prefixed
  commands work.
- **Bot permissions** (matching what the adapter does):
  - **View Channels** — see the guild's channels.
  - **Send Messages** + **Send Messages in Threads** — post agent replies.
  - **Manage Webhooks** — mint the per-channel webhook agents post through.
  - **Manage Channels** / **Manage Roles** — set per-member channel permission
    overwrites (`channel.set_permissions`) when provisioning access, and mint
    the per-agent role that makes an agent's name autocomplete (see [Agent name
    autocomplete](#agent-name-autocomplete-agent_roles)).
  - **Read Message History** — thread-aware replies.
  - **Attach Files** — relay agent image attachments.
  - **Add Reactions** — put 👀 on the message an agent is working on (see
    [Knowing an agent is working](#knowing-an-agent-is-working)).

Open the generated URL and add the bot to your server.

## 4. Get the guild id

Enable **Developer Mode** in Discord (User Settings → Advanced), then right-click
the server icon → **Copy Server ID**. This is the `guild_id`.

## 5. Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Register messaging app → Discord**, give it a display name (e.g. "Acme
Discord"), and fill in the fields below.

Fields (`DiscordConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot token from the Developer Portal. |
| `guild_id` | yes | The Discord server (guild) id the bridge is scoped to. |
| `agent_roles` | no (default on) | Give each agent a mentionable role so its name autocompletes. See below. |

On success the bridge opens its Gateway WebSocket to that guild. Post in a
channel the bot can see (or have an agent post) and the Switch room is created on
the first bridged message.

## Agent name autocomplete (`agent_roles`)

An agent is not a Discord member — one bot serves all of them, differentiated
per message by a webhook override — so by default nothing Discord knows about
carries an agent's name and typing `@` never offers one. With this on, each
agent gets a **mentionable role named exactly after its identifier** — the
lowercase name, not the agent's display name — so `@flint-tracker` completes in
the composer and arrives as a real pill. The role is empty and carries no
permissions: mentioning it notifies nobody, and Switch resolves the mention back
to the agent's name on the way in.

Roles are provisioned for every existing agent when the bridge starts, and for
each new agent as it registers. Two limits are worth knowing before you turn it
on:

- **Discord caps a server at 250 roles, hard.** A server that hits the cap gets
  one warning naming it, and the bridge stops trying — agents stay addressable
  by typing their name.
- **A role carries no metadata**, so there is nowhere to record that a role
  belongs to Switch. An agent's role is therefore the one whose name matches the
  agent's **identifier** exactly — never its display name, so a role made under
  a display name belongs to no agent and autocompletes nothing. Two
  consequences: a role you created by hand for an agent is adopted rather than
  duplicated (which is how to use this on a server where the bot may not manage
  roles), and when an agent is deleted its role is only deleted if **nobody
  holds it** — one with members is left in place, and the bridge says so.

Renaming an agent leaves its old role behind; delete it by hand.

Turn it off (`agent_roles: false`) on a server that is near the role cap or
where role management is restricted.

## Knowing an agent is working

When a Switch Console-managed agent starts on a message, two things appear:

- **👀 on the message it is answering**, removed when its turn ends. This is the
  only signal that says *which* message is being handled — an agent answering
  two people at once marks both, and clears both together. It needs the **Add
  Reactions** permission; without it the bridge logs a warning and posts no
  reaction rather than a mark that is not there.
- **A "⚙️ Working on it…" message** posted under the agent's own name and
  avatar, edited in place as the activity changes and deleted when the turn
  ends.

**What Discord cannot do here.** There is no native progress surface — nothing
like Slack's agent card — so the working message is one Switch renders itself.
The typing indicator is not usable as a real indicator either: it expires after
about 10 seconds, has no "stop" call, and shows the *bot* rather than the agent,
so with two agents working it would read as one anonymous "Switch Bridge is
typing". Discord's "thinking…" placeholder is interaction-only (slash commands),
which does not cover an ordinary `@agent` message.

## Slash commands

Switch's in-room commands are also registered as native Discord slash commands,
so `/reset @agent` does exactly what typing `!reset @agent` does — same
handler, same result. Nothing to configure beyond the `applications.commands`
scope above: the set is published from the command registry when the bridge
starts, and re-published on every start, so renames and removals reconcile
themselves.

Two things behave differently from a typed `!command`, both from Discord:

- **Arguments are declared fields, not free text.** Discord shows named inputs
  (`/set-alias agent: … alias: …`) and will not submit until the required ones
  are filled. The `@` is optional — `worker` and `@worker` are equivalent. An
  argument that is not a single name is rejected rather than silently truncated
  at the first space.
- **The result arrives in a thread.** A slash invocation is invisible to the
  channel, so the bridge posts a short `⚙️ Running …` message and files the
  command's result in that message's thread. If a command fails, that message is
  rewritten into the error — a slash command never silently does nothing.

Commands are registered **per guild**, not globally: each bridge is scoped to one
guild, guild-scoped commands apply immediately (global registration propagates
for up to an hour), and because global commands are per-*application* they would
otherwise appear in every guild the bot has joined, including ones with no Switch
rooms.

If the slash commands do not appear, check the bridge's startup logs for a sync
failure — the usual cause is a bot invited before `applications.commands` was
added to its OAuth2 scopes. Re-inviting with the corrected URL and restarting the
bridge fixes it.

## Clickable "Open in Switch Console" links (`GATEWAY_PUBLIC_URL`)

Discord only linkifies `http(s)`, so a raw `switchdash://session?…` deeplink
renders as plain text; the bridge logs a warning at startup when it is running
without this set. Set **`GATEWAY_PUBLIC_URL`** on switch-core to the Switch
API's public origin — scheme + host only, **no path** — the same host Switch Console
reports as its `server` (distinct from the operator UI):

```dotenv
# .env / deployment env
GATEWAY_PUBLIC_URL=https://switch-api.acme.com
```

When set, Switch rewrites the deeplink to a clickable
`https://<switch-api-host>/deeplink/session?…` link (a page that hands off to
the `switchdash://` scheme) at runtime-state ingestion — so both the bridged
working/awaiting-input status message **and** the `!agents-status` command surface a
clickable link, on every platform at once. When unset, the raw `switchdash://`
link is posted as before (disclosed fallback).

The value is validated at startup: it must be scheme + host only. A URL carrying
a path is rejected, because the redirect is served at `/deeplink/session` on the
API root (the agent-bridge app, **not** under the `/gateway` mount) and a path
prefix would build links that 404. Front `GATEWAY_PUBLIC_URL` with a proxy that
routes the API root, not only `/gateway/*`.

## Notes

- **Room icon.** Switch Console shows a Discord icon for Discord-channel rooms
  (`discord.svg`, keyed to `bridge_type` `"discord"`).
- **Outbound images.** Agents can relay images into Discord — the adapter
  uploads the bytes through the channel webhook under the agent's username/avatar
  (with the caption as the message). HTTP failures fall back to a disclosed text
  notice so nothing is silently dropped.
- **DMs.** In a DM channel the file posts as the bot with the agent name inlined.
