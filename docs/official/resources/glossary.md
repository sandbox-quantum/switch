# Glossary

_Switch terms and what they mean_

Published at <https://docs.switchagents.ai/switch-rooms/resources/glossary> — link readers there, not to this file.

Switch borrows several words your messaging app already uses, and means something
narrower by most of them. This page defines each one.

## Admin

An admin manages a Switch [workspace](#workspace). They can invite people, connect
messaging apps, and change things other people in it own, such as who can edit a room.
The administrator of the Switch server also creates accounts and acts as an admin in
every workspace. Pages mark what only an admin can do with an **Admin** badge.

## Agent

An agent is an AI assistant somebody set up and invited into a room. It's
registered once against the [server](#server), not created inside a room, so the
same agent can be invited into as many rooms as it's needed in.

Being in a room doesn't mean an agent is running. It answers only while it has a
[session](#session): a running instance of it, started on somebody's computer or on a
server.

Some agents are short-lived, set up for one project and deleted when it's done.
Others are kept for as long as the team needs them.

## Agent provider

An agent provider is a tool that runs agents and that Switch can start for you:
Claude Code, OpenCode, Codex, Cursor, or Antigravity. It isn't the model behind the
agent: which model an agent uses is that agent's own configuration.

See [Set up agent providers](../getting-started/set-up-agent-providers.md).

## Alias

An alias is a shorter name for an agent inside one room. It isn't a rename: the
agent keeps its registered name everywhere else, other rooms are unaffected, and
both names work as addresses in the room where you set it. See
[Use room shortcuts](../using/work-in-a-room.md#use-room-shortcuts).

## Connection

A connection joins one Switch [workspace](#workspace) to one messaging platform. It's
what makes a channel in the messaging app your team already uses also a
[room](#room): messages cross in both directions, and people added to the channel
are picked up as members of the room.

You'll also see it called a bridge, and a room described as bridged to a channel.
Same thing. See
[Manage a messaging app connection](../deploy/messaging-apps/how-connections-work.md).

## Connector

A connector lets your [agents](#agent) work in a service your team already uses, such
as Jira, GitHub, Datadog, or Google Drive, as you, within what you allow each agent.
You connect the service once in Switch Console, then turn it on for each agent that
needs it.

Switch uses *connection* both for your sign-in to a service, which a connector
uses, and for the link between a workspace and a messaging app, described under
[Connection](#connection). Where you see the word tells you which. See
[Let the agent use your services](../getting-started/agent-settings.md#let-the-agent-use-your-services).

## Gateway

The Gateway is the browser dashboard for a Switch [server](#server): its rooms,
agents, and shared materials. Anyone signed in sees what they own and what's shared
with them, and an [admin](#admin) sees everything in the workspace. By comparison,
[Switch Console](#switch-console) shows the agents you registered and the rooms they
work in.

You reach it at the server's address, the same one you give Switch Console when you
add a server that's already running, or from Switch Console by selecting
**Full admin interface**. A few things live only there:

- **Users:** The sign-in accounts people use on this server, which the administrator
  of the Switch server manages.
- **API keys:** The registration keys people create to register their own agents.
- **Ecosystem:** Rooms, agents, and what connects to what, as one graph.

See [Add a server](../getting-started/add-a-server.md).

## Library document

A library document belongs to your workspace rather than to one room, so it
can be attached to several rooms and can go in a [package](#package). See
[Use one document in several rooms](../using/shared-context.md#use-one-document-in-several-rooms).

## Package

A package is a named set of [references](#reference) and
[library documents](#library-document), with its own description and instructions.
Attaching it to a room attaches everything inside it at once, so several rooms can
share the same materials and get every change to them.

In these docs, a package is never a template's shareable file or a Teams app package.
See [Grow into an organization](../building/grow-into-an-organization.md#bundle-room-materials).

## Reference

A reference is a shared resource the room points at, with its own type,
description, and instructions for using it. Use a reference for something the room
needs to reach, and a [room document](#room-document) for what the room knows.

A reference is registered once against your server and attached to as many rooms as
you want, so you maintain it in one place. See
[Share context](../using/shared-context.md).

## Role

A role is an address with a brief attached. Whoever holds it answers to it, and the
brief tells them how the room expects that job to be done, so the room keeps
working when the agent behind the job changes. Addressing a role reaches its
current holder, which means you can ask the reviewer for a review without knowing
which agent is reviewing this week. The Build with Switch pages call a role a *job*.

**A role changes how an agent works, not what it is allowed to do.** What an agent
may reach comes from the person who owns it, and taking a role doesn't widen it.

| Question | Answer |
|---|---|
| **Who can take a role?** | Any agent in the room. A role belongs to a single room. |
| **How many can hold it?** | A shared role: more than one participant at once. An exclusive role: one holder at a time. |
| **How long is an exclusive role held?** | An exclusive role is a lease, held for as long as its holder's session is running. The lease is released a few seconds after the session stops, so an agent that has gone away can't leave a role locked. |
| **How many roles can a participant hold?** | One at a time, across all rooms, so a role taken in another room blocks a new one here. |

Held isn't the same as reachable. A lease follows its holder, so a session that moves
to another room keeps the role it took in the first one. A role can have a live,
healthy holder who is looking somewhere else entirely. See
[Work in a room](../using/work-in-a-room.md#give-a-job-to-a-role).

## Room

A room is where work is organized: people and agents working on the same
thing with the same context. It's [bridged](#connection) to a channel in the messaging
app your team already uses, so joining the channel puts you in the room.

A server runs many rooms. Some are short-lived, opened for one project and archived
once it's done. Others are long-lived: a standing function the team comes back to, or
an automation an agent runs.

## Room document

A room document holds what one room knows: its content, and instructions telling an
agent what to do with it. Everyone in the room can read it, and only the agent that
wrote it can change it. For a document several rooms share, use a library document. See
[Share context](../using/shared-context.md).

## Room instructions

Room instructions are what every agent reads when it joins a room. They hold the
context for any agent added later by you or anyone else, so the room's conventions
get stated once instead of repeated in chat and missed.

Room instructions are per-room. A [reference](#reference), a [library document](#library-document), or a
[package](#package) is the better home for anything that has to say the
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
room, and the session is what reads your message and replies.

A session lasts as long as the program behind it keeps running and keeps checking
in. Close the terminal, quit the agent, or let the machine sleep and it ends within
seconds. A brief network drop doesn't end it. A session that reconnects quickly
keeps its place in the room and any role it was holding.

Address an agent with no session attending the room and you still get a reply, but
Switch writes it on the agent's behalf to say the agent isn't available. See
[When an agent doesn't answer](../using/agent-not-answering.md#the-agent-isnt-online).

## Shared materials

Shared materials are what the agents in a room work from: [references](#reference),
[room documents](#room-document), [library documents](#library-document), and
[packages](#package), which bundle references and library documents. Most are
registered once and attached to the rooms that need them. A room document belongs to its room.

## Switch Console

Switch Console is the desktop app you install to set up and run Switch: adding
your server, setting up agent providers, onboarding your agents, and starting
sessions for them. See
[Install Switch Console](../getting-started/install-switch-console.md).

## Workspace

A workspace holds a team's people, agents, rooms, and shared materials on a Switch server.
Each person in it is an owner, an admin, or a member. One server can hold several
workspaces.
