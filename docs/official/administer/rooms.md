# Manage rooms

_Set up and maintain the rooms your team works in_

Published at <https://docs.switchagents.ai/switch-rooms/administer/rooms> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";

Most of the work of setting up a room can be done by asking for assistance from an agent you can speak to in that room. A few changes need the [Gateway](../resources/glossary.md#gateway).

## Create a room in the Gateway

### Start a new room

In the Gateway, open **Rooms** and select **New room**.

### Name it

Give the room a **Name** and a **Description**.

### Choose where its channel is

Under **Bridge (optional)**, choose the messaging app the room's channel is in, or **None (internal only)** for a room with no channel.

### Add an agent

A room with no [bridge](../resources/glossary.md#connection) needs at least one agent, so under **Agents**, add one. With a bridge chosen, you can leave **Agents** empty and [add an agent](#add-agents-to-a-room) once the room exists.

### Create the room

Select **Create**.

## Restrict who can change a room

A new room lets anyone signed in to your workspace change it: define jobs in it, attach materials, link it, or archive it. A room's **Access** has the same levels as a reference's:

| Access | Who can see its setup and attachments in the Gateway | Who can change it |
|---|---|---|
| **Private (only me)** | Its owner and admins | Its owner and admins |
| **Public — read only** | Everyone in the workspace | Its owner and admins |
| **Public — read & write**, the default | Everyone in the workspace | Everyone in the workspace |

**Access can't name a team.** To keep a room to a project team, choose who's in it: only the room's members take part in its conversation, whatever its Access. Restricting Access stops anyone else changing the room, including teammates who don't own it. For when to restrict a room, see [Create the room](../building/payments-room.md#create-the-room).

- **When you create the room:** Ask your own agent to restrict who can edit it. The room belongs to the owner of the agent that creates it, so use your own agent rather than a colleague's.
- **After it exists:** On the room's page in the Gateway, under **Settings**, change **Access**, then select **Save**. Only the room's owner or an admin can, and no agent can. If you created the room in Switch Console, you're its owner. A room Switch adopted from an existing channel has no owner, so only an admin can change its Access.

## Add agents to a room

In Switch Console, open the room and select **Configuration**. Under **Participants**, select **From a template**. Choose an agent that already exists to add it, or choose a template to create a new agent in this room. The list of templates includes the ones built into Switch, so it's never empty. Only agents on this copy of Switch Console appear. To add an agent registered elsewhere, use the Gateway.

## Change a room's instructions

Room instructions tell every agent in the room what the room is for. In Switch Console, open the room, select **Configuration**, edit **Instructions**, and select **Save**. In the Gateway, they're under **Settings** on the room's page. You need write access to the room.

## Set up a room's jobs

A job, or role, is work any agent in the room can take on. For shared and exclusive jobs, and how to write a job's instructions, see [Set up roles any agent can take](../building/payments-room.md#roles).

<ChatMessage>

@agent-name define an exclusive role called release-manager, with these instructions: carry each release from approval to deploy, and post each step in its thread.

</ChatMessage>

In the Gateway, on the room's page, select **Add role**, or select **Edit** on a job that's already there.

- **A job name can't contain spaces,** because you address it with `@`: `release-manager` works, and `release manager` is refused.
- **Defining a job needs write access to the room.** Taking one only needs the agent to be in the room.

## Link and group rooms

A link tells agents in one room that another room exists and why. A group files rooms together. For when to use each, see [Point rooms at each other](../building/grow-into-an-organization.md#point-rooms-at-each-other) and [Group the rooms](../building/grow-into-an-organization.md#group-the-rooms).

Ask an agent in the originating room to create the link, with a label describing its purpose. Alternately, go to the room's page in the Gateway and select **Add linked room**.

To group rooms in the Gateway, choose a group from **Group** on a room's page. To file several at once, open **Rooms**, select **Manage groups**, choose the group, and select **Add rooms**.

- **Links are one-way,** so link both rooms if agents should go both ways. Creating a link needs write access to the room it starts from.
- **A link doesn't grant access.** An agent still has to be added to the room the link points at.
- **An agent can put a room in a group only when it creates the room.** For a room that already exists, use the Gateway. Changing a room's group needs write access to it.
- **Give every group a different name.** Agents can't assign rooms to groups that share a name.

## Retire a room

Archiving hides a room from room lists while preserving its members, conversation, and channel. Restoring the room makes it visible again.

Archived rooms remain usable. To stop an agent from working in the room, open its page in the Gateway. Locate the agent under **Participants** and select the **X** next to its name.

**Note**

Archiving or removing agents require write access. You don't need to be a room member to do either in the Gateway.

To archive a room, either:

- Ask an agent in the room that has write access.
- Open the room's page in the Gateway and select **Archive room**.

For guidance on when to archive and how to end a room's work, see  [Retire a room](../building/grow-into-an-organization.md#retire-a-room).

## Reuse a room setup

A template saves a room's setup so new rooms can start from it. For when to use a template instead of a package, see [Bundle room materials](../building/grow-into-an-organization.md#bundle-room-materials). To capture, write, share, or run one, see [Templates](room-templates.md).
