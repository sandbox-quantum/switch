# Slack collaboration bridge setup

Connects a Slack workspace to Switch. A **single Slack app** (one bot) backs
every Switch agent; per-agent presentation is done with per-message username +
avatar overrides. Inbound events arrive over **Socket Mode** — an outbound
WebSocket the bot opens to Slack — so **no public ingress is required**. Outbound
messages go through the Slack Web API.

## Prerequisites

- A Slack workspace where you can install a custom app (workspace admin approval
  may be required).
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the Slack app

You need one Slack app for the whole bridge. There are two ways to create it —
**the manifest path is strongly recommended**, it is far less error-prone.

### Recommended: from an app manifest

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest**.
2. Select the target workspace.
3. Paste the manifest below and create the app. It pre-configures the bot token
   scopes, all of Switch's `/…` slash commands, Socket Mode, event subscriptions,
   interactivity, and the app home in one step — so you can skip the manual scope
   and event setup entirely.

<details>
<summary><strong>Agent Switch app manifest</strong> (paste this)</summary>

```json
{
    "display_information": {
        "name": "Agent Switch"
    },
    "features": {
        "app_home": {
            "home_tab_enabled": true,
            "messages_tab_enabled": false,
            "messages_tab_read_only_enabled": false
        },
        "bot_user": {
            "display_name": "Agent Switch",
            "always_online": false
        },
        "agent_view": {
            "agent_description": "Switch agents. Mention one by name in a channel and it answers there; its progress appears on the message while it works."
        },
        "slash_commands": [
            { "command": "/admin", "description": "Toggle admin mode on/off for this room", "should_escape": false },
            { "command": "/help", "description": "Show the list of available in-room commands", "should_escape": false },
            { "command": "/reset", "description": "Reset a targeted agent's session (clears context, then reconnects)", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/reset-all-agents", "description": "Reset EVERY agent's session in this room", "should_escape": false },
            { "command": "/compact", "description": "Compact a targeted agent's session context", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/compact-all-agents", "description": "Compact EVERY agent's session context in this room", "should_escape": false },
            { "command": "/interrupt", "description": "Interrupt a targeted agent's current turn", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/interrupt-all-agents", "description": "Interrupt EVERY agent's current turn in this room", "should_escape": false },
            { "command": "/agents-status", "description": "Show each agent's presence and capabilities in this room", "should_escape": false },
            { "command": "/roles", "description": "List this room's roles and who currently holds each", "should_escape": false },
            { "command": "/list-agents", "description": "List the agents available in this room", "should_escape": false },
            { "command": "/list-switch-agents", "description": "List all agents registered on the Switch", "should_escape": false },
            { "command": "/list-documents", "description": "List the room's internal documents", "should_escape": false },
            { "command": "/list-references", "description": "List the room's references", "should_escape": false },
            { "command": "/list-aliases", "description": "List per-room agent aliases (@alias to agent)", "should_escape": false },
            { "command": "/set-alias", "description": "Give an agent a room alias", "usage_hint": "@agent-name @alias", "should_escape": true },
            { "command": "/remove-alias", "description": "Remove a room alias", "usage_hint": "@alias (or @agent-name)", "should_escape": true },
            { "command": "/invite-agent", "description": "Add an existing agent to this room", "usage_hint": "@agent-name", "should_escape": true },
            { "command": "/run-cmd", "description": "Show the terminal command to start a session for an agent", "usage_hint": "@agent-name [@role]", "should_escape": true },
            { "command": "/agents-greet", "description": "Have agents in the room introduce themselves", "should_escape": false },
            { "command": "/room-url", "description": "Show the frontend URL for this room", "should_escape": false }
        ]
    },
    "oauth_config": {
        "scopes": {
            "bot": [
                "files:read",
                "files:write",
                "assistant:write",
                "channels:history",
                "channels:manage",
                "channels:read",
                "chat:write",
                "chat:write.customize",
                "commands",
                "groups:history",
                "groups:read",
                "groups:write",
                "im:history",
                "im:read",
                "im:write",
                "mpim:history",
                "reactions:read",
                "reactions:write",
                "users:read",
                "usergroups:read",
                "usergroups:write"
            ]
        },
        "pkce_enabled": false
    },
    "settings": {
        "event_subscriptions": {
            "bot_events": [
                "message.channels",
                "message.groups",
                "message.im",
                "message.mpim"
            ]
        },
        "interactivity": {
            "is_enabled": true
        },
        "org_deploy_enabled": false,
        "socket_mode_enabled": true,
        "token_rotation_enabled": false,
        "is_mcp_enabled": false
    }
}
```

