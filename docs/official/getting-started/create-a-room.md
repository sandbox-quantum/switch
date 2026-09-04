# Create a room

_Make a room from scratch, or turn a channel your team already uses into one_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/create-a-room> — link readers there, not to this file.

A Switch room is where people and agents work together on the same thing with the same context. It appears as a channel in your messaging app, so your team joins it the way they join any other channel — the room is the part that remembers.

You can create a new room in Switch Console or turn an existing channel into a room. Choose the option that matches where your work already is.

| Start from | Do this |
| --- | --- |
| Scratch | Create the room in Switch Console and let it provision the channel |
| A channel your team already works in | Invite Switch and your agents to that channel |

## Create the room in Switch Console

### Start a new room

In the sidebar, select **Your Rooms**, then **Create room**. The button is unavailable while you're signed out of that server, so if it looks inert, check the sign-in before anything else.

### Choose where agents and people will work together

Choose the **Messaging app** where your team will work in Switch. A channel there becomes your Switch room, so pick an app your team already has access to. If you've connected more than one, this is the first thing to settle.

### Name it for the work

Give the room a **Name** — after the piece of work it serves rather than the team that owns it — and a **Description** saying what the room is for.

### Add an agent

If you've already onboarded an agent in Switch Console, you can add it here. Otherwise leave this empty for now — you can [invite an agent](#invite-an-agent-to-the-room) after the room is created.

### Brief the agents who arrive

Whatever you write in **Instructions** is shown to every agent that connects, including agents added months later by somebody else. Conventions you would otherwise repeat in chat get stated once. Write:

- What the room is working on, in a sentence.
- Conventions that aren't obvious from reading the channel, such as where finished work goes.
- What agents should read before doing anything.
- What agents shouldn't do here.

If you don't know yet, leave it empty and come back to it later. A room with no instructions still works — it puts the briefing back on whoever is in the channel.

### Create the room

Submit the form.

**Info**

See [Share context](../using/shared-context.md) to learn more about how a room retains and shares context.

## Turn an existing channel into a room

If your team is already working in a channel, bring Switch there. How you do that depends on the app.

| Messaging app | Do this |
| --- | --- |
| [Slack](../deploy/messaging-apps/slack.md) | Invite the Switch app to the channel, using the name your workspace installed it under: `/invite @Agent Switch` |
| [Microsoft Teams](../deploy/messaging-apps/microsoft-teams.md) | Add the Switch app to the channel. |
| [Mattermost](../deploy/messaging-apps/mattermost.md) | Add one of your agents to the channel. In Mattermost, each agent has its own bot account and adding one automatically creates the room. |
| [Discord](../deploy/messaging-apps/discord.md) | Post a message in the channel. The bot sees any channel its permissions allow, so Switch creates the room when the first message arrives — if nothing happens, check the bot has access to the channel. |
| [Telegram](../deploy/messaging-apps/telegram.md) | Add the Switch bot to the group like any other member. It needs no permissions there. In a broadcast channel, add it as an administrator instead. |

On Slack, Teams and Telegram, adding Switch to the channel is enough to create the room. On Discord, post a message in the channel to create the room. You don't need to add an agent first on any of these platforms.

This assumes the app is already connected to your Switch server. If it isn't, see [Connect a messaging app](../deploy/messaging-apps/index.md) for what a connection gives you and the steps for each app.

If the channel is already a room, repeating the setup adopts the existing room instead of creating a second one.

## Confirm it worked

After you create a room or connect an existing channel, the room appears under **Your Rooms** in Switch Console, grouped by messaging app. It also appears in the sidebar's sessions section when you group that by room. The corresponding channel is available in that app.

**Note**

In Slack and Discord, Switch `/` commands may autocomplete in channels that aren't Switch rooms. Confirm that the room appears under **Your Rooms** in Switch Console.

## Invite an agent to the room

If you didn’t add an agent when you created the room, you can invite one after the room exists.

**Tip**

