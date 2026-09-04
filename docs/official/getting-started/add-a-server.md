# Add a server

_Let Switch Console run a server for you, or point it at one that already exists_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/add-a-server> — link readers there, not to this file.

A Switch server is where your rooms live and your agents connect. Add one before you set up agent providers, onboard agents, or create a room.

You don't have to install a server yourself. Switch Console can run one on this computer, set one up on a remote host, or connect to a server that's already running.

## Choose how the server should run

Switch Console opens with the **Setting up Switch** checklist in front of you. **Add a server** is its first step — select it, and Switch Console asks how the server should run.

**Tip**

You can also select **Add a server** at the top of the sidebar before you add your first server. Once you've added one, that control becomes the server switcher — see [Add another server](#add-another-server).

| Option | Choose it when |
| --- | --- |
| **Run a server on this computer** | Switch Console sets up and runs the full Switch stack locally with Docker. Best for trying Switch out. |
| **Run a server on a remote host** | Switch Console sets up over SSH on a host you've onboarded. Runs on a machine that stays up, so the server is still there after you restart your own. See [Onboard a remote host](../deploy/host-remotely.md). |
| **Connect to an existing server** | A Switch server is already running and you have its Gateway and API addresses — your team's server, or one you deployed yourself. |

### Run a server on this computer

Everything runs on your computer, in Docker.

**Note**

[**Install and run Docker**](https://docs.docker.com/get-started/get-docker/) before you set up your local Switch server — Switch runs the server on your computer inside Docker. Docker Desktop, Rancher Desktop, or Docker installed through Homebrew all work.

You don't need to configure the stack yourself. Switch Console starts the server and everything it needs. It:

- Starts the messaging app and Gateway.
- Selects free ports and binds them to this computer.
- Creates an administrator account.
- Signs Switch Console in automatically.

There is no URL to copy and no secret to enter.

The tradeoff is that the server belongs to the computer it's installed on. Colleagues can't connect to it. Quitting Switch Console leaves the server running, but it doesn't come back on its own after you restart the computer.

**Tip**

Moving to a shared server later means registering your agents there again. A room's setup can be carried across from the Gateway, but the agents have to exist on the new server first.

### Run a server on a remote host

Choose this option when you want the server on a machine that stays up rather than on your own. Switch Console connects to a host you've onboarded over SSH and sets up the server there.

See [Onboard a remote host](../deploy/host-remotely.md) for what the host needs and how to add it.

### Connect to an existing server

Choose this option when a Switch server is already running and you have its Gateway and API addresses — whether your team runs it or you deployed it yourself. No server software is installed on your machine; Switch Console just connects to it.

Both addresses are required:

- **Gateway URL** - the administrative surface for the server.
- **API URL** - the address Switch Console uses to communicate with the server.

**Note**

They're validated separately, and they may differ only by a port or path, so take both from the server itself rather than deriving one from the other. Don't guess the API URL from the Gateway URL.

If the form rejects an address, the error identifies the field that failed. Check that address first; it doesn't necessarily mean the server is unreachable.

## Link your messaging account

Switch has to know which account in the messaging app is yours. Without it, Switch can't identify you in a room.

When you connect to an existing server, Switch Console asks you to **Link your messaging accounts** as the last step. However you added your server, you can also link an account at any time from the server's **Home** page.

Link the account for the messaging app where you'll create the rooms you, your agents, and your colleagues will use.

**You can only link an account Switch can already see.** If you're not in the team or workspace the bridge is connected to, the search returns nothing — sort that out in the messaging app first.

**Note**

By default, an agent answers only its owner. Your agent won't respond to your first message until Switch can recognize the account you sent it from as yours.

**Tip**

You can link the other messaging apps later. Each app has its own account link.

### Link an account

### Link the app you'll collaborate in

On the **Home** page, under **Messaging apps**, select **Link** for the app you'll use. An unlinked app reads **No account linked**.

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

From that menu, select **Add server** to set one up — Switch Console asks how it should run, the same way it did the first time — or select any server in the list to switch to it.

### Rename or remove a server

Switch to the server, then select **Server actions**, the button at the top right of its **Home** page. The menu renames the server, and for a server Switch Console doesn't manage it also edits the Gateway and API addresses you connected with.

The last item removes the server, and it does something different depending on whether Switch Console manages it:

| Item | What it does |
| --- | --- |
| **Delete server…** | On a server Switch Console manages. Tears down the stack it created — the containers, and all data and secrets with them — and asks you to type the server's name first, because nothing about it can be recovered. |
| **Disconnect from server…** | On a server Switch Console doesn't manage. It lets go of the server. Nothing on the server itself changes, and you can connect to it again. |

Either way, agents linked to that server are unlinked rather than deleted, so you can point them at another server afterwards.

## Next steps

- [Set up agent providers](set-up-agent-providers.md) — Tell Switch which agent providers it can work with

- [Onboard a remote host](../deploy/host-remotely.md) — Add the machine your server will run on, if you chose the remote option
