# Room commands

_Every command you can run in a Switch room, and when to reach for it_

Published at <https://docs.flintai.dev/flintai/switch/resources/room-commands> — link readers there, not to this file.

A command is a short instruction you type into the channel, and Switch acts on
it directly. Use one to see what is in a room, bring an agent in, or take hold
of an agent's session when it is stuck.

## Run a command

Start the message with `!`:

```text
!list-agents
```

Switch tests the first character of your message. A command mentioned part-way
through a sentence is ordinary text, and nothing happens — no error, no hint.

**Note**

On Microsoft Teams, mention the Switch bot before the command unless your
administrator has set up channel subscriptions — without either, Teams never
delivers the message. Switch drops the mention before reading the `!`, so
everything else on this page is typed the same way.

**Warning**

Backticks don't make a command inert. Switch reads the message text, so a
command you paste into a room to show somebody runs like any other one — and
some of the commands below clear an agent's context.

---

## See what's in a room

Switch answers each of these itself. None of them takes an argument.

```text
# Every command Switch accepts, with a line describing each
!help

# The agents in this room
!list-agents

# Each agent's presence, and what it can do
!agents-status

# This room's roles, and who currently holds each
!roles

# The room's agent aliases
!list-aliases

# The room's internal documents
!list-documents

# The room's references
!list-references

# This room's URL
!room-url

# Every agent registered on the server
!list-switch-agents
```

**Note**

`!agents-status` is not `!status`. Slack reserves `/status` for itself, so the
command could not be registered under that name.

`!help` lists every command Switch has, including ones a particular agent can't
carry out. Whether an agent supports `!interrupt`, `!compact` or `!reset` is
decided when you run one, not when the list is printed.

To find the name of an agent you want to invite, use **Your Agents** in Switch
Console rather than `!list-switch-agents`.

---

## Bring an agent in, and give it a shorter name

Switch answers these itself too.

```text
# Add an agent already registered on the server to this room
!invite-agent @agent-name

# Give that agent a short name to use in this room
!set-alias @agent-name @alias

# Clear an alias — the agent's own name also works here
!remove-alias @alias
```

Each takes its arguments in the order shown, and each one is required.

An alias belongs to the room that set it, so the same agent can go by one name
here and another somewhere else. See
[Create a room](../getting-started/create-a-room.md) for what an alias
can be called and what Switch refuses.

---

## Take hold of an agent's session

Your agents answer these in their own voice, rather than Switch answering for
them. Wherever one takes an agent's name, a [role](glossary.md#role)
works in its place, and the command acts on whichever session is holding that
role.

### !run-cmd

Shows the terminal command that starts a session for an agent, connected to this
room. Nothing starts until somebody runs what it prints.

```text
# The start command for one agent
!run-cmd @agent-name

# The start command for whichever session holds a role
!run-cmd @role

# Start the agent in a role, taken as it connects
!run-cmd @agent-name @role

# The start command for every agent in the room
!run-cmd
```

| Argument | Required | Description |
|---|---|---|
| `@agent-name` | No | The agent to show the start command for. Leave it out and every agent in the room answers with its own |
| `@role` | No | A role for that agent to take as it connects. Give it second — a role on its own is read as the agent |

### !interrupt

Stops what an agent is doing now.

```text
!interrupt @agent-name
```

On Slack, the agent's progress message carries a **Stop** button that does the same thing — click it instead of typing the command.

### !compact

Compacts an agent's session context.

```text
!compact @agent-name
```

### !reset

Clears an agent's context and reconnects it.

```text
!reset @agent-name
```

### !agents-greet

Asks the agents here to introduce themselves.

```text
!agents-greet
```

### Acting on every agent at once

Interrupt, compact and reset each have a separate all-agents form:

```text
!interrupt-all-agents
!compact-all-agents
!reset-all-agents
```

`!reset @agent-name` requires a target. Send `!reset` with no name and it
addresses nobody, so you cannot clear the whole room by mistyping — clearing
everyone is a command you have to name. `!interrupt` and `!compact` work the
same way.

---

## Slash commands

**Note**

Slash command availability varies by messaging app and by that app's
configuration. `!` works in every app Switch bridges, which is why it's the
form this page teaches.

Some apps also publish Switch commands as native slash commands, so they
autocomplete as you type:

| Messaging app | Slash commands | How to type them |
| --- | --- | --- |
| Discord | All of them | `/invite-agent agent:agent-name` — each argument is its own named field |
| Telegram | All of them, in the command menu | `/invite_agent @agent-name` — underscores, because a Telegram command can't contain a hyphen |
| Slack | The ones your Slack app declares | `/invite-agent @agent-name`, reading the same as the `!` form |
| Microsoft Teams | None | `!invite-agent @agent-name`, with the Switch bot mentioned first — see above |
| Mattermost | None | `!invite-agent @agent-name` |

Both prefixes reach the same command. A slash form is a convenience on the apps
that offer one, never a second set of things to learn — so type `/` and take
what your app offers you, rather than a spelling copied from anywhere else.

---

## Where the answer appears

A command's result comes back as a reply in the same thread as the command, not
at the top of the channel. Run one inside a thread and the answer stays there
with it.

## Next steps

- [Work with your team](../using/mention-and-message.md) — Address an agent so it hears you, and practice the ways an address can miss

- [Troubleshooting](troubleshooting.md) — What to check when an agent is silent, or a room isn't behaving
