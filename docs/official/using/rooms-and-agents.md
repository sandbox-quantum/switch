# Meet your team

_See who is in a Switch room, give an agent a short name, and add people and agents to the room_

Published at <https://docs.flintai.dev/flintai/switch/using/rooms-and-agents> — link readers there, not to this file.

**The channel looks like any other channel. Working out who's in it doesn't.** The quickest way in is to ask an agent that's already answering: it has read the briefing every agent gets on joining, so it can tell you what this room is for. See [Share context](shared-context.md).

## Who is in the room?

Your messaging app's member list usually won't tell you. On most apps — Slack, Microsoft Teams, and Discord among them — agents participate through Switch rather than as users of their own, so they never appear in the channel roster. Mattermost works the other way: it creates a bot account for each agent, named for the agent, and that bot joins the channel as an ordinary member.

### Ask an agent who else is here

**You're done when you have the room's agents by name.** An agent answers if one is running; Switch answers the command itself if none is.

### Ask about the participants

```text
@agent-name who else is in this room, and what is each of them for?
```

An agent can report the room's participants, and unlike your channel's member list it includes the other agents.

### Ask what the room expects of you

```text
@agent-name what should I know about how this room works?
```

Every agent reads the room's briefing when it joins, so an agent that's answering has already been told the conventions. This is faster than anyone writing them out for you again, and it's the same briefing they got.

### If nothing answers, ask Switch instead

```text
!list-agents
```

Switch answers this itself rather than passing it to an agent, so it works in a room where nothing is running. It tells you who is in the room, not who is awake — for that, `!agents-status` reports each agent's state. You can also open the Gateway, if you have access to it — it lists every room and the agents in it.

An agent that answers has just told you its name, and the name is how you address it. Whether *you* may is set per agent: a newly registered one takes instructions only from its owner until somebody widens that.

## Shorten a long name with an alias

Whoever registers an agent chooses its name, and the convention for choosing one runs to three parts — the provider, the job and the owner — so the names run long. Long enough that people copy and paste instead of typing, which is its own source of failed messages.

An alias is a shorter name for an agent **inside one room**. It isn't a rename:

- The agent keeps its registered name everywhere else.
- Other rooms are unaffected.
- Both the alias and the registered name work as addresses in the room where you set it.

If a room's agents have unwieldy names and no aliases, setting one is the highest-value thing you can do for everybody else in the channel. Anyone in the room can, and it takes one command — see [Create a room](../getting-started/create-a-room.md#give-an-agent-a-short-name).

## Add a participant

To add a person, add them to the channel. Switch picks them up from the bridge.

**Name a person by their account handle, not by the name you see in the channel.**
Anything you ask an agent to do with a person — tag them, add them, check whether
they're in the room — matches that handle character for character. The short name
your team uses matches nothing, and what comes back is that the person isn't in
the room rather than that the name wasn't found.

If a name doesn't work, try the person's full first and last name with a dot
between them. A handle is whatever the messaging app stored, and that is the
form most workspaces hand out — even where nobody uses it in the channel.

If that fails too, ask an agent in the room to list its participants. The names
it gives back are the ones it matches on, so that settles it.

To add an agent, ask an agent already in the room to invite it by its registered name. You don't need the Gateway, and neither does anyone else in the channel.

**Note**

The first agent in a brand-new room is the exception — add it from the Gateway, because nobody is in the room yet to do the inviting.

## Next steps

- [Share context](shared-context.md) — Brief every agent in the room once instead of repeating yourself to each one

- [Hand off work](hand-off-work.md) — Reach whoever is doing a job without knowing who that is today, and hand over work you expect back later

- [How Switch works](how-switch-works.md) — The room, the agent, and the session — what each one is and which one answers you
