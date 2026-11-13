# Onboard a remote host

_Run a Switch server or an agent on a machine other than your own_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/host-remotely> — link readers there, not to this file.

A remote host is a machine Switch Console can reach over SSH and is authorized to use. A server or agent on a host keeps running when your own computer is closed, so your rooms stay live for your team. A host reboot stops them: Switch Console starts your agents again once it can reach the host, but you have to start the server again yourself. Onboard a host, then run a server or an agent on it, or both. Onboarding a host doesn't commit you to either.

**Note**

If a Switch server is already running and you have its address, you don't need a host for the server. Connect to it from [Add a server](../getting-started/add-a-server.md) instead. You might still want a host for your agents.

## Before you begin

You'll need:

- **A machine that stays up:** a VM or container on your laptop is a valid SSH target, but it goes down whenever your laptop does. That's fine if you're the only one who relies on the agent, and a blocker when a teammate in another time zone needs it while you're asleep.
- **SSH access that already works:** get SSH to the host working in a terminal first. Switch Console offers the `Host` aliases in your `~/.ssh/config` and uses your SSH agent, with no credentials of its own.
- **An SSH user that can install software:** Switch Console runs every install as that user and never escalates to root on its own, so a directory the user can't write to stops the install. When that happens, Switch Console says so and changes nothing on the host. Install that piece by hand, then re-check.
- **Docker on the machine, if a Switch server will run there.**

The machine needs:

- **Operating system:** Linux (Ubuntu 22.04 or 24.04) or macOS. **Not Windows**: there's no install path.
- **Architecture:** x86\_64 or arm64.
- **Size:** 2 vCPU, 4 GB RAM, 20 GB disk. Switch sets no minimum; this is a comfortable starting point.
- **Access:** SSH with your public key, plus `sudo`, or Homebrew on macOS.
- **Network:** outbound internet access, because onboarding downloads Node.js and system packages, and running a server there pulls container images. A host that runs an agent also has to reach your Switch server.

### Where to get one

If your organization already runs cloud infrastructure, hand the list above to whoever provisions machines and ask for a small Linux VM.

To self-serve, look for a service that offers a Linux machine you can reach over SSH. Providers call it a virtual private server, VPS, cloud instance, compute instance, or virtual machine. For this purpose, they're the same product.

**Tip**

The size above is more than most providers' entry tier, so compare plans against it.

Confirm these about a plan:

- **You get a shell on a machine you control.** Platforms that deploy an app for you, such as serverless, container hosting, and managed app platforms, don't give you one, and they won't meet your Switch requirements. If a product talks about deploying your app rather than a server you log into, it's the wrong kind.
- **You choose the operating system image**, and Ubuntu 22.04 or 24.04 is among the choices.
- **You add your own SSH key**, and the account it gives you includes `sudo`.
- **You can run Docker on it**, if your Switch server is going to live there. A full virtual machine can; some container-based products can't.

## Onboard a host

### Open the remote hosts settings

At the bottom of the Switch Console sidebar, select **Settings**, then **Remote hosts**.

### Identify the host by its SSH alias

Select **Add host**, then fill in **SSH host** and **Display name**. **SSH host** is a `Host` alias from your `~/.ssh/config`. Switch Console offers the aliases it finds, and accepts one you type that isn't there. **Display name** is what you'll recognize the machine by in Switch Console.

Prefer an alias you already have, so the connection uses the user, key, and port your SSH setup resolves.

### Install what the host is missing

Switch Console checks the host and reports what it finds in two groups. **Prerequisites** covers Git and Node.js, and Switch Console installs either one the host doesn't have. **Agent types** has a row for each agent provider.

Every row shows what was found (a version and **Installed**, or **Not installed**) and offers only the controls its state calls for:

- **Install** when something is missing
- **Update** when a newer version is known
- A re-check that probes that row alone

A failed install turns **Install** into **Retry**. **There's no install-everything control.** Work down the rows. To probe the whole host again, find the status at the top and select **Re-check** beside it. A row reading **Could not be checked** is neither a pass nor a failure, so re-check that row.

Select a row to open its detail panel, where you can skip it. For a failed install, the panel explains the failure in full and offers **Show output** for what the command returned. A failed install leaves the host unchanged.

### Confirm the host is ready

The host is usable once its status reads **Ready**. That status counts the prerequisites, so a host reads **Ready** with no agent provider on it yet. That's what you want if you're only going to run a server there.

The host now appears wherever Switch offers you a machine to run something on.

## Run a server on the host

An onboarded host can run the same Switch server the local option gives you, on a machine that isn't the one in front of you.

What changes for you:

- **It stays up when your own machine doesn't.** The server runs on the host, so its rooms stay live while your laptop is asleep, closed, or restarting.
- **You still reach it from Switch Console**, which connects to it through the host you onboarded. It isn't an address you hand out. A server other people connect to for themselves is [a different setup](self-host.md). If your team already runs one, connect to that instead.
- **Rooms and agents work as they do on a local server.** They don't carry over from a server you already run, because each agent is registered against one server.

**Warning**

**A host reboot stops the server, and you have to start it again yourself.** Your rooms and history survive: they're in Docker volumes on the host, so starting the server again brings everything back as it was.

## Run an agent on the host

When you register an agent, an onboarded host appears as a **Run location**. That's how an agent runs somewhere other than your laptop.

**The agent keeps answering after you quit Switch Console and close your laptop.** Switch Console deploys a small process onto the host that holds the connection and starts a session when the agent is addressed. On a server that runs agent management, the host's agent controller runs the agent instead; see [What keeps your agent running](../getting-started/what-keeps-your-agent-running.md).

**A host reboot stops it until Switch Console reaches the host again.** With Switch Console open, the agent comes back by itself, which can take a few minutes after the host is up. With it closed, the agent comes back when you next open it.

**Sign in to the agent provider on the host yourself.** Switch Console installs the provider's command-line tool there but doesn't sign it in. In Switch Console, select **Settings**, then **Remote hosts**, and open the host. If a provider shows **Not signed in**, copy the login command shown there, run it in a terminal on the host, then select **Recheck**.

**Warning**

**Put your code on the host yourself.** Switch Console doesn't clone your repository, so the working directory must already exist on the host, and the agent uses only the code there. Commit and push your changes before pointing an agent at a host directory. Otherwise the host may hold an older version than your laptop, and the agent answers from it with no error.

The working directory is a directory on that machine, so the agent works with the access that machine has, not the access your laptop has. See [Add a custom agent](../getting-started/add-a-second-agent.md).
