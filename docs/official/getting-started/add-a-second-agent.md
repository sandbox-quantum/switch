# Add a custom agent

_Set up a Switch agent yourself, or bring one you already run in a terminal_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/add-a-second-agent> — link readers there, not to this file.

An [agent](../resources/glossary.md#agent) is an AI teammate with a name people can address. When you add one, you choose the following:

- **Its name:** What people type to invite it and address it. You can't change it later.
- **Where it runs:** This computer, or a host you've onboarded.
- **Its working directory:** The folder it works in and can read.
- **Its [agent provider](../resources/glossary.md#agent-provider):** The AI it runs on, such as Claude Code or Codex.
- **Whether it asks before acting:** How much it does without your approval.
- **Who may instruct it:** Who can mention it or hand it work.

You can [ask switch-buddy or another agent with permission](#ask-an-agent-to-create-it) to make a new agent for you. It asks you for the new agent's settings. Use [these manual steps](#add-an-agent) when you'd rather make the choices yourself, when you're bringing in an agent you already run in a terminal, or when switch-buddy or another agent that can create agents isn't available.

Adding an agent registers it with your server. You do this once per agent, not once per room. You can then invite the same agent into any room on that server, in any messaging app connected to it.

On a server that runs agent management, the agent runs on a managed machine rather than in Switch Console. See [What keeps your agent running](what-keeps-your-agent-running.md) for what changes.

## Before you begin

You need:

- **A server added to Switch Console.** See [Add a server](add-a-server.md).
- **The agent's provider installed and signed in on the machine the agent will run on.** See [Set up agent providers](set-up-agent-providers.md).
- **For an agent on another machine, that host onboarded.** See [Host remotely](../deploy/host-remotely.md).

An agent can use the tools and access on the machine it runs on, and in its working directory. Your own setup for its provider carries over too, such as MCP servers and a `gh` login. Switch passes the agent only a fixed set of environment variables, though, not everything in your shell, so a tool that reads its own API key from your shell may not find it. See **A tool that works in your terminal fails in Switch** under [Getting an agent running](../resources/troubleshooting.md#getting-an-agent-running).

## Ask an agent to create it

**Ask switch-buddy, or another of your own agents, to create the agent, and tell it:**

- The new agent's name
- The machine it runs on
- Its [agent provider](../resources/glossary.md#agent-provider)
- What it's for

<ChatMessage>

@release-helper create an agent called release-notes on my laptop, running Claude Code, to draft release notes from merged pull requests.

</ChatMessage>

_Read what it proposes before you agree. Switch tells the agent to check the details with you first, but nothing stops it from creating the agent without asking._

To set this up, see [Let the agent create agents](agent-settings.md#let-the-agent-create-agents).

## Add an agent

**Note**

On Windows, these steps don't work yet: every agent provider shows as unavailable, even one that's installed. switch-buddy isn't affected.

### Open the agent list

In the sidebar, select **Your Agents**. Your registered agents appear as cards. To add an agent, select the dashed card with a plus on it.

### Name it

Give the agent a **Name** and a **Description**. Both are required. **Agent instructions** is optional.

The name accepts lowercase letters, digits, `.`, `-`, and `_`, and it has to start with a letter or a digit. No spaces and no capitals. Switch Console flags a name that doesn't fit as you type, and offers a corrected one as **Use `<name>`**. You can't change the name after you create the agent.

A name is unique across the whole server, and everyone in the agent's rooms sees it. A name that says the agent's job and owner tells others what it's for and who maintains it:

```text
job.you
```

Spell the job out. `bug-fixer.jsmith` and `tech-writer.jsmith` are still short enough to type from memory, and they say what the agent does. Put a longer explanation in **Description**.

You'll type the agent's full name to invite it to a room and to address it there. Once it's in the room, you can give it a shorter [alias](create-a-room.md#give-an-agent-a-short-name) to use in that room.

### Choose where it runs

**Run location** is the computer the agent runs on. Leave it on **This computer**, or select a host you have [onboarded](../deploy/host-remotely.md). Under the field, Switch Console says what will happen to an agent created there: whether Switch Console runs it, or a managed machine does.

**Warning**

You can't change **Run location** after you create the agent. To move an agent to another machine, delete it and register a new one. The new agent has its own credentials, and you invite it to its rooms again.

### Choose a working directory

**Directory** is the agent's working directory, on the machine **Run location** names. The agent can read the files in it, and any standing instructions there become its default behavior, so choose a directory you'd show to everyone in the agent's rooms. Before the agent joins a room, check it against [Working safely with agents](../resources/working-safely-with-agents.md).

For an agent on a host, the folder must already exist on the host, and the agent works from whatever code is there. See [Run an agent on the host](../deploy/host-remotely.md#run-an-agent-on-the-host).

**Warning**

For an agent Switch Console runs, you can't change **Directory** after you create it. To use a different directory, delete the agent and register a new one. The new agent has its own credentials, and you invite it to its rooms again. You can change a managed agent's directory. See [Rename or move the agent](agent-settings.md#rename-or-move-the-agent).

**Tip**

If the agent is already running in a terminal, choose the directory that terminal is in, so you keep the conversation you already have. See [If the agent is already running](#if-the-agent-is-already-running).

### Choose the agent provider

**Agent provider** lists every provider Switch knows. Installation and sign-in are checked on the machine **Run location** names, so a provider installed on this computer can still be unavailable on a host. Providers that can't be used there are dimmed, with the reason. To set one up on this computer, see [Set up agent providers](set-up-agent-providers.md). For a host, see [Run an agent on the host](../deploy/host-remotely.md#run-an-agent-on-the-host).

### Leave Advanced configuration alone

**Advanced configuration** holds settings such as the agent's model and the tools it may use. The defaults suit most agents. To change them later, see [Change the model or tools](agent-settings.md#change-the-model-or-tools).

### Decide whether it asks before acting

Expand **Settings**, which is collapsed when the form opens.

**Auto mode** starts on and **Bypass permissions** starts off, wherever the agent runs.

- **Auto mode:** The agent's provider decides which actions run without asking, and posts a request in the room for the rest. On OpenCode, Auto mode approves every request. Turn it off if an OpenCode agent should request permission.
- **Bypass permissions:** The agent acts without asking for approval, in all of its [sessions](../resources/glossary.md#session). Turn it on only for an agent you'd trust alone with the directory you gave it.

To change either later, see [Let the agent act without asking](agent-settings.md#let-the-agent-act-without-asking).

### Decide who may instruct it

**Who can talk to your agent** sets who may mention the agent, target it, or hand it work. It starts on **Me and my agents (default)**, so you and the other agents you own can instruct it, but your colleagues and their agents can't.

To keep your own agents out too, select **Only me**. For the other options, and to change this later, see [Choose who can instruct the agent](agent-settings.md#choose-who-can-instruct-the-agent).

**Note**

An agent identifies you by your messaging account, which must be linked to your Switch user. If your account isn't linked, the agent can't tell it's you and refuses the work. If a warning about an unlinked account appears, select the warning to open **Messaging apps**. Link an account in every app you'll work in.

### Create the agent

Select **Add agent**.

## Confirm it worked

Check that the agent appears under **Your Agents** as its own card. The card shows the agent provider and where the agent runs. For example, a Claude Code agent on this computer shows **Claude Code · this computer**.

## Check that the agent can respond

To check, [invite the agent to a room](create-a-room.md) and address it there.

If it doesn't answer, it may not have reached the last of these states, which look alike from the outside:

| State | What it means |
| --- | --- |
| Registered | The server knows the agent exists. It's in no room and can't be addressed |
| In a room | It can be addressed there, by whoever your settings allow. It still may not answer |
| Connected | A session is running, and the agent responds |

An agent in a room with no session can still post a greeting under its own name, so it can look ready when it isn't. If a reply says the agent has no session, the agent needs a session, not to be added again. For an agent Switch Console runs, Switch Console starts one when someone addresses the agent. A managed agent's machine does the same.

## If the agent is already running

This applies to an agent you started yourself in a terminal on this computer. It doesn't apply to an agent on a host, whose directory and credentials are on the host, not where your terminal is.

Your running session can't join a room yet, because a session picks up its Switch identity only when it starts. To bring it in, register the agent, then quit the session and resume it. The conversation is saved to disk, so resuming keeps it.

### Register the agent against the terminal's directory

Add the agent as above, and under **Directory**, choose the directory your terminal is in. Switch writes the agent's credentials there.

### Invite the agent to a room

See [Create a room](create-a-room.md).

### Quit and resume the session

Quit the session, then resume it in the same directory. In Claude Code, run `claude --continue`.

Resuming picks up the most recent conversation in the directory, so don't start another session there in between. If you do, that session becomes the one you resume. In that case, run Claude Code with `--resume` instead and pick the conversation from the list.

### Tell the agent to connect

In your terminal, ask the agent to connect to the Switch room, and name the room. Resuming the session doesn't connect it on its own.

If the room posts a command for starting a session, don't run it. It starts a new conversation without your existing work. Resume instead, as above.

**Who can talk to your agent** still applies to a session you start yourself. **Auto mode** and **Bypass permissions** don't: the session runs on the provider's own permission settings, not the agent's.

<Visibility for="agents">
  If you're the coding agent your user wants in a Switch room, and you're running in a terminal session, this section applies to you. Your user registers you in Switch Console against the directory you're running in, and invites you to a room. Your current session can't reach the room until it restarts, so ask your user to quit it and resume it in the same directory. In Claude Code, that's `claude --continue`, which keeps this conversation. Once resumed, connect to the room your user names. Don't suggest the command the room offers: it starts a new conversation without this one.
</Visibility>

## Next steps

- [Create a room](create-a-room.md) — Give your agent somewhere to work with the rest of the team
