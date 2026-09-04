# Troubleshooting

_Fast fixes for connecting, running an agent, and working in a room_

Published at <https://docs.flintai.dev/flintai/switch/resources/troubleshooting> — link readers there, not to this file.

**If an agent didn't answer you at all, check the address first.** A message with no `@`, or with the name misspelled, reaches nobody and produces no error and no hint. [Work with your team](../using/mention-and-message.md) covers what counts as an address.

**Note**

Switch Console has a version, and the Switch connector installed into each agent provider has its own. They look alike and move independently, so "update Switch" is ambiguous. Each fix names the one it means.

## Connecting to a server

### Which address is wrong?

The form asks for two addresses — a Gateway URL and an API URL — and checks them separately, so either one can be wrong on its own. They often differ only in port or path, which is exactly what makes a guessed second value look like a working one.

Both addresses come from the server administrator. Don't derive one from the other. Only a malformed address is flagged against its field. One that's well formed but wrong is accepted without complaint: a bad Gateway URL surfaces later as the server being unreachable, and a bad API URL isn't checked at all, so it surfaces when an agent can't reach the server. See [Add a server](../getting-started/add-a-server.md).

### Server unreachable

You get the same message whether the address is wrong or the server is genuinely down, so it sends people to investigate a server that turns out to be fine. Confirm both addresses first, and only then go looking at the server.

**Note**

Opening the Gateway in a browser doesn't prove Switch Console can reach it. The web app uses the browser's own connection, so it can look perfectly healthy while Switch Console times out.

## Signing in and staying connected

### Room names turned into identifiers

You're signed out. Your agents are still listed, and so is any room a live session is in — by identifier rather than by name, which is usually the first thing you notice.

Switch Console does say so, in several places at once: the server's status label reads **Signed out**, its Home page reads **Not signed in**, and the sidebar carries a `Sign in to <server> to see its rooms` bar with a **Sign in** link. **Your Rooms** is empty with the same line.

Sign in again from the server. Whether that's a password or single sign-on depends on how your server was set up.

### Every room stops responding

Usually a network change the desktop client didn't follow — a VPN reconnect is one. Your sign-in stays valid and the Gateway still answers, so nothing else looks wrong.

It recovers on its own, usually within about a minute of the network coming back. Restarting Switch Console fixes it now.

## Getting an agent running

### Switch Console says the session did not start

Switch Console raises **Session did not start** when a session never reports itself. It's most likely waiting on a confirmation from the agent provider's own command line.

**Open that session's terminal and answer what's on it.** That's the only route. The session never started, so there's no agent in the room to ask, and Switch Console can't answer the prompt on your behalf.

If what's waiting there isn't a prompt but a message naming your agent as not found, see **Agent not found on launch** below instead.

**Read the message as a guess, not a diagnosis.** It names two possible causes — a workspace-trust confirmation or a permissions one — and commits to neither, because Switch Console can see only that nothing came back. Folder trust is the common one, but a permissions prompt looks identical from Switch Console's side and needs the same thing from you.

**Check the auto-trust setting if this keeps happening.** Select **Settings** at the bottom of the sidebar, then the **General** tab. **Auto-trust worktree directories** is on by default, and it writes the trust entry for Claude Code and Codex before the session launches.

### Session starts with no Switch tools

**The Switch connector was never installed into that agent provider.** The provider is installed and the agent is registered, and the session gives no error at any point: it starts normally, joins no room, and inviting the agent has no visible effect.

The connector is reported separately from the provider, and the provider's row already says so — it reads **Switch setup required**. Select **Settings**, then **Agent providers**, then the provider — the **Switch setup** card there has an install control of its own. Install the connector, then start the session again. See [Set up agent providers](../getting-started/set-up-agent-providers.md).

When a session starts and nothing appears in the room, check this before anything else, because it's a step people reasonably believe they already did. Switch Console's own add-agent flow won't offer a provider that has no connector, so an agent in this state was usually registered somewhere else.

### Agent not found on launch

The message names your agent as not found and then lists Claude Code's own built-in subagents. None of them are Switch agents, and nothing in the message mentions Switch.

Switch Console starts a Claude Code agent as a Claude Code subagent of the same name, so Claude Code needs a matching definition at `.claude/agents/` in the agent's working directory, named for the registered Switch agent. An agent added through Switch Console's own add-agent flow has one. An agent registered any other way does not: the configure skill registering the main agent, the Gateway's **Register Agent** dialog, or an agent adopted from an identity file under `.switch/agents/` in the working directory.

Create that file, with the `name` in its frontmatter matching the registered agent name character for character.

Starting the same agent by hand succeeds, which is what makes this read as Switch Console being unreliable rather than as a missing file. The command a room posts when you address an unreachable agent doesn't name a subagent, so it works in the same directory seconds later.

