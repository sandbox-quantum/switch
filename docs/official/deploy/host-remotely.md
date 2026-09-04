# Onboard a remote host

_Run a Switch server or an agent on a machine other than your own_

Published at <https://docs.flintai.dev/flintai/switch/deploy/host-remotely> — link readers there, not to this file.

Everything installed on a local Switch server runs on the machine in front of you. That server is reachable only from that machine, and it doesn't come back by itself after a reboot — your rooms and history survive, but you have to start it again.

A remote host is a machine Switch Console can reach over SSH and is authorized to use. Your server and agents keep running on the host when your own machine is closed, so your rooms stay live for your team. A host reboot stops them, and you have to start them again yourself. Onboard a host, then run a server or an agent on it, or both. Onboarding a host doesn't commit you to any of them.

**Note**

If a Switch server is already running and you have its Gateway and API addresses, you don't need a host to put one on — connect to it from [Add a server](../getting-started/add-a-server.md) instead. You might still want a host for your agents.

## What you need

**A machine that stays up.** A VM or container on your own laptop is a valid SSH target, but it goes down whenever your laptop does. That's fine if you're the only one who relies on that agent. It's a blocker when a teammate in another time zone needs it while you're asleep.

What it has to be:

- **Operating system:** Linux (Ubuntu 22.04 or 24.04) or macOS. **Not Windows** — there's no install path.
- **Architecture:** x86\_64 or arm64.
- **Size:** 2 vCPU, 4 GB RAM, 20 GB disk. Switch sets no minimum; this is a comfortable starting point.
- **Access:** SSH with your public key, plus `sudo`, or Homebrew on macOS.
- **Network:** it has to be able to reach your Switch server.

**SSH access that already works.** Switch Console offers the `Host` aliases in your `~/.ssh/config` and uses your SSH agent. It stores no credentials of its own, and it won't fix an SSH setup that's broken outside it.

**Docker on that machine**, if a Switch server is going to run there.

### Where to get one

If your organization already runs cloud infrastructure, try handing the list above to whoever provisions machines and asking for a small Linux VM.

To self-serve, look for a service that offers a Linux machine you can reach over SSH. Providers offer it under several names — virtual private server, VPS, cloud instance, compute instance, virtual machine — and for this purpose they're the same product.

**Tip**

The specs listed above are more than the entry tier for most providers, so make sure you compare pricing based on your needs.

Details to confirm about your host:

- **You get a shell on a machine you control.** Platforms that deploy an app for you — serverless, container hosting, managed app platforms — don't give you one, and they won't meet your Switch requirements. If the product talks about deploying your app rather than a server you log into, it's the wrong choice.
- **You choose the operating system image**, and Ubuntu 22.04 or 24.04 is among the choices.
- **You add your own SSH key**, and the account it gives you includes `sudo`.
- **You can run Docker on it**, if your Switch server is going to live there. A full virtual machine can; some container-based products can't.

## Onboard a host

### Open the remote hosts settings

Select **Settings** at the bottom of the Switch Console sidebar, then the **Remote hosts** tab.

### Identify the host by its SSH alias

Select **Add host** and fill in two fields. **SSH host** is a `Host` alias from your `~/.ssh/config`; Switch Console offers the aliases it finds, and accepts one you type that isn't there. **Display name** is what you'll recognize the machine by in Switch Console.

Prefer an alias you already have, so the connection uses the user, key and port your own SSH setup resolves.

### Install what the host is missing

Switch Console checks the host for what it needs and doesn't already have: the Claude Code CLI, the Switch connector, `git`, `tmux`, and Node.js 18 or newer.

Each one is a row of its own, carrying **Install**, **Update**, **Skip** and **Retry** as it applies. **There's no install-everything control** — work down the rows. A row reading **Could not be checked** is neither a pass nor a failure, and it needs another look.

### Confirm the host is ready

The host is usable once its status reads **Ready**. It now appears wherever Switch offers you a machine to run something on.

## Run a server on the host

Once the host is onboarded, it can carry a Switch server — the same server the local option gives you, on a machine that isn't the one in front of you.

What changes for you:

- **It stays up when your own machine doesn't.** The server runs on the host, so its rooms stay live while your laptop is asleep, closed, or restarting
- **You still reach it from Switch Console**, which connects to it through the host you onboarded. It isn't an address you hand out — a server other people connect to for themselves is a different setup, and if your team already runs one, connect to that instead
- **Nothing about rooms or agents changes.** They are set up exactly as they are locally

**Warning**

**A host reboot stops the server, and you have to start it again yourself.** The stack declares no restart policy and registers no service. Your rooms and history survive it: they're in Docker volumes on the host, so starting the server again brings everything back as it was.

## Run an agent on the host

An onboarded host shows up as a **Run location** when you register an agent, which is how an agent runs somewhere other than your laptop.

**The agent keeps answering after you quit Switch Console and close your laptop.** Console deploys a small process onto the host that holds the connection and starts a session when the agent is addressed.

**It stops when the host reboots, and you must launch Switch Console again to get it back.** That process runs under `tmux`, and nothing registers it as a system service. Your own machine closing is fine; the host restarting is not.

**Warning**

**Switch Console never clones your repository.** The working directory must already exist on the host, and the agent can use only the code that's present there. Any changes you haven't committed and pushed won't be available, so the host may hold an older version than your laptop. Switch Console won't report an error — the agent's responses will simply be based on the older code. Commit and push your changes before pointing an agent at a host directory.

The agent also needs **Auto-create a session on notify** switched on. On a remote host that setting is what causes the listener to be deployed at all, so with it off nothing starts by itself.

The working directory is a directory on that machine, so the access you're granting is that machine's access — see [Onboard your agents](../getting-started/onboard-your-agents.md).
