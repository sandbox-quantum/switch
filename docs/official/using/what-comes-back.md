# Know whether it worked

_Read what comes back — an answer, an unavailable reply, silence, or a refusal — and know what each one means_

Published at <https://docs.flintai.dev/flintai/switch/using/what-comes-back> — link readers there, not to this file.

import SwitchCommandForm from '/snippets/switch-command-form.mdx';

What comes back from an agent varies, and the differences carry information rather than noise. The agent is the name in the room; a session is a running copy of it on somebody's machine, and everything on this page is that copy — or its absence — reporting on itself. When one of those reports doesn't make sense, [How Switch works](how-switch-works.md) is where the model behind it is set out.

## What can come back

Address an agent and one of three things happens. Naming which one you got is the whole skill on this page: **a reply and an unavailable notice both mean the address landed**, and silence means it didn't.

**It answers.** The address worked and a session is running behind the agent. This is the case everything else on this page assumes.

**A reply says the agent isn't available.** The address worked here too — Switch answered on the agent's behalf because nothing is running behind it. The reply names what has to happen next and who has to do it, and often carries the exact command that fixes it.

**Nothing at all.** Your message reached nobody. The `@` is missing, the name is misspelled, or you replied in a thread without repeating the address.

Only the third is a failure, and it's the one that arrives without an error, a warning, or any hint that something went wrong. Get used to reading silence as a missed address rather than as an agent ignoring you.

## Try it: is anything listening?

**You're done when you can say, for each agent in the room, whether anything is running behind it.**

```text
!agents-status
```

Switch answers this one itself, so it works in a room where nothing is awake. You get a line per agent: 🟢 live, ⚪ no session, 🔴 disconnected, or 🟡 awaiting a manual poll.

Read it against what just happened to you. A ⚪ beside the agent you addressed is the explanation for an unavailable reply — there is nothing running to answer you. A 🟢 beside an agent that stayed silent means the opposite, and points at the address rather than the agent.

**A ⚪ usually means somebody's machine went to sleep.** A session lasts while the program behind it keeps running and keeps checking in, so closing a terminal or shutting a laptop ends one within seconds — which is why an agent that answered you this morning can be grey now, with nothing broken and nobody at fault.

A short network drop is the exception: a session that reconnects quickly keeps its place and carries on. If an agent came back on its own, that's what happened.

## Read an unavailable reply

Address an agent with no session attending the room and Switch answers on its behalf. The reply tells you what has to happen next, and who has to do it.

Nothing you do in the channel needs an installation. Running an agent does, and that happens on somebody's own machine — which is why so many of these replies end by naming a person rather than something you can fix from here.

**Where there's a command that would fix it, the reply carries one.** For the agent providers with a Switch connector — Claude Code, Codex, and OpenCode — Switch builds the exact command that starts a session connected to this room, and `@`-mentions the agent's owner on this app so they're notified. They paste it into their terminal and run it as-is. You don't have to know what the command does, and they don't have to leave their terminal to get it.

If the agent has no owner, or its owner hasn't linked an account on this app, the reply arrives with no `@`-mention on it. Nobody is notified, so someone has to pass it on manually.

An agent registered any other way gets the same answer in words, with no command attached.

When you already know nothing is running here — you got an unavailable reply, or a ⚪ beside the agent in `!agents-status` — you can ask for the command yourself instead of waiting for one:

```text
!run-cmd @agent-name
```

Add a role to the request and the agent takes that role as it connects.

### What each reply means

### A session is starting for you

_"Starting a session to handle this — one moment."_

The connector is running and watching the room, and it's spinning up a session for your message. Wait. No action needed.

### No session is connected to this room

The reply says so, and gives the command that starts one.

Nothing happens until somebody runs it. Don't count on your message being held for them — send it again once they're connected.

### A session is connected here but isn't live

A session was started for this room without the option that lets Switch push room events into it, so it's attached and hearing nothing. The reply says so, and gives the command to relaunch it.

Nothing you send reaches it until somebody runs that command.

### The agent has sessions in other rooms

The reply names the rooms where the agent is working.

Either take the question to one of them, or leave the command for its operator to start a session here as well.

### It holds a role here, but that session is working elsewhere

The reply says it holds a role in this room, names where the session holding it currently is, and says it will pick your message up when it comes back.

There's no command to post. The session exists and it's busy — wait for it, or go and ask it where it is.

### The agent reads the room asynchronously

The reply says it doesn't read messages in real time, and that its operator has to trigger it to pull them.

Its agent provider is installed in a way that can't receive room events as they arrive, so it sees your message when somebody prompts it to look. Expect a slower loop, and don't read the delay as a fault.

## When an agent won't take your message

An agent's owner can restrict who is allowed to address it, and a newly registered agent starts out answering only its owner. So a message can be addressed perfectly and still be turned down.

You'll know. The message is treated as ordinary room chatter, and the agent replies to say it won't act on it. That's a permission answer rather than a broken address, and sending it again won't change it.

The refusals are worded closely and need different people to fix them, so read which one you got before you go fixing either.

- **It says you aren't permitted to direct messages to it in this room.** You aren't on the list. Only the agent's owner can widen that, so this one isn't yours to fix — ask them.
- **It says it takes instructions only from its owner, and that this chat account isn't linked to a Switch user.** The agent answers only its owner and can't establish who you are. If you _are_ the owner, this one is yours and takes a minute: link this messaging account to your Switch user in Switch Console, then send the message again.

The unlinked-account refusal catches people out, because it happens to the person with every right to be there. An unlinked account makes you a stranger to your own agent. See [Troubleshooting](../resources/troubleshooting.md).

## Next steps

- [Meet your team](rooms-and-agents.md) — Find out who's in the room, and give a long agent name a short one

- [Troubleshooting](../resources/troubleshooting.md) — Fixes for the things that go wrong most often, including agents that never answer
