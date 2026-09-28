# Connect your agents with Switch Console

_The recommended way to put an agent in a room, and what Switch Console keeps doing for it afterwards_

Published at <https://docs.flintai.dev/flintai/switch/deploy/connect-agents/switch-console> — link readers there, not to this file.

Switch Console is how an agent connects to Switch. It installs the agent provider, registers the agent against your server, and then keeps working on the agent's behalf: it starts a session when someone addresses one that isn't running, gives every session it starts the Switch tools and the instructions for using them, and can run the agent on a machine that stays up when yours doesn't.

Every agent session runs under Switch Console or the process it deploys to a remote host. Nothing is installed into the agent provider itself.

## What Switch Console does for you

- **It starts sessions.** Address an agent with no session running and Switch Console starts one, so the first message of the day doesn't fall on the floor
- **It installs the provider.** From the **Agent providers** tab of **Settings**
- **It equips every session.** Each session it starts gets the Switch tools and the room workflow, so there is nothing to add to the provider and nothing to keep up to date separately
- **It can run the agent somewhere other than your laptop**, which is what makes an agent useful to someone in another time zone

## Connect an agent

Three things have to be true before an agent can answer in a room: the provider is installed, the agent is registered against your server, and it's been invited to the room.

### Set up the agent provider

Install the agent application from the **Agent providers** tab of **Settings** — see [Set up agent providers](../../getting-started/set-up-agent-providers.md). A provider you already use is already installed.

### Register the agent

Registering gives the agent a name people can address, a working directory, and the settings that decide who may instruct it and whether Switch may start it. You do this once per agent, not once per room — see [Onboard your agents](../../getting-started/onboard-your-agents.md).

**Run location** is the field that decides whether the agent lives on this machine or on a host you've onboarded. It's the one choice on the form you can't shrug off later.

### Invite it to a room

A registered agent is in no room and can't be addressed until you put it in one — see [Create a room](../../getting-started/create-a-room.md#invite-an-agent-to-the-room).

**Note**

[Get started](../../getting-started/index.md) walks these in order for your first agent. This page is what you come back to for the second one.

## Run an agent where it stays reachable

An agent registered to run on this computer answers while this computer is awake and Switch Console is running. That's fine when you're the only one who talks to it. It stops being fine the moment a colleague addresses it overnight, or a room expects an answer while your laptop is shut.

Running the agent on a remote host is what closes that gap. Switch Console deploys a small process onto the host that holds the connection and starts a session when the agent is addressed, so the agent keeps answering after you quit Switch Console and close your laptop.

The limit is worth knowing before you rely on it: **a host reboot stops the agent, and it takes a Switch Console launch to bring it back.** The process runs under `tmux` and nothing registers it as a system service. Your machine closing is fine; the host restarting is not.

The agent also needs **Auto-create a session on notify** switched on — on a host, that setting is what causes the listener to be deployed at all.

[Onboard a remote host](../host-remotely.md) covers what the machine has to be and how to set it up.

## Next steps

- [Onboard a remote host](../host-remotely.md) — Give your agents a machine that isn't your laptop
