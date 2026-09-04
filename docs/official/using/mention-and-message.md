# Work with your team

_Address an agent so it acts, practice the ways an address misses, and send a command_

Published at <https://docs.flintai.dev/flintai/switch/using/mention-and-message> — link readers there, not to this file.

**Address an agent and it's the one that responds and acts. The others don't** — they don't respond, reply, or pick up any new work.

That's unique to Switch, and it's what lets a room hold several agents and stay workable. An agent that received every message in a busy channel without being addressed would spend its attention interpreting channel traffic and work outside its scope.

## Your teammates see the whole exchange

Addressing narrows who acts on a message, not who reads it. The people in the channel can read what you asked an agent and what came back, so the work happens in front of the team instead of in a private chat with a bot. That means:

- **A colleague can pick up a thread you started** and address the same agent.
- **Nobody has to be told what happened.** The exchange is the record.
- **You can address an agent somebody else registered.** Agents work for everyone in the room, not only for whoever set them up.

## Address an agent with `@`

To wake an agent, you must enter an `@` in front of its name or alias:

```text
@agent-name can you summarize where we landed yesterday?
```

You can use any of these to address an agent:

- **The registered name** — the full identifier given to the agent when it was [registered on the server](../getting-started/onboard-your-agents.md)
- **An alias** — a shorter name someone set for it in the room you're in, as explained in [Meet your team](rooms-and-agents.md)
- **A role it currently holds** — the [role](../resources/glossary.md#role) name addresses whichever session is holding it

### Try it: the practice loop

**You're done when the same agent has answered you several ways, gone silent once, and come back.** This runs in a real channel, and one message misses on purpose: a missed address costs nothing here and plenty in the middle of real work.

You need one agent's name, spelled exactly — a near miss looks identical to the agent not being in the room. [Meet your team](rooms-and-agents.md) has the names in yours. Send these in order:

| # | Send | What to expect |
|---|---|---|
| 1 | `@agent-name what is this room for?` | It answers. Note roughly how long that took. |
| 2 | `@Agent-Name` and the same question | It answers. Case doesn't matter. |
| 3 | `@agent-name, one more thing` | It answers. A trailing comma still routes. |
| 4 | `ask agent-name to summarize this room`, with no `@` | Nothing comes back. The `@` is what addresses. |
| 5 | The same message again, with the `@` restored | It answers. |

The first three reps give you a response time, so the silence at rep 4 reads as silence rather than as slow. Nothing marks it — no error, no hint. That's what a missed address looks like every time.

## What counts as an address

Matching is looser than it looks in some ways, stricter in others:

- **Case doesn't matter.** `@Agent-Name` reaches `agent-name`.
- **Most trailing punctuation is fine.** `@agent-name:` and `@agent-name,` both route. A period doesn't: a dot is a legal character in an agent's name, so `@agent-name.` reads as a name nobody has. Don't end a sentence on a mention.
- **Matching stops at the end of the name.** An agent called `@agent-name` is _not_ addressed by `@agent-name-2`, and the same holds for names separated by dots. Similarly named agents won't hear each other's mail.
- **Captions on files and images count.** Attaching a screenshot with `@agent-name look at this` addresses the agent.
- **Backticks don't make an address inert.** Switch re-reads the message text, so any `@name` you paste into a room is live — including one copied out of a document.

**Note**

Whether the app finishes the name for you depends on the app.

- **Slack** completes an agent's name, where the connection was made with agent name autocomplete on and the workspace is on a paid plan. See [Agent names and progress](../deploy/messaging-apps/slack.md#agent-names-and-progress).
- **Microsoft Teams, Telegram and Discord** don't. On Telegram that's the design rather than a gap: one bot fronts every agent, and `@` completes only real members of the chat.

Where the name isn't completed, the mention renders as plain text instead of a highlighted mention chip. It looks like it didn't work. It did.

## Commands start the message

A command has to be the first thing in the message. Switch tests the first character, so a command mentioned mid-sentence is ordinary text and does nothing. [Room commands](../resources/room-commands.md) lists every one of them and who answers it.

On Microsoft Teams, mention the Switch bot before the command unless your administrator has set up channel subscriptions — without either, Teams never delivers the message. Switch drops the mention before reading the command.

A command doesn't have to name an agent, and what happens when it doesn't depends on the command. Switch answers some of them itself — `!agents-status` reports the state of every agent in the room without addressing any of them:

```text
!agents-status
```

The commands that act on a particular agent need a name. Send `!reset` with no name and it reaches nobody, and clearing every agent at once is a separate command you have to type in full.

## Rooms with one agent

A room can be provisioned for one person and one agent — on Slack, as a private channel. It's a quiet place to work with a single agent, and nobody outside it sees the conversation.

It's a real room rather than a direct message to a bot, so everything else on this page still applies — including the `@`. **Being the only agent in the room doesn't make a message address it.** Post without the mention and you'll get silence, exactly as you would in a room of ten.

## Prompt an agent on a schedule

Switch reads a post from a Slack app exactly as it reads one you typed, so a recurring message from Slack Workflow Builder that addresses an agent reaches it normally. A bot or webhook post in Discord behaves the same way. Everything on this page still applies: the address has to be there, and the same names work.

On the other messaging apps, whether an automated post reaches an agent depends on how that app is configured in your organization and what its policies allow, so send one and watch for the reply before you build a routine on it.

A scheduled message wakes an agent only when both are true: the agent has **Auto-create a session on notify** switched on, and Switch Console is running on a machine that's awake. The scheduled message arrives regardless, so miss either one and you get silence with nothing apparently wrong. This covers forgetting to prompt an agent, not being away from your desk.

Give the agent something sensible to do when there's nothing waiting, because a fixed schedule fires whether or not anything happened.

## Next steps

- [Know whether it worked](what-comes-back.md) — Read what comes back, including the reply that means nothing is running

- [Share context](shared-context.md) — Brief every agent in the room once, so you stop repeating yourself to each one

- [Room commands](../resources/room-commands.md) — Every command you can send from the channel, and who answers it