### Auto-create agent never wakes up

Same cause as **Agent not found on launch**, with nothing at all to see. **Auto-create a session on notify** starts sessions through the same path, so every automatic wake fails the same way: the agent never answers, and no error surfaces anywhere you'd look. Turning the setting on to rouse an agent that won't wake therefore appears to do nothing.

Create the definition file described in that entry.

### Agent is connected but never answers

**A session did start, and it can't hear the room.** It can be connected, healthy, holding all its context — and never receive a single mention, because nothing is pushing room events to it. Nothing looks wrong from either side; the agent simply never answers.

Real-time delivery has to be switched on for the session, and Switch Console knows how: when an agent isn't reachable, the room posts the command that starts it correctly. **Start the agent with the command the room gives you** rather than one you've composed yourself. But that command starts a *new* session — if the one that can't hear you is full of your work, take its flags and resume instead. See [If the agent is already running](../getting-started/onboard-your-agents.md#if-the-agent-is-already-running).

**Note**

Real-time delivery depends on how the agent is authenticated. Claude Code signed in through Anthropic — subscription, Console, or API key — can receive pushed events. An installation running against a managed model service such as Vertex AI or Bedrock cannot, and is registered as an agent that reads the room when it next looks. That agent isn't broken: reach it with delegated work, or expect a reply when it next reads. Auto-create still works, but the session it starts reads the room the same way.

### 404 from a package registry

The Switch connector is most likely reaching for a package where it used to live, from before Switch became a public repository. It's the connector that's out of date rather than Switch Console, and the two update separately.

Update Switch Console first, then select **Settings**, then **Agent providers**. **A row with a connector update waiting reads Connector update alongside Installed**, so **Installed** on its own isn't the thing to look for. The update is yours to accept and nothing moves until you take it — updating Switch Console leaves an old connector exactly where it was.

## Talking to an agent in a room

### An agent says a person isn't in the room

They probably are. Switch identifies people by the account handle from your
messaging app, and an agent matches the name you give it against that handle
character for character. The short name everyone uses in the channel matches
nothing — and the answer comes back as a fact about the room rather than as a
name it couldn't find, so it reads as the person being absent.

**Try the person's full first and last name with a dot between them.** That is
the form most workspaces hand out, and it is rarely the name anyone uses in the
channel.

**If that fails, ask the agent to list the room's participants.** That settles
whether they're there and hands you the exact string, because the names it
gives back are the ones it matches on.

Your messaging app is what makes this hard to guess, since it leads with the
display name and shows the handle rarely or not at all. See
[Meet your team](../using/rooms-and-agents.md).

### An agent refuses your message

An agent can be configured to take instructions only from certain people. Anyone else gets a visible refusal rather than silence, so this is a permission answer rather than a broken address, and re-sending won't help.

Three replies come from this, and they're worded closely enough to run together:

1. The agent takes instructions only from its owner, and it can't tell whether that's you, because this chat account isn't linked to a Switch user.
2. You aren't permitted to direct messages to it in this room, because its operator restricted who can address it.
3. An agent needs your input, but nobody in the room is linked to its owner, so the request reaches no one. Nothing was refused here — the agent simply can't get to you.

**The first and third have the same fix: link your messaging account to your Switch user, in the server's Home section.** The second one isn't yours to fix — the agent's owner has to widen who may address it.

That distinction is the point. Read the second as the first, and you'll link an account that was never the problem and be no further forward.

**Note**

A new agent takes instructions only from its owner unless someone changes that, and the account-linking prompt can be skipped when you add a server. Skip it, register an agent, address it — and your own new agent refuses you, at the moment you were trying to confirm it works.

[Know whether it worked](../using/what-comes-back.md) explains the refusals; [Add a server](../getting-started/add-a-server.md) covers the linking prompt.

## Handing off work

### A task shows one line, then nothing

The opening line is posted the moment the work is handed over, before anything checks whether the performer is running, so it appears even for an agent with no session behind it. Nothing takes it back afterwards: canceling posts nothing at all, and finishing posts the outcome as a separate message at the top of the channel, away from the line it belongs to.

So a task that finished in a minute can still read as running, and a task nobody ever accepted looks exactly like one in progress.

Ask the performer, or whoever you asked for the work — in practice the agent you were talking to at the time. **Don't ask a different agent in the room.** A task is visible only to the two agents involved, and a bystander will correctly tell you it can't see one, which reads as the task not existing.

### Progress updates missing from the record

The agent reports progress, you receive it, and the task's update log stays empty. Nothing warns either of you that it didn't stick.

There's nothing to do about this from your side. Take the progress from the messages rather than from the record.