</details>

Then continue with [Generate tokens and install](#2-generate-tokens-and-install).

### Alternative: from scratch (manual)

1. **Create New App → From scratch**, name it (e.g. "Agent Switch"), and pick the
   workspace.
2. Configure the **bot token scopes**, **event subscriptions**, **slash
   commands**, and enable **Socket Mode** + **interactivity** by hand — see the
   [App configuration reference](#app-configuration-reference) below for the exact
   values (they mirror the manifest).

## 2. Generate tokens and install

Regardless of how you created the app:

1. **App-level token (Socket Mode).** Under **Basic Information → App-Level
   Tokens**, generate a token with the `connections:write` scope — this is the
   `app_token` (`xapp-…`). (Socket Mode is already enabled by the manifest; on the
   from-scratch path, enable it under **Settings → Socket Mode** first.)
2. **Install to workspace.** **Install App** → copy the **Bot User OAuth Token**
   (`xoxb-…`) — this is the `bot_token`.
3. **Workspace id.** Note the workspace/team id (`T…`) — this is `workspace_id`
   (Workspace → Settings, or from any message link).
4. **Invite the app** to the channels you want bridged (`/invite @Agent Switch`).
   The bridge provisions a Switch room when the app joins a channel.

## 3. Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Register messaging app → Slack**, give it a display name (e.g. "Acme
Slack"), and fill in the fields below.

Fields (`SlackConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot User OAuth token (`xoxb-…`) — outbound Web API. |
| `app_token` | yes | App-level token (`xapp-…`, `connections:write`) — Socket Mode. |
| `workspace_id` | yes | Slack workspace/team id (`T…`). |

On save the bridge starts its Socket Mode session immediately. Add the app to a
channel (or create a bridged room) to start relaying.

## App configuration reference

The manifest above already sets all of this — this section is for the
from-scratch path and as a reference for what the app needs.

### Bot token scopes

Under **OAuth & Permissions → Scopes → Bot Token Scopes**:

- `chat:write`, `chat:write.customize` — post agent messages, with the
  per-message username + avatar override each agent is presented under. The
  username carries the agent's display name, or its identifier when it has
  none.
- `commands` — the `/…` slash commands.
- `channels:read`, `channels:manage` — look up, create, set topic on, and invite
  into public channels; `groups:read`, `groups:write` — the same for private
  channels.
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — read
  channel / DM / group-DM message history for context.
- `im:read`, `im:write` — direct messages.
- `users:read` — resolve user display names.
- `files:read`, `files:write` — relay attachments (incl. agent image uploads).
- `reactions:read`, `reactions:write` — reaction-based acknowledgements, and
  the 👀 that marks the message an agent is working on.
- `assistant:write` — declares the app an Agent, which is what lets it open the
  session its progress card lives in. Slack adds this scope itself when the
  Agents feature is switched on.
- `usergroups:read`, `usergroups:write` — the per-agent user groups that make
  agent names autocomplete. See below.

### Declaring the app an Agent (`agent_view`)

The manifest's `features.agent_view` is what makes the app an **Agent**, and
only an Agent app may open the sessions the progress card is drawn in. Without
it, the calls are refused and turns fall back to a status message Switch posts
itself — everything still works, it just looks like a bot rather than part of
Slack.

⚠️ **Two consequences, and neither can be walked back.** Enabling the Agents
feature **removes access to the app for workspace guests**, and turns every DM
with it into a thread. The switch from the older `assistant_view` to
`agent_view` is **irreversible**, and a distributed app needs re-review. Decide
deliberately; a workspace with external collaborators as guests loses them.

On the from-scratch path this is the **Agents** toggle in the app's settings
rather than a scope you tick.

### Agent name autocomplete (`agent_usergroups`)

**On by default.** Every agent gets a Slack **user group** whose handle is the
agent's identifier — the lowercase name a mention has to use, never the agent's
display name. Set `agent_usergroups: false` in the bridge's connection config to
turn it off.

This is a workaround and worth naming as one: Slack offers no way to make an
app's agents mentionable, so Switch borrows the one mentionable object an app
can create and uses it as a name. Turning `agent_usergroups` off is a
reasonable choice for a workspace that does not want a group per agent.

Slack autocompletes only things it knows about, and an agent is not a Slack
user — one app serves all of them, so a typed `@agent-name` is just text that
happens to start with `@`. There is no completion, no pill, and a typo is
indistinguishable from an agent ignoring you. A user group is the one handle an
app can mint that still appears in the composer's `@` menu, so each agent gets
one and its name completes like a person's.

The groups are created empty and stay empty: they exist to be completable, and
mentioning one notifies nobody. Switch recognises its own groups by a marker on
their description and ignores the workspace's own.

**Groups made by hand are adopted.** Where a workspace will not let the bot
create them, making them manually is the only way to use the feature — so a
group whose **handle or name is exactly an agent's identifier** is taken to be
that agent's, and the marker is stamped on it. The match is exact, so a
workspace group is never captured by an agent that happens to be named
similarly. It is also against the identifier and nothing else: a group made
under an agent's **display name** matches no agent, is left alone, and leaves
that agent without autocomplete.

Two things gate it, both outside Switch:

- **A paid plan.** User groups do not exist on Slack's free tier.
- **Permission to manage user groups.** Most workspaces restrict this to admins,
  and the bot token is refused until an admin widens it under
  *Workspace settings → Roles & permissions → Account types → "Create and edit
  user groups"*.

A workspace missing either is a normal case, not a misconfiguration: the bridge
logs **one** warning naming the cause and what it costs, then runs without user
groups. Agents stay addressable by typing their name, exactly as before — you
lose the autocomplete, nothing else. It does not retry per agent or repeat the
warning on every startup.

**Several workspaces in one org.** A bot token lists only its own workspace's
user groups, so each bridge mints its own group per agent and knows only those
ids. An Enterprise Grid composer does not respect that boundary — it offers a
sibling workspace's group as well, so a mention can arrive at one bridge naming
a group only another one created. Slack has no call that resolves a user group
by id, so the bridges pool what they mint and read each other's, which is what
keeps an agent taggable from either workspace. It follows that both workspaces
must be bridged to the **same** Switch server; two servers cannot see each
other's groups, and a mention that crossed between them stays unresolved.

### Native session status (`agent_sessions`)

**On by default.** A turn opens a Slack **agent session** and streams its
progress into the client's own live card, under the agent's name and icon,
carrying the link back to the session in Switch Console.

**The card replaces the status message Switch used to post**, rather than
sitting beside it — two indicators for one turn said the same thing twice.
Where a card cannot be opened, the posted message is still the fallback, so a
turn always shows its progress somewhere.

A session exists because a **stream** is opened for it — setting a session's
status without one is accepted by Slack and renders nothing at all. So each
turn opens a stream, pushes a step whenever the agent's activity changes, and
closes it at the end.

Switch does **not** set the session *status*. It renders as a second card
attributed to the app rather than the agent, with Slack's own generic wording
and no way to rename it. Slack's native stop button hangs off that status, so
it is not offered either.

Streaming into a channel has to name the person being replied to and their
team. The person comes from the message that started the thread; the team from
the app's own identity, which on an Enterprise Grid org is **not** the
configured workspace id (that is the org). A thread Switch never saw a question
on gets no card, and falls back to the posted message.

The card is a progress indicator, not a record: it is removed when the turn
ends, the way the posted status message always was. An agent working on two
messages at once has a card and a mark on each, and both are cleared together
when its turn finishes.

Separately, and needing nothing but the reaction scopes: the message that asked
is marked with **👀** for the duration of the turn — the message itself, not the
thread it sits in. That works at the channel root as well as in a thread, so it
is the one progress signal that is always available.

The stop button is wired to the same interrupt an operator can type, so
pressing it stops the agent whose turn it is. Setting `agent_sessions: false`
turns the whole thing off.

**Sessions only work if the Slack app is declared an Agent** (the Agents
feature in the app's settings, which brings `assistant:write` with it). The
default being on only means "use this where the app has it" — it does not make
that change for you. Until it is made, the first call is refused, the bridge
logs one warning naming the reason, and turns carry on showing Switch's own
status messages.

Think before enabling the Agents feature in Slack: it **removes access to the
app for workspace guests**, turns every DM with it into a thread, and **cannot
be reverted**.

### Running without a paid Slack plan

Two of the features above lean on things a Slack workspace may not have, and
each has its own switch on the bridge connection. Both default to on.

- **`agent_usergroups`** needs a **paid plan** — user groups do not exist on the
  free tier — and an admin willing to let the bot manage them.
- **`agent_sessions`** needs the app to be declared an **Agent**. Slack
  documents that some AI features require a paid plan without saying which, so
  treat the plan question there as answered by trying it: a refusal names its
  own cause.

**Neither has to be switched off to be safe.** A refusal is caught, reported
once with what would fix it, and the feature is dropped for the life of the
process — it is not retried per turn and nothing else is affected. Setting them
to `false` on a workspace that cannot host them simply skips the attempt and
the warning.

What a workspace still gets with both off:

- Agents are addressed by typing `@agent-name`, exactly as before. What is lost
  is the autocomplete, not the addressing.
- An agent's progress appears as a status message posted under its own name and
  icon, carrying the **Open in Switch Console** link.
- The message being worked on is marked with **👀** for the turn. That needs
  only the reaction scopes, so it works on any plan and in any channel.

### Turning it on for an existing bridge

`PATCH /collaborations/{bridge_id}` accepts `connection_config`, merged over the
stored one — so you change a setting without re-sending the platform's tokens:

```json
{ "connection_config": { "agent_usergroups": true } }
```

The bridge restarts to pick it up, and provisioning at startup covers every
agent that already exists. There is no separate migration step.

Provisioning runs **in the background**: it is one Slack call per agent against
a rate limit of roughly 20/minute, so a few hundred agents take minutes. The
bridge is online and relaying throughout, and agents stay addressable by typed
name while their groups are still being made — autocomplete is what arrives
late, nothing else. Watch the per-group log lines for progress.

The session's own trace lines are at debug level: enough to follow a turn end
to end when something does not render, and out of the way when it does.

### Event subscriptions (over Socket Mode)

Subscribe the **bot** to (no request URL is needed with Socket Mode):

- `message.channels`, `message.groups`, `message.im`, `message.mpim` — inbound
  messages in public/private channels, DMs, and group DMs.

A message that tags the app itself is recognised from these `message.*` events
(the bridge detects its own bot mention inline), so a separate `app_mention`
subscription is not required.

### Interactivity and slash commands

Enable **Interactivity** and add the `/…` slash commands (the full set is in the
manifest) so Switch's in-room commands work from Slack.

## Notes

- **Deeplinks.** Slack linkifies `http(s)`, so "Open in Switch Console" links work
  once `GATEWAY_PUBLIC_URL` is set on switch-core (see the
  [index](README.md#deployment-knobs)); otherwise the raw `switchdash://` link is
  posted.
- **Local dev.** There is no local Slack — Slack always points at a real
  workspace onboarded through the gateway. (Local dev seeds only Mattermost.)
