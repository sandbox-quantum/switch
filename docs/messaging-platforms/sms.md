# SMS with Twilio

Switch can bridge direct SMS conversations through a phone number in your own
Twilio account. Each allow-listed phone number maps to one direct Switch room.
SMS has no threads: replies from a Switch thread return to the same phone
conversation.

## Prepare Twilio

1. Create or use a Twilio project and buy an SMS-capable phone number.
2. Copy the **Account SID** and **Auth Token** from Twilio Console.
3. Decide which people may text the number and write their numbers in E.164
   form, such as `+14155550123`.
4. Set `MESSAGING_PUBLIC_URL` on Switch to a public HTTPS origin. Switch
   configures the number's incoming-message webhook when the connection starts.

In Switch Console, choose **SMS (Twilio)** and enter the Account SID, Auth
Token, Twilio number, allow-list, and maximum segments per reply. Switch checks
the account and confirms the number belongs to it before saving.

For US application-to-person traffic, complete the registration Twilio requires
for your number type (for example A2P 10DLC or toll-free verification). Twilio
trial accounts can send only to verified recipients.

## Security and retries

Every incoming form is authenticated with `X-Twilio-Signature` against the
exact public connection URL before its body is parsed. Do not put another URL
rewrite between Twilio and `MESSAGING_PUBLIC_URL`. Switch accepts messages only
when both `From` is allow-listed and `To` is the configured Twilio number.

Twilio's `MessageSid` is the durable message reference and webhook receipt ID.
A retry is therefore imported once even when several switch-core pods receive
traffic. Webhooks may reach any pod; SMS needs no lease-held socket.

## Length and cost controls

SMS is billed in segments. GSM-7 text fits 160 characters in a standalone
segment (extension-table characters count twice); text containing other Unicode
characters fits 70 UTF-16 code units. Switch splits on readable boundaries and
sends no more than **maximum segments per reply**. If a reply exceeds the cap,
the last segment says it was truncated and points the reader to Switch.

The cap applies to each relayed message, including agent and system replies.
Keep it low for alerting numbers, monitor Twilio usage, and use Twilio's own
spending controls. Twilio handles carrier STOP/START opt-out behavior; an opted
out number will not receive Switch replies until the carrier/Twilio permits it.

## Messages, commands, and media

- Texts and `!commands` enter the direct room under the sender's phone number.
- Agent names are prefixed because all agents share one Twilio number.
- Incoming MMS media is downloaded with Twilio authentication and Switch's
  configured attachment-size ceiling. Oversized or failed media is disclosed
  in the room.
- Switch cannot host a public Twilio `MediaUrl`, so outbound attachments fall
  back to a text notice naming the file.
- Approval and question cards use Switch's numbered text-answer fallback.
- SMS provides no edits, deletes, reactions, typing state, rooms, member
  invites, directory search, native cards, or slash commands.

Deleting the Switch room does not delete phone history or block the number.
Remove a person from the connection's allow-list to stop accepting new texts
and prevent replies to that number.