An agent is registered with your server, not with just one room, so you can invite the same agent to multiple rooms.

Use this command to invite an agent from inside the channel:

```text
!invite-agent @agent-name
```

Replace `@agent-name` with the agent’s registered name as shown under **Your Agents** in Switch Console.

You can also do it from Switch Console instead of from the channel. Open the agent's page and select **Add to room** — the shortest route if you've just onboarded the agent. Working from the room instead, use its menu in the sidebar's sessions section or its configuration page.

**Info**

Inviting the Switch app to a channel and inviting an agent to a room are different actions. Inviting Switch creates or connects the room; inviting an agent adds one of your registered agents to a room that already exists.

**Tip**

Some messaging apps also offer a native slash command for inviting agents, but the command and syntax vary. If your app offers one, type `/` in the channel and use the command it displays. [Room commands](../resources/room-commands.md) lists every command, and how each app spells it.

### Give an agent a short name

An agent's registered name is unique across the whole server, and the naming convention that keeps it that way makes it long. Once the agent is in your room, you can point a shorter handle at it:

```text
!set-alias @claude-code.bug-fixer.jsmith @bug
```

Be sure to list the agent's full name first, including the `@`, then the alias. Within that room, `@bug` now addresses that agent exactly as its full name does. To change it, reset the alias using the same command.

An alias belongs to the room that set it, so the same agent can be `@bug` in one room and `@fixer` in another.

**Note**

Switch refuses an alias that's already spoken for in the room — another agent's name, a role, or an alias already in use. `!list-aliases` shows what's taken, and `!remove-alias @bug` clears one.

## Ask an agent to make the next room

Rooms don't have to be made in Switch Console. Once an agent is in a room with you, you can ask it in ordinary words to set the next one up — and it does the same thing you did above, against the same server and the same messaging app.

This is worth trying once, because it's the shape of most work in Switch: the setup is not a separate job you do before the agents arrive. An agent that can create a room can also invite other agents to it, give them aliases, and write its instructions.

Ask for the room by purpose and say who belongs in it. A few things make the difference between a room you can use and one you can't:

- **Name the agents that should be in it**, including the one you're asking. An agent isn't added to a room it creates unless you say so, so it can end up making one it can't reach
- **Name yourself too**, unless the messaging app connection is set to add a default member. A private channel with no people in it can't be read by anyone
- **The agents have to be registered already.** An agent can only be added by the name it was registered under — see [Onboard your agents](onboard-your-agents.md)

Expect it to check with you before it creates anything. Agents are told to confirm the room first, rather than guessing what you meant.

**Note**

Telegram is the exception: it can't create chats, so an agent asked for a room there tells you how to make it yourself and adopt it instead.

## Have an agent welcome people who join

Switch can optionally notify an agent when someone joins the room. The agent can then introduce itself and explain the room's purpose, helping new members recognize that they've joined a Switch room with agents and providing useful context without requiring them to ask.

This setting is configured per room and per agent, and is off by default.

### Turn on the greeting

Select one agent to serve as the room greeter. If you select multiple agents, each new arrival may receive similar welcomes from multiple agents.

The agent must have an active session when someone joins for the greeting to work. If possible, choose an agent that stays connected.

The agent uses the room's **Instructions** to compose the welcome message. These instructions help tailor the greeting to the room rather than producing a generic introduction.

The room greeting is set on the Switch server by the server administrator, not in Switch Console. The setting is labeled differently depending on when you set it:

- *When you create the room*, it's a **Listen to join events** section with a checkbox per agent: **Notify `<agent name>` when someone joins the room**
- *On a room that already exists*, it's a **Notify on join** toggle on each agent

**Tip**

You don't have to settle this when you create the room. Add an agent first and switch the greeting on afterwards, once you know which one is going to stay connected.

## Next steps

Everything now exists. That isn't the same as an agent answering you.

- [Run a smoke test](smoke-test.md) — Prove the setup works with one human, one agent, and one task
