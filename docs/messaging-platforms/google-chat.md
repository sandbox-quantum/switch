# Google Chat

Connect Google Chat to Switch to let people and AI agents collaborate in spaces and direct messages (DMs).

## Architecture: Cloud Pub/Sub & Workspace Events

Switch connects to Google Chat using **Cloud Pub/Sub pull subscriptions** combined with **Google Workspace Events API subscriptions**, rather than a public HTTPS webhook endpoint alone:

1. **Complete Room Context**: Google Chat App interaction events only notify the app when it is directly `@mentioned`, added to a space, or when a user clicks a card or runs a slash command. Ordinary unaddressed messages in a space do *not* generate interaction events. To provide agents with full room context and conversation history, Switch creates Workspace Events subscriptions on each bound space.
2. **Unified Delivery**: Cloud Pub/Sub serves as the single delivery pipe for both Chat App interaction events (mentions, slash commands, card actions) and Workspace Events CloudEvents (ordinary messages, membership changes).
3. **No Ingress Port Required**: Switch workers pull events from Google Cloud without exposing public HTTP endpoints or configuring webhook ingress tunnels.
4. **Multi-Pod Lease Safety**: Following Switch's `keeps_quiet_unless_listening` lifecycle, only the lease-holding switch-core pod maintains the Pub/Sub pull loop and proactively renews Workspace Events subscriptions. Other pods can safely execute outbound REST calls (sending messages, editing, deleting) without duplicate consumption.

---

## Step-by-Step Setup Guide

### 1. Create a Google Cloud Project & Enable APIs
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new Google Cloud project (e.g. `switch-google-chat`) or select an existing project.
3. Navigate to **APIs & Services → Library** and enable the following APIs:
   - **Google Chat API** (`chat.googleapis.com`)
   - **Cloud Pub/Sub API** (`pubsub.googleapis.com`)
   - **Google Workspace Events API** (`workspaceevents.googleapis.com`)

### 2. Configure Cloud Pub/Sub Topic and Subscription
1. Navigate to **Pub/Sub → Topics**.
2. Click **Create Topic**. Name the topic (e.g., `switch-chat-topic`).
3. Click on the newly created topic, select the **Permissions** tab, and click **Grant Access**:
   - New principals: `chat-api-push@system.gserviceaccount.com`
   - Role: `Pub/Sub Publisher` (`roles/pubsub.publisher`)
   *(This grants the Google Chat service permission to publish interaction events to your topic).*
4. Under the topic, create a **Pull Subscription**:
   - Subscription ID: e.g., `switch-chat-sub`
   - Delivery type: **Pull**
   - Acknowledgment deadline: `60 seconds`
   - Retain unacknowledged messages: `7 days`

### 3. Create Service Account Credentials
1. Navigate to **IAM & Admin → Service Accounts**.
2. Click **Create Service Account** (e.g., `switch-chat-bot`).
3. Grant the Service Account the **Pub/Sub Subscriber** role (`roles/pubsub.subscriber`) on your project or subscription.
4. Click on the created service account, go to the **Keys** tab, click **Add Key → Create new key**, and select **JSON**.
5. Save the downloaded JSON file. You will paste its contents into the `service_account_json` field in Switch Console.

### 4. (Optional) Configure User OAuth for Workspace Events
If you want Switch to receive ordinary unaddressed space messages:
1. Navigate to **APIs & Services → OAuth consent screen**:
   - User Type: **Internal** (recommended for Workspace organizations).
   - Scopes: Add `https://www.googleapis.com/auth/chat.messages.readonly`, `https://www.googleapis.com/auth/chat.spaces.readonly`, `https://www.googleapis.com/auth/chat.memberships.readonly`.
2. Navigate to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application** or **Desktop app**.
3. Obtain a refresh token for your operator user account with the requested scopes, and provide `user_client_id`, `user_client_secret`, and `user_refresh_token` in the Switch connection settings.

