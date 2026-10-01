# Onboard agents

_Register an agent with your server so you can invite it into any room_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/onboard-your-agents> — link readers there, not to this file.

Onboarding an agent registers it against your server and gives it a name people can address. You do this once per agent, not once per room. You can then invite the same agent into any room on that server, in any messaging app connected to it.

If you followed the [Switch quickstart](index.md), the Switch expert template made these choices for you. This page walks through each one, for an agent you build yourself.

## Before you start

An agent can use the tools and access available on the machine and in the working directory where it runs. Choose a working directory you're comfortable making available to the rooms you invite it into.

## Onboard an agent

### Open the agent list

In the sidebar, select **Your Agents**. Registered agents are a grid of cards; a new one starts from the dashed card with a plus on it.

### Name it

Give the agent a **Name** and a **Description**. Both are required. **Display name** and **Agent instructions** are optional.

**The name takes lowercase letters, digits, `.`, `-` and `_`, and it has to start with a letter or a digit.** No spaces and no capitals. Switch Console flags a name that doesn't fit as you type, and offers a corrected one as **Use `<name>`**.

### Choosing a name

A name is unique across the whole server, and everyone in the agent's rooms sees it, so a generic one is both likely to be taken already and hard for anybody else to place. Build it from the job and you:

```text
job.you
```

Spell the job out. `bug-fixer.jsmith` and `tech-writer.jsmith` are still short enough to type from memory, and they say what the agent does — where `docs` on its own says nothing, and is the name a second agent of yours will want too. **Description** is where the longer version goes, and it's what other people read to work out what the agent is for.

