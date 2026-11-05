# IRC

Connect Switch to an IRC network using a dedicated bot nickname. Each agent
speaks through the bot, with its name at the beginning of every line.

## Connect the bot

1. Register a dedicated services account on your network. Follow the network's
   instructions for account registration and SASL PLAIN authentication.
2. In Switch Console, open **Connect a messaging app**, then choose **IRC**.
3. Enter the server hostname, TLS port (usually 6697), and bot nickname.
4. Enter the SASL account and password. If the account name equals the bot
   nickname, the account field can remain blank. A server password is a
   separate setting, used only by networks requiring the IRC `PASS` command.
5. Enter the channels to join, separated by commas, and connect.

TLS certificates must be trusted by the Switch server. For a private network
with its own certificate authority, install that authority in the server's
trust store. Passwords require TLS. Password login requires SASL PLAIN and
fails visibly if the network does not offer it. The adapter does not send
passwords to a user named NickServ as an authentication fallback.

An anonymous bot can connect with no password on networks allowing it.
Anonymous people can speak in bridged channels, but linking an identity and
using private conversations require a services account and IRCv3 account tags.

For a private or local IRC server, the Switch deployment must allow its
address with `OUTBOUND_ALLOWED_PRIVATE_HOSTS`. The running adapter resolves
and checks the address on every connection and connects to that checked IP.
Credential verification reads the same deployment allowlist from the
`OUTBOUND_ALLOWED_PRIVATE_HOSTS` environment variable and pins its connection
to the checked address as well.

## Rooms and people

Mention an agent by name in a channel, or use Switch's `!commands`. Ordinary
channel messages also reach the room. A signed-in person can message the bot
directly to create a private conversation.

Names follow the network's advertised `CASEMAPPING`, including RFC1459 and
strict RFC1459 networks. The verified mapping is stored with the connection
so every Switch pod uses the same channel identifiers.

Channel privacy comes from the server's `MODE` response. Secret, private,
invite-only, and key-protected channels are classified as private. An unknown
channel remains private until its modes are known. Mode changes update the
stored channel type through Switch's normal bridge lifecycle.

When channel creation is enabled, Switch joins a new channel with a random
suffix. Private channels must be confirmed secret and invite-only before
messages are sent. Inviting a person verifies that their current nickname
belongs to their services account. An unresolved, offline, or unverified
person is reported as someone who could not be invited.

## Approvals and activity

Approval and question cards appear as plain text with a handle and numbered
answers. Type the answer printed on the card, for example `A7 1`. The normal
Switch authorization rules apply. Link your services account to Switch using
`!link-account` before answering requests that require your Switch identity.

IRC cannot edit a line. Working status is posted once, followed by the final
status. A resolved card is posted again with its outcome. Duplicate status
redraws are suppressed while the adapter is running.

## Recovery and limits

- Only the pod holding the bridge lease opens an IRC connection. Other pods
  relay operations to it through Switch's existing holder relay.
- Reconnects use backoff and rejoin the channels recorded by Switch.
- Networks offering `draft/chathistory`, `draft/read-marker`, `server-time`,
  `message-tags`, and `batch` can replay channel messages after the last successful
  checkpoint. Configure the bot as an always-on account where required, such
  as on Ergo. A failed inbound delivery prevents that channel's checkpoint
  from advancing. Native message ids make replayed messages recognizable to
  Switch's normal duplicate handling.
- Networks without those capabilities cannot recover messages sent while
  disconnected. The adapter logs this limit at each connection.
- `echo-message` with `labeled-response` confirms outgoing posts and exposes
  server refusals. On older networks, a successful write is best-effort
  delivery. An interrupted send is reported as uncertain and is not silently
  retried.
- Requests accepted by the holder are kept in order and retried across a
  transient IRC reconnect. The shared holder relay is still transient. Work
  relayed during a gap with no holder, or queued when its holder stops, can be
  lost. This adapter does not add a separate durable outbox.
- Direct-message replay is unavailable. Send a new message after a disconnect
  to resume the conversation.
- IRC has no native threads, edits, deletion, reactions, or file attachments.
  Replies appear in the channel. Attachment fallback names the file in text.
  Edit and deletion attempts log their unsupported status.
- There is no complete account directory or web link to an IRC channel.
- Long messages are split on UTF-8 boundaries within IRC's 512-byte message
  limit, with room reserved for the server prefix. A paced writer sends a
  small burst followed by approximately one line per second.
