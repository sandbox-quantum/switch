# Connect GitHub

_Let your Switch agents clone, branch, push, and open pull requests in the GitHub repositories you choose_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/connectors/github> — link readers there, not to this file.

With GitHub connected, your agents can clone, branch, push, and open pull requests in the repositories you choose. For how connectors work across services, see [Let your agents use your services](index.md).

## Before you begin

- **Connectors turned on for your server, with GitHub set up.** GitHub needs a GitHub App registered by the administrator of your Switch server, and the server's public address must be an `https` address. If the GitHub card shows **Unavailable**, it says which is missing. Ask the administrator of your Switch server.
- **Whether the agent asks for approval.** It depends on the agent's provider and settings. See [Check whether an agent asks for approval](index.md#check-whether-an-agent-asks-for-approval).
- **Agents act as the GitHub App, not as you.** Their pushes, pull requests, comments, and reviews show the App, not your account. Your GitHub account sets the limit: an agent gets only the repositories you choose, only while you can still open them yourself, and push access only while you can still push to them.
- **The connector isn't the only way an agent can reach GitHub.** For a repository outside what you chose, an agent can fall back to the GitHub sign-in on the computer it runs on, usually your own account, with everything that account can do. A repository cloned over SSH uses that computer's SSH keys, not the connector. Switch tells the agent to say so when it acts as that account instead of the App.

On a server without an `https` address, your agents can use GitHub through the GitHub sign-in on the computer they run on, with `gh` or `git`, instead of the connector. That route uses whatever that sign-in can do, so limiting an agent to read-only access doesn't apply. The GitHub card says when this route is available.

## Connect GitHub

### Start the connection

In the Switch Console sidebar, select **Connectors**, then the **Discover** tab. Select **GitHub**, then **Connect to Switch**. Your browser opens, and Switch Console waits while you sign in.

### Sign in and authorize

Sign in at GitHub and authorize the app. If your organization uses single sign-on, authorize the organization when GitHub asks.

### Return to Switch Console

When the page says you're connected, close the tab.

## Choose what each agent can do

When you turn GitHub on for an agent, choose read only, or read and push, and which repositories it can access. Each agent gets only what you choose, not everything your GitHub account can do. See [Turn a connector on for an agent](index.md#turn-a-connector-on-for-an-agent). To check it works, start a new [session](../../resources/glossary.md#session) with the agent, then ask it something small, such as *list the open pull requests in our repository*.

## Cut off access

**To stop one agent,** open the agent's page, select the plug icon, and turn GitHub off. **To stop every agent,** on the GitHub page under **Connectors**, select **Disconnect**.

- **Turning GitHub off for an agent ends its access straight away.** Switch revokes the access the agent already holds. If GitHub can't be reached, Switch keeps retrying, and the access expires within the hour regardless.
- **Disconnecting stops access immediately.** GitHub is the one connector where disconnecting also revokes access agents already hold.

## Troubleshooting

### An organization's repositories don't appear

**The organization uses single sign-on, and it hides its installation of the app from your connection.** Disconnect GitHub, connect it again, and authorize the organization when GitHub asks.

## Next steps

- [Let your agents use your services](index.md) — Connect another service, or check how approvals and cutting off access work
