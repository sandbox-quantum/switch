---
name: switch-buddy-channels
description: Setting up messaging apps (Slack, Discord, Teams, Telegram, Mattermost), Telegram and Teams private channels, linking chat accounts, adding people to rooms, and putting an agent in a channel.
---

# Messaging apps, channels & people

Take them through setup **one step at a time**: one step per message, with its link, then
stop and wait. **Offer only what you can do** (linking accounts, connecting apps, and
inviting people are done by the person). **Only workspace admins** connect messaging apps
and invite people: if `person.workspace_admin` is false, say so and offer to draft a
message to an admin.

## Connecting a messaging app

First look in `messaging_apps.connected` (`get_my_context`): an app listed there is
already connected, so say so and help them use it; never walk them through setting it up
again. Only for an app not connected, look the platform up in `messaging_apps.how_to_add`:
- `official_app`: one step. Link
  [Connect a messaging app](switchdash://open/messaging-apps/connect), where they pick the
  platform and add the Switch app. No tokens to copy.
- `own_app`: they create an app on the platform first (see "Their own messaging app"
  below). Never ask them to paste a token into this chat.

## Their own messaging app

When `messaging_apps.how_to_add` is `own_app`:
- **Slack:** Switch Console walks them through it. Link
  [Connect a messaging app](switchdash://open/messaging-apps/connect) and tell them to
  pick Slack under Messaging app and follow the steps. The app comes pre-filled, the
  tokens are checked as they paste them, and the workspace is filled in for them.
- **Other platforms:** fetch the platform's page in the docs,
  `https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/<platform>.md`
  (`microsoft-teams` for Teams), and walk them through it in order. Then link the same
  page and tell them to pick the platform under Messaging app and paste the values.
- Never ask them to paste a token into this chat.

## Linking their chat account

Read `your_account_link` for the app:
- `none`: agents that answer only their owner won't recognise them there. Link
  [Messaging apps in Settings](switchdash://open/settings?tab=messaging-apps), where they
  link their account.
- `pending`: waiting for the account to confirm it, so it doesn't count yet (they started
  linking, or an admin required confirming an older link). Switch Console showed them a
  code to post from that account (for example `!link-account 7KQ2-M9XD`); tell them to
  post it, or get a new one from
  [Messaging apps in Settings](switchdash://open/settings?tab=messaging-apps) if it expired.
- `unverified`: it works, but was linked before links needed confirming. Suggest
  confirming it from
  [Messaging apps in Settings](switchdash://open/settings?tab=messaging-apps), which gives
  them a code to post from that account.
- `verified`: nothing to do.

Never ask for the code or post it yourself: it only works when the chat account it was
issued for posts it.

## Telegram private channel

Bots can't create chats on Telegram. They make a group with the bot. With the bot's Group
Privacy on (BotFather's default) it sees only commands and replies to its own messages;
they can turn it off in BotFather (`/setprivacy`, Disable) before adding the bot, or, if
it is already in, remove it and add it back or make it an admin. Linking comes first: if
`your_account_link` is `none`, they link from
[Messaging apps in Settings](switchdash://open/settings?tab=messaging-apps) and send
`/link_account CODE` to the bot, in its private chat or in that group, since
`/invite_agent` is refused and owner-only agents ignore them until then. Then they send
`/invite_agent @<agent-name>` and `/invite_agent @<your-name>` in it, and talk to an agent
by mentioning its name or replying to its message. Only where the bridge has said in that
group that it can see just the messages that tag it do they need to reply to the bot's
message: Telegram delivers nothing else there. Don't say it otherwise.

## Teams private channel

If the connection has a default team and `can_create_channels`, make it like any other
messaging app's private channel: `create_room` with the chat's `bridge_id`,
`channel_type` "channel_private", `read_visibility` and `write_visibility` "private",
their username in `user_names`. Otherwise they add the Switch app to a chat or channel and
send `!invite-agent @<agent-name>` and `!invite-agent @<your-name>` there.

## Adding people to a room

`create_room` and `add_users_to_room` name people by their **username on the room's
messaging app** (or the e-mail address of their account there, except on Discord). Their
Switch name, or the name they introduced themselves with, usually does not match and the
person is left out.

- **The person you are talking to:** their usernames on each app are `your_usernames` in
  `get_my_context` (`messaging_apps.connected`, matched to the room's `bridge_id` by
  `id`). When the list is empty their account is not linked there yet, or the link is
  still waiting for its code (see `your_account_link`): ask for their username on that app,
  and link [Messaging apps in Settings](switchdash://open/settings?tab=messaging-apps) so
  they can link it.
- **Anyone else:** ask for their username on that app, or the e-mail address they use
  there. Never guess one from a first name.
- **Check the result.** `add_users_to_room` returns `unresolved` (who it could not add);
  `create_room` lists them in `failed_attachments` with `kind` "user". Name who was left
  out and ask for the right username.

## Putting an agent in a channel

Two steps, in this order, one message each:
1. **Add the Switch app to the channel** (on Slack: mention the app there and accept the
   invite, or add it from the channel's settings). Once in, the app posts that it linked
   the channel to a Switch room and how to add an agent. No such message means it is not
   linked yet: check the app was added to that channel, on the workspace connected to
   Switch.
2. **Invite the agent** by typing, in the channel, `/invite-agent @agent-name` or
   `!invite-agent @agent-name`, with the agent's exact name (from `list_agents`, for
   example `!invite-agent @switch-buddy-max`). The name is part of the command: typing
   `!invite-agent` alone only gets the usage line back. The `@` suggestion list may not
   offer the agent (on Slack's free plan it does not): type the full name by hand.

Do not send them to the Switch app itself, whatever it is called there ("Switch Rooms",
"Agent Switch", "Switch Rooms (dev)"): a message to it reaches no one. They mention the
agent's name once it is in the channel.
