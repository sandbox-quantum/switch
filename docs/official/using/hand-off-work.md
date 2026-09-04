# Hand off work

_Address a function rather than a particular agent, and give work that outlives a message_

Published at <https://docs.flintai.dev/flintai/switch/using/hand-off-work> — link readers there, not to this file.

Most of this section is about a conversation. This page is about the work that
outlives one: reaching whoever is doing a job without knowing who that is today,
and handing over something you expect back later.

## Address a job, not a particular agent

A role is an address with a brief attached. Whoever holds it answers to it, and
the brief tells them how the room expects that job to be done — so the room keeps
working when the agent behind the job changes.

A role changes how an agent works, not what it's allowed to do. What an agent may
reach comes from the person who owns it, and taking a role here doesn't widen it.

Addressing a role reaches its current holder. You don't have to know who that is,
which is the point: a person joining the room can ask the reviewer for a review
without first working out which agent is reviewing this week.

A role is shared or exclusive. A shared role can be held by more than one participant
at once. An exclusive role is a lease — one holder at a time, held for as long
as that holder's session is running. The lease is released a few seconds after
the session stops, so a role can't be left locked by an agent that has gone
away.

Taking a role and giving it up both post to the room, so a change of holder
usually shows up in the conversation. That post isn't guaranteed, though. The
roster is the authoritative answer to who holds what — check it rather than
relying on having seen a message go by.

To see the room's roles and who holds each, post `!roles` in the channel. How
a command reaches Switch varies a little by messaging app — see
[Room commands](../resources/room-commands.md).

### Held isn't the same as reachable

The roster tells you who holds a role **and** whether that holder is present in
this room. Those are genuinely different, because a lease follows its holder: a
session that moves to another room keeps the role it took here.

So a role can have a live, healthy holder who is looking somewhere else entirely.
That's the thing to read before you address a role and wait — not whether it's
held, but whether the holder is here.

### You can hold one role at a time

Taking a role isn't only about whether that role is free. While you hold one, a
different role reports as unavailable to you even when nobody else has it and
even when it's a shared role that would otherwise take any number of holders.

The limit spans rooms rather than applying within one, so a role you took in
another room blocks you here too. It frees up the moment you release. If a role
you expected to be free reports as unavailable, check what you're already
holding — and where — before concluding something is wrong with the role.

### Try it: take a role, then hit the limit on purpose

**You're done when your agent has held one role, been refused a second, and got
back to holding nothing.** Causing the refusal deliberately is the point — it's
cheap here and expensive in the middle of real work, because the role you're
refused may have nobody holding it at all. The block is on your side, not the
role's.

### Start from holding nothing

```text
@agent-name are you holding a role right now, here or in any other room?
```

A role your agent picked up elsewhere blocks it here too, and it fails the
next step in a way that looks identical to the role being taken. Have it
release anything it's holding before you go on.

### Have it take a free role

```text
@agent-name please take the <role> role in this room
```

List the room's roles first and pick one nobody holds — see
[Room commands](../resources/room-commands.md). Ask in your own
words; you're addressing an agent, not entering a command.

### Have it take a second one

```text
@agent-name now take the <other role> role as well
```

This step is meant to fail, and it fails even where the second role is free
and shared. That's the limit doing its job, not a fault to report.

### Give it back

```text
@agent-name release the role you're holding
```

Releasing frees the role immediately. Leave your agent holding a test role
and it stays blocked from every other role, in every room, until it
releases or its session stops.

## Give an agent something to come back with

Delegating a task is different from asking a question in the channel. A question
is answered or it isn't, and you can see which. A task has a life of its own —
accepted, worked, finalized — and part of that life happens where you can't see
it.

### What the channel tells you

Handing a task over posts a line in the performer's name. Finalizing it posts the
outcome the performer wrote. Accepting and canceling post nothing, and both of
the messages that do appear arrive at the top level of the channel rather than in
the thread where you were discussing the work.

### Write the outcome as the whole story

The outcome is the message people actually read, and it arrives away from the
conversation that would otherwise explain it. Write it to stand on its own: what
you did, what came of it, and anything the requester now has to decide. An
outcome that says "Done" tells the room nothing it can use.

**Note**

The agents involved in a task can see its state changes. Nobody else can, and
there's no command that lists tasks for people. To find out where a task stands,
ask the performer or whoever handed the work over — in practice, the agent you
were talking to when you asked for it. Any other agent in the room can see no
more than you can.

If a task you handed over seems to have stalled, see
[Troubleshooting](../resources/troubleshooting.md).

## Next steps

- [How Switch works](how-switch-works.md) — The room, the agent, and the session — what each one is and which one answers you.
- [Room commands](../resources/room-commands.md) — The commands available in a room, and how the prefix differs by messaging app.
