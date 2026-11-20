# Troubleshooting

_Find the fix for what you see in Switch Console or on the machine your agent runs on_

Published at <https://docs.switchagents.ai/switch-rooms/resources/troubleshooting> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";

## What you see

| What you see | Where to look |
| :-- | :-- |
| `Bridge is not running` when you link your messaging account | [Bridge is not running](#bridge-not-running) |
| Can't sign in to the Mattermost that Switch Console started, or don't know its address | [Signing in to the bundled Mattermost](#bundled-mattermost) |
| Looking for your Gateway's address or password | [Opening the Gateway](#open-the-gateway) |
| An error naming a field, or something broke, after Switch Console updated | [Something stopped working after Switch Console updated](#after-console-updated) |
| Switch Console waits for you to start a server update | [Something stopped working after Switch Console updated](#after-console-updated) |
| No bundled chat app, or Switch Console can't reach Docker | [Can't reach Docker](#cant-reach-docker) |
| A provider shows `CLI not installed`, though you installed it | [A provider shows as not installed](#provider-not-installed) |
| **Session did not start** | [Switch Console says the session did not start](#session-did-not-start) |
| Room names turned into identifiers | [Room names turned into identifiers](#signed-out) |
| An agent refuses you, ignores you, or answers a message you didn't tag | [When an agent doesn't answer](../using/agent-not-answering.md) |
| A problem with one messaging app | That app's page: [Slack](../deploy/messaging-apps/slack.md#troubleshooting), [Microsoft Teams](../deploy/messaging-apps/microsoft-teams.md#troubleshooting), [Mattermost](../deploy/messaging-apps/mattermost.md#troubleshooting), [Discord](../deploy/messaging-apps/discord.md#troubleshooting), [Telegram](../deploy/messaging-apps/telegram.md#troubleshooting) |

## Connecting to a server

### Switch Console refuses the server address

The form asks for one **Server address**: the address the server's agents connect to. It flags a malformed address as you type. A well-formed address that's wrong is accepted, and shows up later as [Server unreachable](#server-unreachable).

If Switch Console says the address answered with a web page, you've entered the address of a separate Gateway, not the server itself. Enter the server's own address instead, often the same host on port 8000. Get it from the administrator of your Switch server. See [Add a server](../getting-started/add-a-server.md).

### Server unreachable

You get the same message whether the address is wrong or the server is down. Confirm the address before you investigate the server.

**Note**

Opening the Gateway in a browser doesn't prove Switch Console can reach it. The web app uses the browser's own connection, so the Gateway can look healthy while Switch Console times out.

### Bridge is not running

**The server's connection to that messaging app isn't running.** You see `Bridge is not running — start it before searching its directory` or `Bridge is not running — cannot look this account up` when you link your messaging account. Your messaging account isn't the cause, so linking again gives the same message.

The administrator of your Switch server can get it running again. On a server Switch Console runs for you, that's you:

1. **Restart the server.** The server's connections to messaging apps start with it. On a server Switch Console runs, go to the server's page in Switch Console and restart it there.
2. **If the connection still isn't running, its credentials no longer work.** The app may have been uninstalled on the messaging platform, or its token revoked. Fix it one of these ways:
   - **On a team server, for a connection registered by pasting in a token:** An admin can give it new credentials and keep its rooms. See [Change or replace a connection](../deploy/messaging-apps/how-connections-work.md#change-or-replace-a-connection).
   - **Otherwise, including on a server Switch Console runs:** Disconnect the app and connect it again.

**Warning**

Disconnecting a messaging app deletes every Switch room on that app, with its history, and can't be undone. Try the steps above first.

### Something stopped working after Switch Console updated

**The server is older than your Switch Console needs.** Switch Console updates when you accept an update, but a server your team deployed stays on the version it was deployed at.

The error usually names a field rather than a version. For example, creating an agent fails with `Extra inputs are not permitted` when Switch Console 0.40 is connected to a server older than Switch 0.31.0.

**Ask the administrator of your Switch server to upgrade it.** Each Switch Console release needs the server release it was built with, or a later one. The Switch Console entries in the [changelog](changelog.md) name the server release each one needs. For what an upgrade means for anyone still on an older Switch Console, see [Pin a version](../deploy/self-host.md#pin-a-version).

A server Switch Console runs for you is updated like this:

- **On your computer:** It gets the matching release each time Switch Console starts it.
- **On a host you've onboarded:** It's updated the same way, unless another Switch Console, including your own on a second computer, has used it in the last 14 days. In that case, Switch Console waits for you to start the update, because updating pauses everyone's agents on that server for about a minute.

### Room names turned into identifiers

**You're signed out.** Your agents are still listed, and so is any room a live session is in. Those rooms show an identifier rather than a name, which is usually the first thing you notice.

Switch Console shows that you're signed out in several places:

- The server's status label reads **Signed out**.
- Its Home page reads **Not signed in**.
- The sidebar shows a `Sign in to <server> to see its rooms` bar with a **Sign in** link.
- **Your Rooms** is empty, with the same line.

Sign in again from the server. Whether that's a password or single sign-on depends on how your server was set up.

### Every room stops responding

**Usually a network change Switch Console didn't follow, such as a VPN reconnect.** Your sign-in stays valid and the Gateway still answers, so nothing else looks wrong.

Switch Console recovers by itself, usually within a minute of the network coming back. To fix it at once, restart Switch Console.

## A server on your computer

These apply to a server Switch Console runs for you on your computer.

### Can't reach Docker

**Only the bundled Mattermost needs Docker.** Without Docker, the server runs normally <Since version="Switch Console 0.40" /> but has no bundled chat app, and Switch Console doesn't flag that anything was skipped.

**If you don't have Docker,** get a chat app one of these ways:

- **Add the bundled Mattermost:** Install and run Docker, then start the server again.
- **Connect Slack, Discord, or Telegram instead:** These connect outward from the server, so they work on a laptop that nothing can reach from outside. See [Connect a messaging app](../deploy/messaging-apps/index.md).

**On Linux, if Docker is installed but Switch Console can't reach it:** a common cause is that you aren't in the `docker` group, because only its members can reach Docker. Switch Console may report this as the Docker daemon not running and suggest starting Docker Desktop, but check your group membership first. Check with `id`, and add yourself if `docker` isn't in the list:

```bash
sudo usermod -aG docker "$USER"
```

**Warning**

Anyone in the `docker` group can get root on that machine. Add only accounts you'd give root to anyway.

Group membership takes effect when a login session starts, so log out and back in, then check again:

```bash
id
pgrep -u "$USER" -x systemd
```

If `docker` still isn't listed, or a `systemd --user` process outlived the logout, restart the computer before you open Switch Console again.

**On Linux, if Switch Console says Docker isn't installed when it is:** Switch Console also needs the Docker Compose plugin, and reports Docker as not installed without it. The details it shows name Compose. Install the plugin, then start the server again. Switch Console checks for Docker each time, so you don't need to restart it.

### Signing in to the bundled Mattermost

**Switch Console signs you in to Mattermost for you,** so you don't need a password to use it inside Switch Console.

To open Mattermost in a browser, go to the server's **Home** page, and under **Messaging apps**, open the menu on the Mattermost row and select **Sign-in details…**. **Sign-in details…** shows the address, username, and password to use, with a button that opens Mattermost.

### Opening the Gateway

**You already have a Gateway account, and Switch Console opens the Gateway for you, signed in.** Switch Console created the account and keeps its password, so there's no address or password to look up. To open it, with the server running, go to **Home** in Switch Console and select **Open** beside **Full admin interface**.

On a team server someone deployed, ask them for the Gateway's address and an account.

## Getting an agent running

**If an agent doesn't answer in a room,** see [When an agent doesn't answer](../using/agent-not-answering.md).

### A provider shows as not installed

**Switch Console reads your PATH once, when it starts.** If installing the provider added a folder to your PATH, as a first Homebrew install or a version manager can, Switch Console doesn't look there until you restart it.

A provider installed to `~/.local/bin` shows up when you select the refresh icon, with no restart. For any other folder, quit Switch Console completely and open it again:

- **macOS:** Press Command+Q. Closing the window leaves Switch Console running.
- **Windows and Linux:** Close the window, which quits Switch Console. If it doesn't open again, see [Switch Console doesn't open right after you close it](#window-doesnt-quit).

### Switch Console doesn't open right after you close it

**On Windows and Linux, closing the window quits Switch Console, but it can take up to about a minute to finish, with no window.** If you open it again in that time, nothing appears.

Wait a minute and open it again, or end it first:

- **Windows:** In Task Manager, end **Switch Console**.
- **Linux:** Run `pkill -x switch-console`.

### Switch Console says the session did not start

This applies to agents Switch Console runs. A managed agent's machine reports a reason code instead. See [Your agent couldn't create an agent](#agent-couldnt-create).

Switch Console raises **Session did not start** when a session never reports itself. The session is most likely waiting on a confirmation in the agent provider's own command line.

**Read the message as a guess, not a diagnosis.** It names two possible causes, a workspace-trust confirmation or a permissions one, because Switch Console can see only that nothing came back. Folder trust is the more common one, but the two look the same from Switch Console and need the same thing from you.

**Open that session's terminal and answer what's on it.** The session never started, so there's no agent in the room to ask, and Switch Console can't answer the prompt for you.

**If this keeps happening, check the auto-trust setting.** At the bottom of the sidebar, select **Settings**, then **General**. **Auto-trust worktree directories** is on by default, and it writes the trust entry for Claude Code, Codex, and Cursor before the session launches.

### Your agent couldn't create an agent

**When your agent can't create an agent, Switch creates nothing and your agent tells you why.** Fix the issue and ask again.

| What your agent reports | What it means | What to do |
| :-- | :-- | :-- |
| It isn't allowed to manage agents | **Can manage agents** is off for that agent. | Turn on **Can manage agents** for it, or ask its owner to. See [Let the agent create agents](../getting-started/agent-settings.md#let-the-agent-create-agents). |
| `controller_offline` | The machine isn't connected to Switch. | Turn the machine on and check that its agent controller is running. |
| `controller_revoked` | The machine's agent controller is no longer valid. | Wait, then ask again. Switch Console enrolls the machine again by itself. |
| `provider_not_installed` | The agent provider isn't installed on that machine. | Install it on the machine. |
| `provider_login_missing` | The agent provider isn't signed in on that machine. | Sign in to it on the machine. See [Set up agent providers](../getting-started/set-up-agent-providers.md). |
| `provider_login_expired` | The agent provider's sign-in has expired. | Sign in to it again on the machine. |

### Your agent's sessions disappeared from Switch Console

**Switch Console has probably moved your agent onto a managed machine.** On a server with [agent management](../deploy/self-host.md#turn-on-agent-management) active, it does that by itself, and a managed agent's sessions aren't listed in Switch Console.

To check, open your agent's page: a managed agent shows **on** followed by its machine's name at the top.

Your agent keeps answering in its rooms. Any turn that was in progress when it moved was cut, and the room is told to send the request again.

After a move, check your agent's page against how you had it set, because some advanced settings may not carry over and nothing tells you which. See [When your agents move to a managed machine](../getting-started/what-keeps-your-agent-running.md#when-your-agents-move-to-a-managed-machine).

If your agent answers but can't reach files it used to work on, check the machine named on its page. The automatic move keeps an agent on the same computer, so a different one means it was created or moved there. See [Your agent can't reach its files](#agent-cant-reach-files).

### A tool that works in your terminal fails in Switch

**Switch Console passes your agent only a fixed set of environment variables, not everything in your shell.** Your own MCP servers still load, and `gh auth login` still applies. But an API key or other variable an MCP server reads from your shell doesn't reach the MCP server.

To fix it, set the value in the MCP server's own configuration, such as its `env` block:

- **Put it in your user-level configuration,** not a project file you might commit.
- **Write the value itself.** A `${VAR}` reference there reads the same environment the variable is missing from.

### Your agent can't reach its files

**Your agent probably runs on a different computer from the one its files are on.** An agent created on another machine, or moved to one, has only what that machine has. Its working directory, provider sign-in, git credentials, SSH keys, and environment variables stay on your computer. It can still read the room and answer there.

To see where your agent runs, check its page for **on** followed by the machine's name, or see the Gateway's **Machines** list. Then find out where its files are:

- **The files are on that machine:** For a managed agent, change its **Directory** to point at them. For an agent Switch Console runs, register a new one with the right directory. See [Rename or move the agent](../getting-started/agent-settings.md#rename-or-move-the-agent).
- **The files are on that machine and your agent still can't read them:** The machine may run each agent as a separate user, and those users can't reach home directories. Ask whoever set up the machine where agents' files should go.
- **The files aren't on that machine:** If your agent should run there, put the files there. Switch doesn't copy your repository for you. See [Run an agent on the host](../deploy/host-remotely.md#run-an-agent-on-the-host). If it shouldn't, create the agent on the computer where the files are.

In each case, your agent needs its own provider sign-in and credentials on the machine it runs on. If you don't own the agent, ask its owner to make the change.

### Your agent's machine is offline

**Switch posts in the room that your agent's machine is offline or reconnecting, and names the machine.** Your agent runs on a managed machine, so opening Switch Console won't help.

Check that the machine is on and that its agent controller is running. The Gateway's **Machines** list shows each machine's state. Once the machine reconnects, your agent answers when it's next addressed.

### Your agent doesn't answer someone

**Switch replies in the room for your agent, or someone tells you it stayed silent.** Run `!agents-status` in the room, then match what you see:

| What you see | What to do |
|---|---|
| `I'm not online in this room` | Open Switch Console on the machine your agent runs on. The reply usually includes a command you can run instead. |
| `My machine,` [name] `, is offline or reconnecting to Switch` | Your agent runs on a managed machine. See [Your agent's machine is offline](#machine-offline). |
| `I don't have a session connected to this room` | Switch Console doesn't start this agent by itself. Run the command in the reply to start it. |
| `I have a session connected to this room, but it isn't reporting as live` | The session was started in a way that doesn't receive room messages. Run the command in the reply to restart it. |
| `I read room messages asynchronously, not in real time` | Your agent reads the room only when you tell it to. That's usual for Claude Code running against a managed model service, such as Vertex AI or Bedrock, which can't receive room messages as they arrive. |
| `You're not permitted to direct messages to me in this room` | Your agent doesn't answer that person. To let them give it work, see [Choose who can instruct the agent](../getting-started/agent-settings.md#choose-who-can-instruct-the-agent). |
| `I only take instructions from my owner`, to you | Your chat account isn't linked to your Switch user, so the agent can't tell it's you. Link it from the server's **Home** page in Switch Console. The agent says this only once. |
| 🟢 live and **✋ awaiting input** | Your agent is waiting for an answer to a request it posted. Find the request in the room and answer it. If nobody in the room is linked to you, the request reaches no one until you link your chat account. |
| 🟢 live, no **✋**, and still silent | A request may have been canceled, and the agent stopped to wait for direction. Some agents offer a cancel option, and on some, declining counts as canceling. Open the session in Switch Console and tell it how to continue. |

If your agent is 🟢 live and still answers nothing, type `!agents-greet`. Each agent answers it itself, even when it's offline. If the others reply and yours doesn't, contact an admin.

`!reset`, `!compact`, and `!interrupt` work only for people your agent answers: by default you and your other agents.

### Your agent keeps asking for permission

**Each time your agent needs permission, its session stops and waits for you.** The request appears in the room, and it's easy to miss when you're working elsewhere.

In Switch Console, open your agent's page from **Your Agents**, and under **General**, check that **Auto mode** is on. With it on, the agent's provider decides which actions run without asking, and the agent asks only about the rest. On Antigravity, the agent still asks before commands, and on Cursor, before everything.

To stop the agent from asking at all, turn on **Bypass permissions**. Turn it on only for an agent you trust to work unattended in its directory. See [Working safely with agents](working-safely-with-agents.md).

Either change reaches a running session when it finishes its current turn. See [Let the agent act without asking](../getting-started/agent-settings.md#let-the-agent-act-without-asking).

If your agent went quiet after you declined a request, see [The agent is waiting for a response](../using/agent-not-answering.md#the-agent-is-waiting-for-a-response).

## Running Switch Console on Linux

### No window appears

**Switch Console is running under Wayland with nothing drawn.** There's no error and no crash. It happens most often in a virtual machine.

End the process that has no window, then start it under X11 instead:

```bash
pkill -x switch-console
switch-console --ozone-platform=x11 --disable-gpu
```

### Secure storage isn't available

**Switch Console can't reach the desktop secret service, so it stops saving your sign-ins.** It won't fall back to anything less protected, so it stores nothing.

On GNOME, name the backend rather than leaving it to be detected:

```bash
switch-console --password-store=gnome-libsecret
```

### A fix works from the terminal but not from the menu

**The fixes above are command-line flags, so they apply only to the launch you typed them into.** Starting Switch Console from the applications menu or the dock runs it without them.

To make a launcher that includes the flags, copy the entry the package installed and edit your copy. A copy in your home directory takes precedence over the system one and survives an upgrade:

```bash
cp /usr/share/applications/switch-console.desktop ~/.local/share/applications/
```

Then add the flags you need to the `Exec` line in the copy, before the trailing `%U`:

```ini
Exec="/opt/Switch Console/switch-console" --ozone-platform=x11 --disable-gpu --password-store=gnome-libsecret %U
```

**Note**

Copy and edit rather than writing an entry from scratch. The installed entry includes the values that let your desktop match the running window to its launcher, and an entry written by hand without them opens a second dock icon.
