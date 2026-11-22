# Connect Google Workspace

_Let your Switch agents work with Google Drive, Docs, Sheets, Slides, and Calendar as you_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/connectors/google-workspace> — link readers there, not to this file.

With Google Workspace connected, your agents can work with Google Drive, Docs, Sheets, Slides, and Calendar as you. For how connectors work across services, see [Let your agents use your services](index.md).

## Before you begin

- **Connectors turned on for your server, with Google Workspace set up.** If its card shows **Unavailable**, ask the administrator of your Switch server to set it up.
- **The Google account you want agents to use.** Agents act as that account, with everything it can see and change. There's no read-only option for Google Workspace.
- **Whether the agent asks for approval.** It depends on the agent's provider and settings. See [Check whether an agent asks for approval](index.md#check-whether-an-agent-asks-for-approval).

## Connect Google Workspace

### Start the connection

In the Switch Console sidebar, select **Connectors**, then the **Discover** tab. Select **Google Workspace**, then **Connect to Switch**, then **Connect Google Workspace**. Your browser opens, and Switch Console waits while you sign in.

### Choose the right Google account

Google shows an account chooser first. Pick the account your agents should use, not a personal account you're also signed in to.

### Allow access

Google lists what Switch asks for: to see, edit, create, and delete your Drive files, Docs, Sheets, and Slides, and to view and edit your Calendar. Select **Allow**. The app name on this screen is the one the administrator of your Switch server registered with Google.

### Return to Switch Console

When the page says you're signed in and connected, close the tab. The Google Workspace page in Switch Console shows **Connected as** with your account, and **Read and write**.

Then turn Google Workspace on for each agent that needs it. See [Turn a connector on for an agent](index.md#turn-a-connector-on-for-an-agent). To check it works, start a new [session](../../resources/glossary.md#session) with the agent, then ask it something small, such as *list the files I changed in Drive this week*.

## Cut off access

**To stop one agent,** open the agent's page, select the plug icon, and turn Google Workspace off. **To stop every agent,** on the Google Workspace page under **Connectors**, select **Disconnect**.

- **Access already handed out lasts up to about an hour.** After you turn Google Workspace off for an agent, access the agent already holds keeps working for up to about an hour.
- **Disconnecting removes the sign-in Switch holds for your Google account.** Switch stops handing out new access. Access an agent already holds keeps working for up to about an hour.
- **To end access sooner,** in your Google account's settings for third-party apps, remove the access you gave Switch.

## Troubleshooting

### Agents are using the wrong Google account

**You picked a different account in the Google account chooser.** On the Google Workspace page in Switch Console, select **Disconnect**, then connect again and pick the right account.

## Next steps

- [Let your agents use your services](index.md) — Connect another service, or check how approvals and cutting off access work
