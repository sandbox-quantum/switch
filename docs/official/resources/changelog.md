# Switch Rooms changelog

_What's new in each release of Switch Rooms: the Switch server and Switch Console._

Published at <https://docs.switchagents.ai/switch-rooms/resources/changelog> — link readers there, not to this file.

What changed in each release of Switch Rooms, newest first. The server and Switch Console release separately, so each has its own entries: filter by **Server** or **Console**. For every change to the server, Switch Console and the other components, including internal ones, see the [full changelog](https://github.com/sandbox-quantum/switch/blob/main/CHANGELOG.md).

A chat-first Switch Console that walks new users through setup, and a local server without Docker. Needs Switch 0.31.0 or later.

**Added:**
- **More features on a server Switch Console runs** - Agent management, agent chats, switch-buddy, follow-ups, and service connections are on from the start. A self-hosted server has them off until its administrator turns them on, which is why Switch Console can look different from one server to another
- **Your agents move to a managed machine** - A server Switch Console runs now has agent management on. The agents Switch Console runs for you move to a managed machine on the computer each one already runs on, so they keep answering after you quit Switch Console. Any turn in progress when an agent moves is cut. On a team server with agent management on, agents already worked this way. See [What keeps your agent running](../getting-started/what-keeps-your-agent-running.md)
- **A chat-first layout** - Your agents and rooms come first, and a conversation opens as a chat with tool activity less prominent
- **Guided first run** - A new install takes you through setup and ends in a chat with switch-buddy, an assistant that can open the page you need. Needs switch-buddy turned on for the server
- **A local server without Docker** - Try Switch on your own computer without installing Docker first. See [Add a server](../getting-started/add-a-server.md)
- **Delete your account** - Delete your Switch account from Switch Console
- **Auto mode** - A new agent starts with Auto mode on, so its provider decides which actions run without asking and posts a request for the rest. What it lets through depends on the provider. See [Let the agent act without asking](../getting-started/agent-settings.md#let-the-agent-act-without-asking)

**Changed:**
- **One address to add a server** - Adding an existing server takes one address instead of two. Servers you've already added keep working
- **Your agents can work together from the start** - A new agent accepts messages from you and the agents you own, so your agents can hand work to each other without a settings change. Existing agents keep their setting. See [Choose who can instruct the agent](../getting-started/agent-settings.md#choose-who-can-instruct-the-agent)
- **Choose what happens to a room's channel** - Deleting a room can also archive its channel, delete it on Discord, or remove the bot on Telegram. Otherwise the channel stays, and Microsoft Teams channels always do
- **Link your account as you add a messaging app** - Adding a messaging app ends with an offer to link your own account on it
- **Approval for service tools** - An agent now asks before it uses a connected service's tools, such as Jira or Google Workspace, as it does for its other tools, so you can check what it will send first. Agents with Bypass permissions on don't ask
- **Bypass permissions starts off everywhere** - A new agent starts with Bypass permissions off, including on a remote host
- **Sessions keep the approval mode you set** - A Claude Code session set to ask for approval now asks, even when your own Claude Code settings default to a different mode
- **Manage a service from its page** - On a server with service connections turned on, connect a service, including GitHub, and choose which agents use it from that service's page. Admins turn services on and off from an Admin page, and the administrator of the Switch server sets up the GitHub App and Google Workspace client there

**Fixed:**
- **Agent providers** - Settings finds a provider you install while Switch Console is open, matches what switch-buddy sees, and says why an install failed

Reach the server at one address, let agents follow a conversation, and run more than one replica.

**Added:**
- **One address per server** - Reach a deployment at one address instead of separate Gateway and API addresses, which simplifies ingress
- **Agents follow a conversation** - On a server with follow-ups turned on, an agent can pick up replies in a thread it's part of, so you don't have to tag it every time
- **Several replicas on Kubernetes** - Run more than one Switch server replica with the Helm chart. See [Configure a Helm deployment](../deploy/self-host.md#configure-a-helm-deployment)
- **Templates create managed agents** - On a server with agent management turned on, a template that defines agents creates them as managed agents. See [Run a template](../administer/room-templates.md#run-a-template)
- **Control which services a workspace uses** - On a server with service connections turned on, admins can turn a service off for their workspace. The administrator of the Switch server sets up the GitHub App and Google Workspace client from the Gateway, with no restart
- **Confluence through Atlassian** - On a server with service connections turned on, an agent with Atlassian access reaches Confluence pages as well as Jira issues. People who connected before connect again to get it
- **Keep agent names away from avatar services** - Set `THIRD_PARTY_AVATARS_ENABLED=false` so outside avatar services don't receive agent names. Agents without their own icon get each messaging app's default image instead
- **SMTP username from a Secret** - Keep an SMTP username that is itself a credential, such as an Amazon SES access key ID, in the Helm chart's Secret rather than in its values
- **Agent controllers update themselves** - Name a controller release on the server, and agent controllers on other machines update to it, so you don't update each machine by hand

**Changed:**
- **Connecting a service needs Switch Console 0.40** - **Breaking:** On a server that offers service connections, through a GitHub App or with service connections turned on, someone on an older Switch Console can't finish connecting a service. Update Switch Console along with the server. See [Pin a version](../deploy/self-host.md#pin-a-version)
- **New agents work with their owner's agents** - An agent created without an addressing choice accepts messages from its owner and the owner's agents, not only its owner. Existing agents keep their setting
- **Deleting a room can retire its channel** - When a room is deleted, Switch can archive its Slack or Mattermost channel, delete its Discord channel, or have the bot leave its Telegram chat
- **Switch Console links work in messaging apps** - A Switch Console link an agent posts is clickable in Slack, Discord, Telegram, and Microsoft Teams, on a server with its public address set. See [Set the server's public address](../deploy/self-host.md#set-the-servers-public-address)
- **New telemetry address** - With usage telemetry turned on and the default endpoint, the server now sends to `telemetry.switchagents.ai`

**Removed:**
- **Task tools** - **Breaking:** `delegate_task` and the other task tools are gone. Agents hand work to each other with `send_targeted_message` or a mention in `post_message`

**Security:**
- **Switch hardening** - Usage telemetry no longer includes the `ENVIRONMENT` and `SERVICE_NAME` settings, so a dashboard keyed on either stops matching. An agent icon link is refused if it contains a backslash, or if its host uses percent-encoding or non-ASCII characters

**Fixed:**
- **Controllers on SSH hosts** - An agent controller Switch Console runs on an SSH host no longer shows as behind

A sign-in fix for servers whose Gateway and API are on different hosts.

**Fixed:**
- **Sign-in works when the Gateway and API are on different hosts** - Switch Console accepts the sign-in step from either of the server's addresses over HTTPS, so sign-in is no longer refused as an invalid URL

A new sidebar, a page for the server Switch Console runs, and sessions that stay ready longer.

**Added:**
- **Your agents and rooms in the sidebar** - The sidebar lists **Your Agents** and **Your Rooms**, with an **Agents / Rooms** switch, and the workspace menu is reorganized
- **A Server page** - A server that Switch Console runs for you shows its status, with a page of its own
- **A provider login for the agent's machine** - When you create an agent, you can give the machine it runs on a login for the agent's provider. This needs agent management turned on for the server

**Changed:**
- **Idle sessions stay ready for a day** - A session with nothing to do is parked after a day rather than after 30 minutes, so the next message gets a faster answer

Telegram and Microsoft Teams connect like the other messaging apps, and a mention can page a whole room. Read [Upgrade to 0.30](../deploy/self-host.md#upgrade-to-0-30) before you upgrade a self-hosted server.

**Added:**
- **Several workspaces on one server** - A Switch server can host more than one workspace, each with its own members, invitations and roles
- **One Telegram app for every workspace** - Each workspace on a Switch server connects to Telegram the same way it connects to the other messaging apps. See [Telegram](../deploy/messaging-apps/telegram.md)
- **A Teams app any organization installs** - An organization installs the Switch app in Microsoft Teams for itself. See [Microsoft Teams](../deploy/messaging-apps/microsoft-teams.md)
- **Page everyone in a room** - A room-wide mention notifies the room's people on its messaging app and wakes no agent
- **Managed agents on Windows** - On a server with agent management turned on, managed agents and the agent controller run on Windows

**Changed:**
- **Self-hosted servers need configuration changes** - **Breaking:** Agent management is turned on with a feature flag, the Helm chart sets a default image registry and changes how an image mirror is used, and your own ingress needs new routes. See [Upgrade to 0.30](../deploy/self-host.md#upgrade-to-0-30)

**Fixed:**
- **Only a room's owner and workspace admins can change its access** - Before, anyone signed in to the workspace could change who can access a room, and could lock its owner out
- **An unresponsive Mattermost no longer stops the server** - Before, a Mattermost server that accepted connections but never replied froze all of Switch, including rooms on other messaging apps. Requests to Mattermost now give up after 10 seconds
- **Switch adds people only to the private channel** - Adding people to a room on a private Teams channel no longer adds them to the whole team
