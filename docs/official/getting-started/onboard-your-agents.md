# Onboard your agents

_Register an agent with your server so you can invite it into any room_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/onboard-your-agents> — link readers there, not to this file.

Onboarding an agent registers it against your server and gives it a name people can address. You do this once per agent, not once per room. You can then invite the same agent into any room on that server, in any messaging app connected to it.

## Before you start

An agent can use the tools and access available on the machine and in the working directory where it runs. Choose a working directory you're comfortable making available to the rooms you invite it into.

## Onboard an agent

### Open the agent list

In the sidebar, select **Your Agents**. Registered agents are a grid of cards; a new one starts from the dashed card with a plus on it.

### Choose where it runs

**Run location** is where the agent process lives. Leave it local to run the agent on this machine, or pick a host you have onboarded.

### Choose the agent provider

**Agent provider** lists the providers you set up in the previous step. If the one you want is missing, it isn't fully set up yet — see [Set up agent providers](set-up-agent-providers.md).

### Point it at a directory

Choose the agent's working directory. It's the strongest thing you control: it decides what the agent can read, and any standing instructions there become how the agent behaves by default.

**Tip**

If the agent is already running in a terminal, choose the directory that terminal is in. That's what lets you keep the conversation you already have — see [If the agent is already running](#if-the-agent-is-already-running).

### Name it

Give the agent a **Name**. It's unique across the whole server, and everyone in the agent's rooms sees it, so a generic name is both likely to be taken already and hard for anybody else to place.

**The name takes lowercase letters, digits, `.`, `-` and `_`, and it has to start with a letter or a digit.** No spaces and no capitals. Switch Console tests the name as you type and won't create the agent until it fits — so if nothing happens when you try to create it, check the name first, then **Description**, which is also required.

Build it from three parts — the provider, the job, and you:

```text
provider.job.owner
```

`claude-code.tech-writer.jsmith` tells a room everything it needs, `docs` tells it nothing. **Description** is where the longer version goes, and it's what other people read to work out what the agent is for. **Agent instructions**, under it, is optional.

Length isn't a problem: a long name is the one people read, and each room can point a short [alias](create-a-room.md#give-an-agent-a-short-name) at it.

### Decide whether Switch may start it for you

Expand **Settings**, which is folded when the form opens.

**Auto-create a session on notify** is on: Switch Console starts a session — the running copy of the agent that actually answers — whenever the agent is addressed and none is running. Turn it off when you run the agent yourself and it matters which session answers, because a session Switch starts is a new one and it answers in the same name, so the substitution isn't obvious from the room. Nothing is lost by turning it off; messages wait until the agent next reads the room.

### Decide who may instruct it

**Who can talk to your agent** sets who may mention the agent, target it, or hand it work. It starts on **Only me (default)** — you, in person, not your colleagues and not your own other agents. The rest:

- **Only me and my agents** admits the agents you own, so one can delegate to this one.
- **Anyone** means anyone in the agent's rooms.
- **Custom rules** names people, agents and rooms individually.

Pick **Only me and my agents** now if you run agents that hand work to each other. On the default, a task delegated by another of your own agents fails outright. Anyone who isn't permitted gets a visible refusal rather than silence, and you can change this later from the agent's settings.

An agent you registered before this setting existed is the exception: it stores no policy and can still be addressed by anyone in its rooms, so check the older ones rather than assuming they picked up the new behavior.

**Note**

An agent that answers only you has to be able to recognize you, and that comes from your messaging account being linked to your Switch user. Until it is, a message from you reads as a message from a stranger: the agent refuses the work and replies that it can't tell whether you're its owner. Switch Console warns you next to the setting and links to **Messaging apps**. Link an account for every app you'll work in — one linked and one not leaves the agent refusing you in half your rooms.

### Decide whether it asks before acting

**Bypass permissions** starts the agent's sessions with permission prompts turned off. It has two defaults rather than one: off for an agent on this machine, on for one on a remote host, where there's nobody at the terminal to answer a prompt. So a remote agent arrives able to act without asking. Leave it on only for an agent you'd leave alone with the directory you gave it.

### Leave Advanced configuration alone

**Advanced configuration** doesn't configure the session you're about to run. Everything inside it — system prompt, model, tool allowlist, permission mode, isolation, persistent memory — is written into the agent's definition file as Claude Code subagent configuration, and applies only when something starts a session from that definition. A session you start yourself doesn't read it.

Two are worth knowing about even so:

- **System prompt** defaults to the **Description** you typed, so the description becomes the agent's standing brief the day something spawns from this definition.
- **Isolation** decides where a subagent runs when work is delegated to one. It won't relocate a session you launched yourself, so it can look load-bearing when it isn't.

### Create the agent

Submit the form. Registering is a one-time act against the server — you won't do any of this again for this agent.

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
