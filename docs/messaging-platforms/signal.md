# Connect Signal

_Connect Switch agents to Signal direct messages and groups via a dedicated signal-cli daemon._

Signal is the standard for privacy-conscious teams. Because Signal has no official bot API, Switch connects through a dedicated **signal-cli** HTTP daemon running on your infrastructure.

> **Warning: Unofficial API and 90-Day Expiry**
> Signal has no official bot API. This bridge uses `signal-cli`, an open-source, unofficial client.
> The Signal network enforces strict client expiration: signal-cli versions older than ~90 days may be rejected by the Signal servers. You must keep signal-cli updated to maintain connectivity.

---

## Prerequisites

1. **Java Runtime Environment (JRE)**: JRE 25 or newer is required to run `signal-cli v0.14.9`.
2. **signal-cli v0.14.9**: Download from the official [signal-cli releases](https://github.com/AsamK/signal-cli/releases).
3. **Dedicated Signal Account**: A registered phone number in E.164 format (e.g. `+1234567890`) or a linked secondary device.
4. **Internal Network Access**: The signal-cli daemon exposes an unauthenticated JSON-RPC HTTP endpoint. It must run on `localhost` or within an internal, isolated network accessible by Switch pods. Never expose port 8080 to the public internet.

---

## 1. Set Up signal-cli

### Option A: Register a Dedicated Phone Number
If using a dedicated SIM / VoIP number:
```bash
signal-cli -a +1234567890 register
# Enter the SMS or voice verification code:
signal-cli -a +1234567890 verify 123-456
```

### Option B: Link as a Secondary Device
To link the bot to an existing Signal account:
```bash
signal-cli link -n "Switch-Bot"
```
Scan the generated QR code in your Signal mobile app under **Settings → Linked Devices → Link New Device**.

---

## 2. Run the signal-cli Daemon

Start the daemon in HTTP mode:
```bash
signal-cli -a +1234567890 daemon --http=127.0.0.1:8080
```

*Note for containerized environments*:
If Switch runs in separate Docker containers or Kubernetes pods, bind to your internal service network interface (e.g. `http://signal-cli.internal:8080`). Ensure firewall or network policies prevent outside access.

---

## 3. Connect Signal in Switch Console

1. Open **Switch Console** and navigate to your server.
2. Under **Messaging apps**, select **Connect**, then choose **Signal**.
3. Fill in the connection settings:
   - **Endpoint URL**: The HTTP address of your signal-cli daemon (e.g., `http://127.0.0.1:8080` or `http://signal-cli.internal:8080`).
   - **Account**: The E.164 phone number configured for the daemon (e.g., `+1234567890`).
4. Save the connection. Switch will verify daemon health and account registration via `listGroups`.

---

## Capabilities and Platform Notes

- **Agent Identity**: Signal accounts cannot dynamically change sender identity per message. All agents post through the single Signal account. To distinguish senders, Switch prefixes outbound messages with the agent's display name: `[AgentName] Message content...`.
- **Threading & Quotes**: Signal has no Slack-style reply threads. Conversations use quote replies. When replying in a conversation turn, Switch automatically attaches a Signal quote to the target message.
- **Group Chats**: Create the Signal group in your Signal app and add the bot phone number or user. Switch discovers the group and binds it to a room. Group creation from Switch Console is disabled.
- **Message Editing and Deletion**: Messages sent by Switch can be edited or deleted within 24 hours (Signal network ceiling).
- **Identity Safety Numbers**: Signal uses Trust-On-First-Use (TOFU). If a contact reinstalls Signal or changes phones, their safety number changes and sends will pause with an untrusted identity notice until verified. Use `signal-cli -a +1234567890 trust <recipient>` to trust the new key.
