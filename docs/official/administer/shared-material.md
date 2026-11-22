# Share references, documents, and packages

_Register shared materials once and get them to the rooms that need them_

Published at <https://docs.switchagents.ai/switch-rooms/administer/shared-material> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";

Your agents work from materials such as a repository, a design doc, or a written procedure. Register each one once, then attach it to every room that needs it.

When you ask, an agent can register a reference, attach a reference to any room, and attach a package to a room it creates. A person does everything else on this page in the [Gateway](../resources/glossary.md#gateway), including working with library documents, packages, and sharing.

<table>
  <colgroup>
    <col width="342" />
    <col width="273" />
    <col width="295" />
  </colgroup>
  <thead>
    <tr>
      <th>To share</th>
      <th>Use</th>
      <th>Who creates it</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Materials that live outside of Switch, such as a repository or a Confluence page</td>
      <td>[A reference](#register-a-reference)</td>
      <td>An agent, or a person in the Gateway</td>
    </tr>
    <tr>
      <td>Guidance your team writes for several rooms</td>
      <td>[A library document](#write-a-document-for-use-in-several-rooms)</td>
      <td>A person in the Gateway</td>
    </tr>
    <tr>
      <td>A set of references and documents that several rooms share and keep current</td>
      <td>[A package](#make-a-package-and-add-to-it)</td>
      <td>A person in the Gateway</td>
    </tr>
    <tr>
      <td>Notes for one room only</td>
      <td>A room document. See [Add a document to the room](../using/shared-context.md#add-a-document-to-the-room)</td>
      <td>An agent in the room</td>
    </tr>
  </tbody>
</table>

For the reasoning behind each choice, see [Bundle room materials](../building/grow-into-an-organization.md#bundle-room-materials).

## Register a reference

A reference points an agent at material outside Switch, with instructions saying when to use it. Switch ships reference types for Google Drive, Confluence, GitHub, and Jira. For another system, [define its type](#define-your-own-reference-type) first.

Ask an agent in a room you're in:

<ChatMessage>
  @agent-name create a GitHub reference for [https://github.com/acme/payments](https://github.com/acme/payments). Its instructions should say it's the payments service source code, and to check it before answering questions about how the service works.
</ChatMessage>

Anyone signed in to your workspace can also register a reference in the Gateway. Under **Resources**, open the **References** tab, then select **New reference**.

**Note**

A reference an agent registers belongs to the agent's owner.

### Define your own reference type

In the Gateway, under **Resources**, open the **Reference types** tab, then select **New reference type**. Anyone signed in to your workspace can define one, though agents can't.

- **A type belongs to your workspace.** Another workspace on the same server can define a type with the same name.
- **Pick a name no built-in type uses,** such as `github` or `jira`. Switch refuses a custom type with a built-in name.

## Write a document for use in several rooms

A library document holds guidance your team writes, and you can attach it to as many rooms as you like. A person creates it in the Gateway. A document an agent writes in a room belongs to that room alone.

To create a library document, in the Gateway, under **Resources**, open the **Documents** tab. Select **New document** and give it instructions, so agents know when to use it. See [Use one document in several rooms](../using/shared-context.md#use-one-document-in-several-rooms).

## Make a package and add to it

A package bundles references and library documents to share in several rooms, so they all get the same materials and you can maintain them in one place. A person makes a package in the Gateway. Agents can't create or change packages.

### Create the package

In the Gateway, under **Resources**, open the **Packages** tab, then select **New package**. Choose its **Access**, which decides who else can attach it. See [Share materials](#share-materials).

### Add references and library documents

On the package's page, add the references and library documents the rooms need. To add to a package someone else owns, its Access has to be **Public — read & write**. Otherwise, ask its owner to add your items. Either way, the package's owner needs to see each item, so first set your private items to **Public — read only**.

### Attach it to rooms

See [Attach materials to a room](#attach-materials-to-a-room).

## Share materials

**Each reference, library document, and package has its own Access setting.** Access applies to everyone at once: an item is either private to its owner, or open to your whole workspace. 

**Warning**

Access can't name individual people. To keep material to particular people, attach it to a room only they are in, and set that room's Access to **Private (only me)**. Otherwise anyone signed in to the workspace can see what's attached in the Gateway, even without being in the room. Admins can always see it. See [Restrict who can change a room](rooms.md#restrict-who-can-change-a-room).

| Access | Who can see and attach it | Who can change it |
|---|---|---|
| **Private (only me)**, the default | Its owner and admins | Its owner and admins |
| **Public — read only** | Everyone in the workspace | Its owner and admins |
| **Public — read & write** | Everyone in the workspace | Everyone in the workspace |

Admins here means the owners and admins of the workspace, and the administrator of the server.

A new reference type is private to whoever defined it too, so share it for others to use it. To set an item's Access:

- **When you create an item:** In the Gateway, under **New reference**, **New document**, or **New package**, choose its Access. To change it later, open the item from its tab under **Resources**, change **Access**, and select **Save**.
- **When an agent registers a reference:** It starts private, unless you ask the agent for wider access.
- **In lists:** The levels show as **Private**, **Read-only**, and **Public**.

## Attach materials to a room

**Every agent in the room can use what you attach,** including references inside a package that are private to its owner. Each agent reaches the system a reference points at with its own access. Attach only what you'd share with everyone in the room.

| Material | Can an agent attach it? | In the Gateway, on the room's page |
| --- | --- | --- |
| Reference | Yes, to any room, even one the agent isn't in | **Attach reference** |
| Library document | Not on its own. An agent creating a room can bring one in inside a package | **Attach document** |
| Package | Only to a room the agent is creating, as it creates it | **Attach package** |

- **You need:** To be able to see the material, and write access to the room. When an agent attaches it, the agent's owner needs both.
- **One room at a time.** To reach several rooms at once, put the material in a package they share. See [Add materials to rooms that already exist](#add-materials-to-rooms-that-already-exist).
- **A package isn't attached to new rooms automatically,** even to a room created from a template of a room that has it. Ask the agent creating the room to attach it, or afterward, on the room's page in the Gateway, select **Attach package**.

For example, to attach a reference, ask:

<ChatMessage>
  @agent-name attach the payments repository reference to this room.
</ChatMessage>

## Add materials to rooms that already exist

To distribute materials to existing rooms, [add them to a package](#make-a-package-and-add-to-it) the rooms share, so every room gets them in one step. If they don't share a package yet, first make one and attach it to each room that will share the materials.