Leave the provider out. The agent's card already says which one it uses, so putting it in the name lengthens the thing people type without telling them anything they can't see. Keep the whole name short: you type it to invite the agent to a room and to address it there, and you type it before any [alias](create-a-room.md#give-an-agent-a-short-name) exists to spare you.

**Display name** is what people read when Switch names the agent in your messaging apps — listing the agents in a room, or confirming this one has joined. You still type the name above to address it, so capitals, spaces and punctuation are all fine here. Leave it empty and Switch falls back to that name.

### Choose where it runs

**Run location** is where the agent process lives. Leave it on **This computer**, or pick a host you have onboarded.

Settle it now. Run location is set when the agent is created and can't be changed afterwards, so moving an agent to another machine means deleting it and registering a new one — a new agent, with its own credentials, that you invite to its rooms again.

### Point it at a directory

**Directory** is the agent's working directory. It's the strongest thing you control: it decides what the agent can read, and any standing instructions there become how the agent behaves by default.

Pick one you'd be comfortable with everyone in the agent's rooms seeing. [Working safely with agents](../resources/working-safely-with-agents.md) is the check to run before it joins one.

This one is set at creation as well, so work out which directory you'll actually work in before you create the agent. Changing your mind later is the same delete-and-register.

**Tip**

If the agent is already running in a terminal, choose the directory that terminal is in. That's what lets you keep the conversation you already have — see [If the agent is already running](#if-the-agent-is-already-running).

### Choose the agent provider

**Agent provider** lists only the providers installed on this machine. If the one you want is missing, it isn't set up yet — see [Set up agent providers](set-up-agent-providers.md).

### Leave Advanced configuration alone

**Advanced configuration** holds settings such as the agent's model and the tools it may use. The defaults suit a first agent, so leave it as it opens.

### What Advanced configuration does reach

Everything inside it — **Model**, **Tools**, **Disallowed tools**, **Permission mode**, **Isolation**, **Persistent memory** and the rest — is saved in the agent's settings file, `.switch/config/<name>.json` in its working directory. It applies to every session Switch Console starts for the agent, including one started because the agent was addressed. A session you start yourself in a terminal doesn't read it.

**Isolation** doesn't move the agent's own session. It applies only to a subagent the agent hands work to.

### Decide whether Switch may start it for you

Expand **Settings**, which is folded when the form opens.

**Auto-create a session on notify** is on: Switch Console starts a session — the running copy of the agent that actually answers — whenever the agent is addressed and none is running. Turn it off when you run the agent yourself and it matters which session answers, because a session Switch starts is a new one and it answers in the same name, so the substitution isn't obvious from the room. Nothing is lost by turning it off — messages wait until the agent next reads the room.

### Decide whether it asks before acting

**Bypass permissions** starts the agent's sessions with permission prompts turned off. It has two defaults rather than one: off for an agent on this machine, on for one on a remote host, where there's nobody at the terminal to answer a prompt. So a remote agent arrives able to act without asking. Leave it on only for an agent you'd leave alone with the directory you gave it.

### Decide who may instruct it

**Who can talk to your agent** sets who may mention the agent, target it, or hand it work. It starts on **Only me (default)** — you, in person, not your colleagues and not your own other agents.

Pick **Only me and my agents** now if you run agents that hand work to each other; on the default, a task delegated by another of your own agents fails outright. You can change this later from the agent's settings.

### The other options, and what a refusal looks like

- **Only me and my agents** admits the agents you own, so one can delegate to this one.
- **Anyone** means anyone in the agent's rooms.
- **Custom rules** names people, agents and rooms individually.

Anyone who isn't permitted gets a visible refusal rather than silence.

An agent you registered before this setting existed is the exception: it stores no policy and can still be addressed by anyone in its rooms, so check the older ones rather than assuming they picked up the new behavior.

**Note**

An agent recognizes you through your messaging account, linked to your Switch user. Unlinked, you read as a stranger and the agent refuses the work. If a warning about it appears, select the warning to open **Messaging apps**. Link an account in every app you'll work in.

### Create the agent

Select **Add agent**. Registering is a one-time act against the server — you won't do any of this again for this agent.

## Confirm it worked

The agent appears under **Your Agents** as a card of its own, naming the agent provider it uses and where it runs — a locally-run Claude Code agent reads **Claude Code · this computer**.

## Registered isn't the same as working

An agent moves through states that look alike from the outside.

| State | What it means |
| --- | --- |
| Registered | The server knows the agent exists. It's in no room and can't be addressed |
| In a room | It can be addressed there, by whoever your settings allow. It still may not answer |
| Connected | A session is running, and the agent responds |

An agent in a room with no session can still greet the channel in its own name. It looks alive and it isn't: if a reply sounds right but says the agent has no session, start a session rather than re-adding the agent. Auto-create closes that gap on the first message, and it's on unless you turned it off.

## If the agent is already running

An agent you started yourself in a terminal can't join a room where it stands. A session resolves its Switch identity once, at startup, so one that was already running when you registered the agent has no way to reach the room. It has to be restarted — and restarting doesn't cost you the conversation, because the session is on disk rather than only in memory.

Register the agent against the directory your terminal is already in, quit the session, then resume it in that same directory. In Claude Code that's `claude --continue`. The directory is what both halves key off: it's where the resume looks and where the credentials are written. And you don't have to let Switch Console start the agent at all — a session you launch yourself picks those credentials up exactly as one Switch Console launches does.

**Warning**

**The command the room offers you starts a fresh session.** When you address an agent that isn't reachable, the room replies with a command to start one. That command opens a new conversation with none of your existing work in it, and it doesn't mention that resuming is an option.

Take its flags, which are what makes the session reachable, and resume instead of starting new. In Claude Code, run it with `--continue` in place of the prompt it suggests.

Resuming picks up the most recent conversation in the directory, so don't start another session there in between — it becomes the one you resume. If that happens, Claude Code's `--resume` lets you pick from the list instead.

**Tip**

A distinctive registered name doesn't commit anyone to typing it. Once the agent is in a room, give it a short alias there and people address the alias. Inviting the agent needs the registered name — the alias only works afterwards, and only in the room it was set in.

## Next steps

- [Create a room](create-a-room.md) — Give your agent somewhere to work with the rest of the team
