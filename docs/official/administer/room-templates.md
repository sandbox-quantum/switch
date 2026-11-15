# Templates

_Create rooms and agents from a saved setup_

Published at <https://docs.switchagents.ai/switch-rooms/administer/room-templates> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";

A template saves a setup, so you can create rooms and agents from it instead of configuring each by hand. Capture a room that already works, or ask an agent to write a template, including one that creates agents.

For when a template is the right choice instead of a package, see [Bundle room materials](../building/grow-into-an-organization.md#bundle-room-materials).

## Template types

Switch files every template as a room, agent, or group. In Switch Console, a template's page shows its type, and the **Templates** page can filter by it.

| Type | What it creates | What it needs |
|---|---|---|
| **Room** | One room. The agents it names join it. | Every agent it names already exists on the server. If one doesn't, the run stops before the room is made and names the missing agent. |
| **Agent** | One agent, which can join rooms that exist or a new room the template creates. The [Switch expert](../getting-started/switch-expert.md) is an agent template. | See [Templates that create agents](#templates-that-create-agents). |
| **Group** | More than one room, more than one agent, or both | If it creates agents, see [Templates that create agents](#templates-that-create-agents). |

What a template creates depends on its type, not on whether you run it in Switch Console or ask an agent.

## How a template works

A template is a saved room setup with blanks in it, called fields. Whoever saves the template chooses which values become fields, and whoever runs it fills them in. Every value that isn't a field is copied exactly.

For example, you capture your support room and make its name and its triage agent into fields. When the billing team runs the template with a triage agent they already have, Switch Console asks them for a room name and an agent. They enter `Billing` and their own agent's name, and get a room set up like support's, with their name and agent in place. If you hadn't made the agent a field, their room would get your triage agent.

- **Make a field of anything that changes from one use to the next,** such as the room's name, its description, an agent, or a repository. When you capture a room, Switch Console lists these as suggestions, and you select the ones to keep as fields.
- **A captured field is a text box when someone runs the template.** For an agent, they type its name exactly. To give them a list of agents instead, in the template's YAML, change that field's `type` from `string` to `agent`.
- **A field replaces its value everywhere in the template,** in the instructions, roles, and room documents, not just one setting. In the example, every "Support" in the room's text becomes "Billing". Matching is case-sensitive, so "support" stays as it is.

## What a template includes

For each room, a template can set up its:

- Name, description, and instructions
- Messaging app, and whether the channel is public or private
- Who can read and edit the room
- Agents, people, and aliases
- Jobs (roles), references, and room documents
- A first message to post when the room is created

**A template doesn't include packages or library documents.** Attach those once the room exists. See [Make a package and add to it](shared-material.md#make-a-package-and-add-to-it).

## Capture a room

The easiest way to build a template is to capture a room that already works. In Switch Console, open the room, select **Configuration**, then **Capture as template**. Switch Console builds a room template from it, which names the room's agents rather than creating new ones.

**To copy a room and create a new agent for it,** capture the room first, then ask your own agent to make a version of the captured template that creates the agent:

<ChatMessage>

@agent-name start from our support room template and make a version that creates its own triage agent instead of naming ours, with the team name as a field. Run the agent with Claude Code on my-laptop, in ~/repos/support. Remove our support agent from the room's agent list. Save it as a new template, shared with the workspace.

</ChatMessage>

An agent needs the provider, machine, and working directory for each agent the template creates, so name them or expect it to ask.

**Then open the saved template and check the room's `agents:` list.** Nothing warns you if your original agent's name is still there. If it is, every room the template makes gets your original agent too, and the template fails on a server where that agent doesn't exist.

A captured template takes the following from the room:

- **Copied into the template:** The room's instructions, roles, aliases, and room documents, and its settings for who can read and edit it.
- **Named, not copied:** The messaging app, people, agents, and references the room used. Each new room gets the same people unless you remove them from the template's YAML.

**A capture doesn't include the room's group or its links to other rooms.** Set those up after the new room exists.

While you capture, choose which values become fields. See [How a template works](#how-a-template-works). When you save, give the template a name and a description, and choose who can use it.

**Check the room documents before you share a captured template.** A capture copies their full text into the template, and anyone who can use the template can read that text.

## Ask an agent to write a template

For a room that doesn't exist yet, or a template that creates agents, ask your own agent. Agents can read the server's template guide and save the result to your workspace.

<ChatMessage>

@agent-name write a room template for our support rooms: the room's instructions, a shared reviewer role and an exclusive triage role, the escalation guide reference, and a room document called escalation-notes. Save it, shared with the workspace.

</ChatMessage>

<ChatMessage>

@agent-name write a template that creates a triage agent and a support room for it, with the team name as a field. Save it, shared with the workspace.

</ChatMessage>

**Name the jobs, references, and room documents you want in your request.** The guide agents read doesn't mention them, so an agent leaves them out unless you ask, even though templates support them.

## Edit template YAML

To change a template by hand, on the **Templates** page in Switch Console, open it, then edit its YAML or delete it. To bring in a template from saved YAML, select **Import template** on the same page. For every key, see [the template language](https://github.com/sandbox-quantum/switch/blob/main/docs/TEMPLATES.md) in the Switch repository. Switch 0.31 reads version 1 and version 2 of the format.

The **Templates** page also lists the templates built into Switch, marked **Official**.

**Tip**

Open an Official template to see how it's built, and use its YAML as the basis for your own.

In the Gateway, under **Resources**, on the **Templates** tab, select **Upload template** to save YAML to the same list Switch Console shows. Paste it into **Document**, or select **Load from file**.

## Save and share a template

A template is private to whoever saves it until it's shared:

| Level | Who can use it | Who can change it |
|---|---|---|
| Private | You and admins | You |
| Shared | Everyone in the workspace | You |
| Open | Everyone in the workspace | Everyone in the workspace |

**An agent saves a template as private or shared.** Set the open level in Switch Console or the Gateway.

## Run a template

To run a template in Switch Console, under **Templates**, select **Use** on the template, or **Use template** on its page. Fill in the fields it asks for, then select the create button. Its label says what the run will make, such as **Create room**, **Create agent and room**, or **Create all**. You can also ask an agent to run the template for you. See [Create a room](../getting-started/create-a-room.md).

A room made from a template takes its settings for who can read and edit it from the template. Its owner is whoever runs the template.

## Templates that create agents

An agent template, or a group template that defines agents, creates its agents before any rooms. Whoever runs the template owns the agents it creates. When an agent runs it, the agent's owner owns them. It needs:

- [Agent management](../deploy/self-host.md#turn-on-agent-management) turned on for the server
- The machine each new agent will run on online, with its provider installed and signed in. Whoever runs the template picks the machine if the template asks.
- [Can manage agents](../getting-started/agent-settings.md#let-the-agent-create-agents) turned on, if an agent runs the template

### Use an agent you already have

### Open the template

In Switch Console, select **Templates**, find the template, and select **Use**.

### Swap in your agent

Under **What this will create**, find the agent's card and select **Existing agent**. The choice appears only if the template allows it.

### Choose the agent and run the template

Select your agent from the list, then select the create button.

## Troubleshooting

### Switch Console says Nothing was created

**Switch found a problem before creating anything.** Each agent's card says what stopped it. Usually, a field the template requires has no value. Fix it, then run the template again.

### The run stopped and offers Retry remaining steps

**The run stopped partway** and kept only what it had already created. Fix the cause, then select **Retry remaining steps**.

**Note**

An agent that already exists isn't created again.

### An agent could not be deleted

**The run failed.** Switch removed the agents created during the run, except the one the message names. Delete that agent from **Your Agents**, then run the template again.

### The run fails because something is missing

**Every agent and reference** the template names must exist on this server, unless the template creates the agent. Edit the template to remove anything the new room won't have. A person Switch can't find doesn't stop the run. The room is created, and Switch reports the person afterward.