### 5. Configure the Google Chat App
1. Navigate to **Google Chat API → Configuration** in the Cloud Console:
   - **App name**: `Switch` (or your bot's name).
   - **Avatar URL**: URL to your bot avatar image.
   - **Description**: AI Agent Orchestration with Switch.
   - **Interactive features**: Turn ON.
   - **Functionality**:
     - Check **Receive 1:1 messages**.
     - Check **Join spaces and group conversations**.
   - **Connection settings**: Select **Cloud Pub/Sub**.
     - Enter the Pub/Sub topic name: `projects/<PROJECT_ID>/topics/switch-chat-topic`.
   - **Slash commands**:
     - Add Slash Command:
       - Command name: `/invite-agent`
       - Command ID: `1`
       - Description: Invite an agent to the space.
2. Click **Save**.

---

## What Requires a Google Workspace Admin

Depending on your organization's Google Workspace policies, certain setup actions may require a Google Workspace Administrator:

- **Chat App Visibility and Installation**:
  If your organization restricts external or unpublished Chat apps, an admin must approve or allowlist the Chat app in the [Google Workspace Admin Console](https://admin.google.com/) under **Apps → Google Workspace → Google Chat → Chat apps**.
- **OAuth App Data Access Consent**:
  If user consent for third-party apps is restricted, an admin must grant consent or trust the OAuth client ID for the Workspace Events read scopes.
- **Why Domain-Wide Delegation is Avoided**:
  Switch explicitly avoids requiring domain-wide delegation or admin-level `chat.app.*` scopes. All app interactions authenticate via standard Service Account token exchange (`chat.bot`), and space subscription creation uses standard user-delegated OAuth consent.

---

## Connection Settings Reference

| Field | Type | Description |
|---|---|---|
| `service_account_json` | string (password) | GCP Service Account key JSON for token minting and Pub/Sub consumption. |
| `project_id` | string | Google Cloud Project ID. |
| `subscription_id` | string | Cloud Pub/Sub pull subscription name or full resource path. |
| `topic_id` | string (optional) | Cloud Pub/Sub topic name for Workspace Events notifications. |
| `user_client_id` | string (optional) | OAuth2 client ID for Workspace Events space subscriptions. |
| `user_client_secret` | string (optional, password) | OAuth2 client secret for Workspace Events space subscriptions. |
| `user_refresh_token` | string (optional, password) | OAuth2 refresh token for Workspace Events space subscriptions. |
| `slash_command_map` | object (optional) | Mapping of numeric Google Chat slash command IDs (e.g. `{"1": "invite-agent"}`). |

---

## Capabilities & Known Limitations

- **Shared App Sender Identity**:
  Google Chat displays all outbound messages under the single configured Chat App identity. Switch cleanly prefixes the specific agent's name in outbound messages and cards (e.g. `*Agent*: ...`).
- **Outbound Attachment Link Fallback**:
  Native Google Chat media upload requires user-level OAuth credentials. For app-authenticated sends, Switch provides a clear text-and-link fallback describing the attachment filename, size, and MIME type.
- **Approvals & Cards v2**:
  Approval cards are drawn using Google Chat `cardsV2` with interactive buttons. Card clicks are processed with opaque token validation, single-winner semantics, and card patching.
- **Free-Text Question Fallback**:
  Because Google Chat modal dialogs (`action_response: DIALOG`) require synchronous HTTPS responses and cannot be opened over asynchronous Cloud Pub/Sub, free-text questions fall back to threaded plain-text reply instructions.
- **Inbound Edits & Deletes**:
  Outbound edits and deletes of the app's own messages are supported. Inbound edit/delete events from Google Workspace Events are received but not mirrored to agent history until core generic edit event handling (Issue #804) lands in switch-core.
- **Channel Creation & Directory Search**:
  Declared as unsupported on the adapter, as standard Chat bots cannot create spaces or enumerate organization users without admin scopes.

