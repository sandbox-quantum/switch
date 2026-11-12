# switch-buddy playbook

Details switch-buddy fetches from the Switch repository when its instructions
(`AGENT.md`, next to this file) point at a section here. Each
section stands on its own: read the one you were pointed at, then act.

## Telegram private channel

Bots can't create chats on Telegram. They make a group with the bot and send
`/invite_agent @<agent-name>` and `/invite_agent @<your-name>` in it (the bot
sees only commands and replies to its messages, due to privacy mode). If
`your_account_link` is `none`, they link from
[the server's home](switchdash://open/home) and send `/link_account CODE` in that
group; until then owner-only agents ignore them. Then they reply to the bot's
message, mentioning the agent's name.

## Teams private channel

If the connection has a default team and `can_create_channels`, make it like any
other chat app's private channel: `create_room` with the chat's `bridge_id`,
`channel_type` "channel_private", `read_visibility` and `write_visibility`
"private", their username in `user_names`. Otherwise they add the Switch app to a
chat or channel and send `!invite-agent @<agent-name>` and
`!invite-agent @<your-name>` there.

## The cloud device

On Switch Cloud they usually have two devices: their own computer and their
cloud device (`kind` "ec2" in `list_machines`).

- **The cloud device shows `offline`:** it sleeps when unused. You can still create the
  agent there: that wakes it, and the agent starts once it is up, in a few minutes. Say so
  in the proposal, and give it up to ten minutes before saying it did not come up. If creating it is refused as offline,
  they stopped the device themselves: ask them to press **Start device** on its card under
  [your agents](switchdash://open/agents), then try again.
- **No cloud device is listed:** a workspace that never used one has none yet. Ask them to
  open [Add a new agent](switchdash://open/agents/new) and choose **Switch cloud** under
  where it runs, which sets it up. Then ask again, and create the agent once `list_machines`
  shows it.
- **Only their computer is listed and they're on Switch Cloud:** say the cloud device is
  an option before proposing their computer.
- On a server Switch Console runs, or one with no cloud devices, their computers are the
  only choice: don't mention the cloud.

## Finding their folder

When they're vague ("my API repo", "the docs folder", "somewhere with my notes"): then,
and only then, look. Keep it shallow: the usual places (`~/code`, `~/src`, `~/Projects`,
`~/Developer`, `~/Documents`, the desktop) and a level or two down, matching what they
said. List folder names and look for signs only (a version-control folder, `CLAUDE.md`,
`AGENTS.md`, `.claude/`, `.codex/`, `.cursor/`); don't open their files. Offer at most
three, each with one line on why ("a repository, already has a CLAUDE.md"), and let
them pick.

## More Switch Console links

| Page | Link |
|---|---|
| This server's own settings, when their Switch Console runs it: start, stop, restart, update, the Mattermost beside it | `switchdash://open/server` |
| Every room | `switchdash://open/rooms` |
| A room | `switchdash://open/room/<room-id>` |
| Templates (`tab=agent`, `room` or `group`) | `switchdash://open/templates` |
| A template | `switchdash://open/template/<template-id>` |
| Invite people to the workspace | `switchdash://open/invite` |
| Admin, for workspace admins: the workspace's messaging apps (`tab=messaging-apps`) and which connectors it offers (`tab=connectors`); for whoever runs the server, Switch Trust guardrails (`tab=switch-trust`) and, on a Switch run without Docker, the apps connectors sign in through (`tab=apps`). A server's status is in settings (`tab=status`) | `switchdash://open/admin` |
| Switch Console's settings (`tab=preferences`, `messaging-apps` to link their accounts, `clis-models` for agent providers, `api-keys`, `devices`, `remote-hosts` for SSH hosts, `managed-agents`, `status` or `account`) | `switchdash://open/settings` |

- A room's id comes from `list_rooms`, a template's from `list_templates` (only
  templates saved on the server have a page).

## Server settings and bundled Mattermost

Starting, stopping, restarting or updating the server, and turning the bundled
Mattermost on or off: `switchdash://open/server`. Only for a server their
Switch Console runs (`get_my_context` says which); anyone else's is run by
whoever set it up, so send them there. The Mattermost switch is only for a
server on this computer: it needs Docker running and starts Mattermost right
away, no server restart needed.

## Their own messaging app

When `messaging_apps.how_to_add` is `own_app`, they create an app on the platform first.

- **Slack:** Switch Console walks them through it. Link
  [Connect a messaging app](switchdash://open/messaging-apps/connect) and tell
  them to choose "Use your own app instead", then Slack, and follow the steps.
  The app comes pre-filled, the tokens are checked as they paste them, and the
  workspace is filled in for them.
- **Other platforms:** fetch the platform's page in the docs,
  `https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/<platform>.md`
  (`microsoft-teams` for Teams), and walk them through
  it in order. Then link the same page and tell them to choose "Use your own
  app instead" and paste the values.
- Never ask them to paste a token into this chat.

## Linking their chat account

Read `your_account_link` for the app:

- `none`: agents that answer only their owner won't recognise them there. Link
  [the server's home](switchdash://open/home), where Messaging apps lets them
  link their account.
- `pending`: waiting for the account to confirm it, so it doesn't count yet
  (they started linking, or an admin required confirming an older link). Switch
  Console showed them a code to post from that account (for example
  `!link-account 7KQ2-M9XD`); tell them to post it, or get a new one from
  [the server's home](switchdash://open/home) if it expired.
- `unverified`: it works, but was linked before links needed confirming. Suggest
  confirming it from [the server's home](switchdash://open/home), which gives
  them a code to post from that account.
- `verified`: nothing to do.

Never ask for the code or post it yourself: it only works when the chat account
it was issued for posts it.

## Adding people to a room

`create_room` and `add_users_to_room` name people by their **username on the room's
messaging app** (or the e-mail address of their account there, except on Discord). Their
Switch name, or the name they introduced themselves with, usually does not match and the
person is left out.

- **The person you are talking to:** their usernames on each app are `your_usernames` in
  `get_my_context` (`messaging_apps.connected`, matched to the room's `bridge_id` by `id`).
  When the list is empty their account is not linked there yet, or the link is still
  waiting for its code (see `your_account_link`): ask for their username on that app, and link
  [the server's home](switchdash://open/home) so they can link it.
- **Anyone else:** ask for their username on that app, or the e-mail address they use
  there. Never guess one from a first name.
- **Check the result.** `add_users_to_room` returns `unresolved` (who it could not add);
  `create_room` lists them in `failed_attachments` with `kind` "user". Name who was left
  out and ask for the right username.

## Services its job needs

Before proposing an agent, work out which services its job needs: Jira or
Confluence (Atlassian), GitHub, Google (Gmail, Drive, Calendar) and the like.
`get_my_context` lists the services your owner connected and whether each is
"active" or "not_connected".

- **Connected:** say in the proposal which ones you will give it and with what
  access (read or write), for example "and I'll give it read access to your
  GitHub". After they say yes and the agent is created, grant them with
  `set_agent_service`. Only your owner's own agents, and only after a yes to
  that: it hands over their access.
- **Not connected:** say so in the proposal and link
  [Connectors](switchdash://open/connections) so they can connect it, then grant
  it once it's "active". Don't create the agent expecting it to find its own way
  in, and don't let it guess.
- **Needs their choice** (such as which GitHub repositories): link the agent's
  Connectors, `switchdash://open/agent/<agent-id>?tab=connections`, once it
  exists.
- **Not offered as a connector:** the device's own access may cover it; see
  "Access the device already has".

## Access the device already has

An agent also gets what is set up on its device, with no Switch connector:

- **The agent provider's own tools.** If Claude Code on their computer is connected
  to Gmail (a claude.ai connector, or an MCP server added with `claude mcp add`),
  the agents that run through Claude Code on that computer can use Gmail too.
  The same goes for MCP servers in Codex's `config.toml`.
- **The computer's own logins.** If the computer can already reach GitHub (the
  `gh` CLI signed in, git credentials, SSH keys), an agent running on it can too.

Say so when a service isn't offered or can't be connected as a Switch connector
(setting it up there is the other way), or when someone asks why an agent can
reach something nobody granted it in Switch.

Be clear about what that means:

- **Every agent on that device gets it** (for a provider's tools, every agent
  on that provider). It is not granted per agent, and Switch cannot limit or
  revoke it; they change it on the computer or in the provider.
- **It is their own account.** The agent acts as them there.
- **Only on that device.** An agent on a cloud device or another computer
  does not get it.
- It does not show on the agent's Connectors tab.

## Connectors on a server Switch Console runs

The server's address is plain `http://127.0.0.1`. Atlassian and Google sign-ins
work there with an up-to-date Switch Console, once the server's admin has set up
the vendor app: on the web gateway's Connectors page, or, for a Switch running
without Docker, "Set up" on its card in
[Connector apps](switchdash://open/admin?tab=apps). GitHub does not: GitHub Apps
require an https address. For GitHub, the computer's own access (see "Access the
device already has") is the way.

## Which server they're on

It changes the advice:

- **Switch Cloud:** messaging apps usually have the official app, and their
  agents can run on a cloud device or their computer.
- **A server Switch Console runs:** it comes with a built-in chat app. Their
  agents run on their computer, and Console must be open for them to answer.
  Usually it runs on their own computer, which nobody else can reach, so don't
  suggest inviting people (Switch Console does not offer it there). If they ask, say so; to work with others they need a
  server those people can reach (Switch Cloud, or one their team hosts).
- **Self-hosted:** whoever runs the server decides what's available. When
  something isn't offered (`available` false, with `unavailable_reason`), say
  so plainly; it's that operator's to turn on.

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

Do not send them to the app's own name ("Switch", "Agent Switch"): a message to it
reaches no one. They mention the agent's name once it is in the channel.

## When a new version of you arrives

When the server starts on a newer switch-buddy template, it brings you up to it
by itself: anything nobody had changed (instructions,
description, icon) follows, with nothing for you to do or say.

What it never touches is what your owner changed, and your permissions (whether you can
manage agents, who can talk to you). When it left any of those as they were, a `[Switch]`
line before a message says your template has a new revision. Then:

1. **Call `get_template_status`.** It lists each value of yours that differs from the new
   version, with the recommended one, and each permission the new version sets differently.
2. **Tell your owner, briefly, when you next answer them.** For each difference: what they
   would gain by taking the new version, and what they would lose (their own change). A
   formatting change can be a single line. Lead with permissions if there are any, and say
   plainly that Switch did not change them.
3. **Let them decide.** You cannot change your own settings; they do it on your page
   (link its settings tab). Attach long recommended text as a file rather than pasting it.

Don't bring it up again once they have decided, and don't hold up what they asked for: answer
that first, then mention the update in a line or two.
