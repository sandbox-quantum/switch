# SMS (Twilio)

Connect Switch to standard cellular SMS via your own Twilio account and phone number.
Anyone with an authorized phone number can interact with Switch agents directly via text messaging.

## Prerequisites

1. A [Twilio](https://www.twilio.com) account.
2. A Twilio SMS-capable phone number.
3. Your **Account SID** and **Auth Token** from the [Twilio Console](https://console.twilio.com).

## 1. Connect SMS in Switch Console

1. In Switch Console, open **Connect a messaging app** and choose **SMS**.
2. Fill in the connection form:
   - **Account SID**: Your 34-character Twilio Account SID (`AC...`).
   - **Auth Token**: Your Twilio Auth Token.
   - **Twilio Phone Number**: Your Twilio number in E.164 format (e.g. `+1234567890` or `+919876543210`).
   - **Allowed Phone Numbers (Allow-list)**: Comma- or newline-separated list of sender phone numbers allowed to text in (E.164 format). **Required** to prevent unauthorized strangers from running up carrier costs.
   - **Max Reply Segments**: Maximum number of SMS segments per agent reply (default `3`). Bounds outbound carrier billing.
3. Click **Connect**. Switch validates your credentials against Twilio's API before saving.

## 2. Configure Twilio Webhook

Once connected, Switch displays your connection's public webhook address:

```text
https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge_id>/events
```

1. Open the [Twilio Console → Phone Numbers → Active Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming).
2. Select your Twilio phone number.
3. Scroll to **Messaging Configuration**:
   - Under **A MESSAGE COMES IN**, select **Webhook**.
   - Paste the webhook URL from Switch.
   - Select **HTTP POST**.
4. Click **Save configuration**.

## How it works

### Room mapping
SMS has no native room or group structure. Each incoming conversation maps deterministically to a 1-on-1 direct message room (`channel_type = "direct"`), identified by the sender's E.164 phone number (`channel_id`).

### Outbound agent identity
Replies from Switch are sent from your Twilio phone number. Agent names are prefixed to the message text (e.g. `[SupportAgent] Your server is online.`).

### Cost bounding and segment estimation
Carrier networks bill SMS messages in segments:
- **GSM-7 characters**: 160 characters for a single message, or 153 characters per segment for concatenated messages.
- **UCS-2 characters** (emoji, non-Latin characters, smart quotes): 70 characters for a single message, or 67 characters per segment concatenated.

Switch automatically estimates character encoding and fits the reply (including agent name and truncation warning) within your configured `max_segments` budget before sending in a single Twilio API call. If a reply exceeds the budget, it is cleanly truncated at a word boundary with `[...truncated to N segments]`.

### Security and abuse protection
- **Webhook Authenticity**: Every incoming request is cryptographically validated using Twilio's `X-Twilio-Signature` HMAC-SHA1 header against the canonical webhook address.
- **Allow-list**: Senders not included in `Allowed Phone Numbers` are dropped immediately without triggering agent execution or incurring reply fees.
- **Deduplication**: Retried Twilio webhooks are recognized by their `MessageSid` and processed at most once across all Switch pods.

## What SMS cannot do

Cellular SMS is a simple text transport with platform-declared limitations:
- **No message edits or deletions**: Sent SMS cannot be edited or recalled; `update_message` and `delete_message` are no-ops.
- **No threading**: Conversations are sequential flat text; all messages are routed directly to the sender's 1-on-1 direct room.
- **No reactions or typing indicators**: Emoji reactions and typing indicators are omitted to avoid spamming the user with extra billed SMS segments. Switch remains silent while the agent processes the turn, sending only the final response.
- **Interactive approval and question cards**: Approval requests and user questions fall back to plain-text neutral summaries. Since SMS provides no interactive buttons, users can text their answer back or act on the card directly within Switch Console.
- **No channel creation or directory search**: Cannot create chat rooms or search external user directories (`supports_channel_creation = False`, `supports_directory_search = False`).
- **Attachments (MMS)**: Inbound MMS media is downloaded and delivered up to the bridge's attachment limit. Outbound media links are passed via Twilio's `MediaUrl` when a public URL is available; local binary attachments without a public host fall back to Switch's standard disclosed text notice (`_sent an attachment that couldn't be relayed: <filename>_`). Native MMS delivery is carrier- and region-dependent (primarily US/Canada).
