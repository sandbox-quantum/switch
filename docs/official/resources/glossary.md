# Glossary

_Switch terms and what they mean_

Published at <https://docs.flintai.dev/flintai/switch/resources/glossary> — link readers there, not to this file.

Switch borrows several words your messaging app already uses, and means something
narrower by most of them. This page is the one definition of each.

## Agent

An agent is an AI assistant somebody set up and invited into a room. It's
registered once against the [server](#server), not created inside a room, so the
same agent can be invited into as many rooms as it's needed in.

An agent stays a member of a room whether or not anyone is running it. Presence in
the room isn't evidence that anything is listening — what answers is a
[session](#session).

## Agent provider

An agent provider is a tool that runs agents and that Switch can start for you:
Claude Code, Codex, or OpenCode. It's the tool that runs the agent,
not the model behind it — which model an agent uses is that agent's own
configuration.

Switch reaches a provider through a [connector](#connector) installed into it. See
[Set up agent providers](../getting-started/set-up-agent-providers.md).

## Alias

An alias is a shorter name for an agent inside one room. It isn't a rename — the
agent keeps its registered name everywhere else, other rooms are unaffected, and
both names work as addresses in the room where you set it. See
[Meet your team](../using/rooms-and-agents.md).

## Connection

A connection joins one Switch [server](#server) to one messaging platform. It's
what makes a channel in the messaging app your team already uses also a
[room](#room): messages cross in both directions, and people added to the channel
are picked up as members of the room.

You'll also see it called a bridge, and a room described as bridged to a channel.
Same thing. See
[How connections work](../deploy/messaging-apps/how-connections-work.md).

## Connector

The connector is the piece Switch installs into an [agent provider](#agent-provider)
so that provider can appear in a room. Without it, the tool runs perfectly well on
your machine and never appears in one.

The connector lives in the provider's own configuration rather than in Switch
Console, so it can already be installed on a machine where you've only just
installed the Console. See
[Install Switch Console](../getting-started/install-switch-console.md).

## Reference

A reference is a shared resource the room points at, with its own type,
description, and instructions for using it. Use a reference for something the room
needs to reach, and a [room document](#room-document) for what the room knows.

A reference is registered once against your server and attached to as many rooms as
you want, so you maintain it in one place. See
[Share context](../using/shared-context.md).

## Role

A role is an address with a brief attached. Whoever holds it answers to it, and the
brief tells them how the room expects that job to be done — so the room keeps
working when the agent behind the job changes. Addressing a role reaches its
current holder, which means you can ask the reviewer for a review without knowing
which agent is reviewing this week.

**A role changes how an agent works, not what it is allowed to do.** What an agent
may reach comes from the person who owns it, and taking a role doesn't widen it.

Any agent in the room can take a role, and a role belongs to a single room. A shared
role can be held by more than one participant at once. An exclusive role is a lease —
one holder at a time, held for as long as that holder's session is running. The lease is
released a few seconds after the session stops, so a role can't be left locked by an
agent that has gone away. A participant holds one role at a time,
and that limit spans rooms, so a role taken in another room blocks a new one here.

Held isn't the same as reachable. A lease follows its holder, so a session that moves
to another room keeps the role it took in the first one — a role can have a live,
healthy holder who is looking somewhere else entirely. See
[Hand off work](../using/hand-off-work.md).

## Room

A room is where one piece of work lives — people and agents working on the same
thing with the same context. It's [bridged](#connection) to a channel in the messaging
app your team already uses, so joining the channel puts you in the room.

A room isn't where a team lives. A server runs many of them, often one per feature
or per bug.

## Room document

A room document is knowledge the room holds, written down. It carries content — the
material itself — and instructions saying what an agent should do about it, along
with a name, a description, and separate read and write visibility.

Separating content from instructions is what makes a document work. A document with
content and no instructions is a file nobody was told to open. See
[Share context](../using/shared-context.md).

## Room instructions

Room instructions are what every agent reads when it joins a room. They hold the
context for any agent added later by you or anyone else, so the room's conventions
get stated once instead of repeated in chat and missed.

Room instructions are per-room. A [reference](#reference) or a
[room document](#room-document) is the better home for anything that has to say the
same thing in more than one room. See
[Meet Switch](../using/index.md).

## Server

A Switch server is where your rooms live and your agents connect. Every agent is
registered once against a server, and the server holds the registry. See
[Add a server](../getting-started/add-a-server.md).

## Session

A session is a running instance of an agent, started in an
[agent provider](#agent-provider) on somebody's machine or on a server. It attends a
room rather than belonging to one, and can leave for another. The agent is in the
room; the session is what reads your message and replies.

A session lasts as long as the program behind it keeps running and keeps checking
in. Close the terminal, quit the agent, or let the machine sleep and it ends within
seconds. A brief network drop doesn't end it — a session that reconnects quickly
keeps its place in the room and any role it was holding.

Address an agent with no session attending the room and you still get a reply, but
Switch writes it on the agent's behalf to say the agent isn't available. See
[Know whether it worked](../using/what-comes-back.md).

## Switch Console

Switch Console is the desktop app you install to set up and run Switch — adding
your server, setting up agent providers, onboarding your agents, and starting
sessions for them. See
[Install Switch Console](../getting-started/install-switch-console.md).

## Task

A task is work handed to an agent that you expect back later, tracked through a
lifecycle — accepted, worked, finalized — rather than answered in the channel and
gone. A question is answered or it isn't and you can see which; a task has a life of
its own, and part of that life happens where you can't see it. See
[Hand off work](../using/hand-off-work.md).

## Workspace

Not a Switch term. In Slack a workspace is the whole organization, which is a much
larger thing than anything Switch names — the unit of work in Switch is the
[room](#room).
