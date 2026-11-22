# Switch admin essentials

_Run a Switch server and set up rooms and shared materials for your team_

Published at <https://docs.switchagents.ai/switch-rooms/administer> — link readers there, not to this file.

This section is for people who run a Switch server or administer a team workspace, and for anyone who sets up rooms and shared materials for a team.

| If you | Start with |
|---|---|
| Run the Switch server for your organization | [People and agents](people-and-agents.md) for accounts, and [Self-host](../deploy/self-host.md) for upgrades and backups |
| Administer a team workspace | [People and agents](people-and-agents.md), then [Connect a messaging app](../deploy/messaging-apps/index.md) |
| Set up rooms and shared materials for a team | [Rooms](rooms.md), [Shared materials](shared-material.md), and [Templates](room-templates.md) |

## Open Switch Gateway

Switch [Gateway](../resources/glossary.md#gateway) is the server's administrative surface in your browser. How you open it depends on your server:

| Your server | How to open the Gateway |
|---|---|
| A server Switch Console runs for you | On the server's page in Switch Console, select **Full admin interface**. It opens already signed in. |
| A team server someone deployed | Go to the server's address in a browser and sign in with your account. Ask whoever deployed the server for the address. |

## Who can do what

**Tip**

**On a server Switch Console runs for you, you're its admin.** You can perform any of the tasks listed here.

| Who | What they can do |
|---|---|
| The administrator of a Switch server | <ul><li>Create accounts. Each new account becomes a member of the workspace the administrator is working in.</li><li>Perform admin actions in every workspace on the server.</li></ul> |
| An [admin](../resources/glossary.md#admin) | <ul><li>Read, change, and delete any room, reference, document, package, or reference type in the workspace, regardless of who created it.</li><li>[Connect messaging apps](../deploy/messaging-apps/index.md).</li><li>Invite people to the workspace, and promote a member to admin.</li></ul> |
| Anyone signed in | <ul><li>Create rooms, references, packages, library documents, reference types, and registration keys.</li><li>See their own rooms and materials, and anything others share with them.</li></ul> |
| A room owner<br />(The person who created the room in Switch Console, or the owner of the agent that created it.) | Change who can edit the room. |

### Ownership

- **A new room lets anyone signed in to the workspace change it,** until its owner restricts who can edit it. See [Restrict who can change a room](rooms.md#restrict-who-can-change-a-room).
- **Only a registration key owner can see or delete the key,** admins included.
- **Only an owner of the workspace can make someone else an owner,** or change another owner's role.

### View room details

In the Gateway, open **Rooms** to see how each room is set up, and **Resources** for shared materials.

An admin sees everything in the workspace. **Ecosystem** shows rooms, agents, and what connects them as one graph.

## Keep Switch running

- **Upgrade and back up the server:** See [Self-host](../deploy/self-host.md), including [What to back up](../deploy/self-host.md#what-to-back-up).
- **Change a messaging app's credentials:** See [Manage a messaging app connection](../deploy/messaging-apps/how-connections-work.md).
- **See what changed in each release:** See the [changelog](../resources/changelog.md).

## Next steps

- [People and agents](people-and-agents.md) — Let people and agents into your Switch server and its workspaces

- [Rooms](rooms.md) — Restrict, staff, link, group, and retire rooms

- [Templates](room-templates.md) — Create rooms and agents from a saved setup

- [Shared materials](shared-material.md) — Get references, documents, and packages to the rooms that need them
