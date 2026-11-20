# Add a server

_Let Switch Console run a server for you, or point it at one that already exists_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/add-a-server> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";

<BuddyGuide>
  Your team may already use Switch in its messaging app. If it does, you might not need to install anything. [Start here](index.md) helps you check.
</BuddyGuide>

A Switch server is where your rooms live and your agents connect. Add one before you set up agent providers, add agents, or create a room.

You don't have to install a server yourself. Switch Console either sets one up for you or connects to one that's already running.

## Choose how the server should run

Use this page to add a server after your first run. For the first run itself, follow [Set up Switch](quickstart.md), or [Bring your own agent](add-your-agent-to-your-team.md) to join your team's server. When you add a server, Switch Console offers the options in the table below.

**Tip**

At the top of the sidebar, you can also select **Add a server** before you add your first server. Once you've added one, that control becomes the server switcher. See [Add another server](#add-another-server).

| Option | Choose it when |
| --- | --- |
| **Run a server on this computer** | Switch Console sets up and runs Switch on this computer. Best for trying Switch out. |
| **Run or join a server on a remote host** | Switch Console sets one up over SSH on a host you onboard first, or joins the one already running there. Runs on a machine that stays up, so the server is still there after you restart your own. Restarting the host itself stops the server until you start it again. See [Onboard a remote host](../deploy/host-remotely.md). |
| **Connect to an existing server** | A Switch server is already running: your team's server, or one you deployed yourself. |

On a server where agent management is active, Switch Console automatically moves your agents onto a managed machine. Agent management is active by default on a server Switch Console runs. On a server someone deployed, agent management is only active if its administrator turned it on. See [What keeps your agent running](what-keeps-your-agent-running.md).

### Run a server on this computer

**Note**

[**Install and run Docker**](https://docs.docker.com/get-started/get-docker/) before you set up your local Switch server — Switch runs the server on your computer inside Docker. Docker Desktop, Rancher Desktop, or Docker installed through Homebrew all work.

You don't need to configure the stack yourself. Switch Console starts the server and everything it needs. It:

- Starts the messaging app and Gateway.
- Selects free ports and binds them to this computer.
- Creates an admin account.
- Signs Switch Console in automatically.

There is no URL to copy and no secret to enter.

The tradeoff is that the server belongs to the computer it's installed on. Colleagues can't sign in to it or register their own agents. They can still reach your agents if you connect the server to Slack, Discord, or Telegram and permit more people to talk to them. See [Choose how to run Switch](../deploy/index.md). Quitting Switch Console leaves the server running, but it doesn't come back on its own after you restart the computer.

The server can report an older version than the newest Switch release. That's expected: Switch Console installs a fixed server version.

**Tip**

Moving to a shared server later means registering your agents there again. To reuse a room's setup, capture the room as a template in Switch Console. The template brings the room's instructions, roles, aliases, and room documents. It also names things that exist only on the old server: the messaging app, the people, the agents, and the references. Edit the template to take those out before you run it on the new server, because the run fails instead of skipping what it can't find. Packages and library documents aren't captured, so attach them once the room exists.

### Run or join a server on a remote host

Onboard the host first. The dialog lists only hosts you've already added, so there's nothing to pick until you have one. Switch Console then connects over SSH and sets the server up there, or joins the server already running on that host. See [Onboard a remote host](../deploy/host-remotely.md) for what the host needs and how to add it.

### Connect to an existing server

Choose this option when a Switch server is already running and you have its address, whether your team runs it or you deployed it yourself. No server software is installed on your machine. Switch Console only connects to it.

You need a way to sign in to the server, and an account on the messaging app it's connected to. The sign-in is an account from the administrator of the Switch server, or your company sign-in if the server uses single sign-on. Switch Console can't create either account for you, and you'll be asked to link the messaging account before the setup is finished.

Switch Console asks for one **Server address**: the address the server's agents connect to, such as `https://switch.example.com`. <Since version="Switch Console 0.40" />

If Switch Console says the address answered with a web page, you've entered the address of a separate Gateway, not the server itself. Enter the server's own address instead, often the same host on port 8000.

## Link your messaging account

Switch has to know which account in the messaging app is yours. Without it, Switch can't identify you in a room.

When you connect to an existing server, Switch Console asks you to **Link your messaging accounts** as the last step. Each app listed there has its own **Link** button, and **Done** finishes the step whether or not you used one, so it's easy to move past without linking. However you added your server, you can also link an account at any time from the server's **Home** page.

Link the account for the messaging app where you'll create the rooms you, your agents, and your colleagues will use.

If Switch Console set the server up for you, that app is a Mattermost it started alongside the server, and you may not have signed in to it yet. On the server's **Home** page, under **Messaging apps**, locate the connection row for the desired account and select **Sign-in details…**.

**You can only link an account Switch can already see.** If you're not in the team or workspace the [connection](../resources/glossary.md#connection) reaches, the search returns nothing. Sort that out in the messaging app first.

**Note**

By default, an agent answers only its owner and the owner's other agents. Your agent won't respond to your first message until Switch can recognize the account you sent it from as yours.

**Tip**

You can link the other messaging apps later. Each app has its own account link.

### Link an account

### Link the app you'll collaborate in

On the **Home** page, under **Messaging apps**, select **Link** for the app you'll use. An unlinked app reads **No account linked**. The page also shows a prompt for each unlinked app, such as **Link your Slack account**, and its **Link account** button does the same.

### Find yourself in the directory

Search the linked app's directory. The field takes your name, handle or email, so try your handle if your name doesn't come back.

### Confirm it's you

Select **This is me** beside your name.

When it succeeds, the row replaces **No account linked** with your linked handle. Repeat these steps for every messaging app you'll use with Switch.

## Confirm it worked

After you add a server, its name and status appear at the top of the sidebar:

| Label | Meaning |
| --- | --- |
| **Running locally** | The server is running on this computer. |
| **Connected** | Switch Console is connected to a server it doesn't manage. |

A server can be unreachable, or it can be reachable without signing you in. Those are different problems with different fixes, and the status label is what tells them apart.

## Manage your servers

Once your first server is working, the following are optional.

### Add another server

Switch Console can hold more than one server, and you work in one at a time.

Unlike **Your Agents** and **Your Rooms**, the sidebar has no **Your Servers** section. Instead, the server you're working in is named at the top of the sidebar, and that name is the switcher. Select it, and the menu lists your servers under **Servers**.

From that menu, select any server in the list to switch to it, or select **Add server** to set up another. Switch Console asks how it should run, as it did the first time.

### Rename or remove a server

Switch to the server, then select **Server actions**, the button at the top right of its **Home** page. The menu renames the server, and for a server Switch Console doesn't manage it also edits the server address you connected with.

The last item removes the server, and it does something different depending on whether Switch Console manages it:

| Item | What it does |
| --- | --- |
| **Delete server…** | On a server Switch Console manages. Tears down the stack it created, including the containers and all their data and secrets, and asks you to type the server's name first, because nothing about it can be recovered. |
| **Disconnect from server…** | On a server Switch Console doesn't manage. It lets go of the server. Nothing on the server itself changes, and you can connect to it again. |

Either way, agents linked to that server are unlinked rather than deleted, so you can point them at another server afterward.

## Next steps

- [Set up agent providers](set-up-agent-providers.md) — Tell Switch which agent providers it can work with

- [Onboard a remote host](../deploy/host-remotely.md) — Add the machine your server will run on, if you chose the remote option
