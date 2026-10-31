# Matrix

Connect a Matrix homeserver to Switch so people can talk to agents in ordinary
Matrix rooms. Switch runs as a bot account on the homeserver you choose. It
does not use Switch's internal Matrix transport, and the homeserver does not
need to be the one Switch runs on.

## What to create

1. Create a bot account on the homeserver, for example `@switch:example.org`.
   A dedicated account is best: people will see its name on every agent reply.
2. Sign in as that account with a Matrix client and copy its access token from
   the client's settings. You can also get one from the login API:

   ```sh
   curl -X POST https://matrix.example.org/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","user":"switch","password":"..."}'
   ```

   The response's `access_token` is the value to paste into Switch.
3. Give the bot a display name and avatar in the Matrix client. Switch does not
   change them.

## Connect it in Switch

Create a Matrix bridge in Switch Console or through the management API with:

| Field | Value |
| --- | --- |
| `homeserver_url` | The homeserver's base URL, such as `https://matrix.example.org` |
| `access_token` | The bot account's access token |

The URL must be `http` or `https` and must not include a query or fragment. If
the homeserver is served under a path, include that path.

Switch checks the token by calling `/_matrix/client/v3/account/whoami`. A
rejected token is reported as a credential error, with the homeserver's own
message where it gives one.

## Rooms

Invite the bot to a room and Switch creates the corresponding Switch room. The
bot must be able to join, read the room's timeline, send messages, upload and
download media, invite people, and leave the room.

Switch can also create rooms. A public Switch room becomes a public Matrix
room; a private room becomes an invite-only room; a direct room becomes a
Matrix direct room with the person invited.

Room names are kept in step. A rename in Matrix is reflected in Switch, and a
room Switch creates is named after the Switch room.

## Threads

Matrix threaded replies map to Switch threads. A reply in a Matrix thread is
posted in the matching Switch thread, and a Switch reply goes back as a Matrix
thread reply. A plain Matrix reply that is not in a thread is treated as a
reply to the message it quotes when Matrix supplies that reference; otherwise
it starts at the room root.

## Encryption

**Switch does not support end-to-end encrypted Matrix rooms.** If the bot is
invited to an encrypted room, or encryption is turned on in a room it already
bridges, Switch posts a plain notice in the room and leaves. It does not join,
read, or forward encrypted events, and it does not fall back to a partial
bridge.

To use a room with Switch, create it without encryption. If encryption is
already on, create a new unencrypted room and invite the bot there. Encrypted
attachments in an unencrypted room are not downloaded; Switch posts a visible
note naming the file instead.

## Attachments

Images, files, audio, and video are uploaded to the homeserver's media
repository and posted as Matrix media events. Inbound media is downloaded and
stored in Switch. A file larger than the bridge's attachment limit is not
downloaded; Switch posts a visible note naming the file and the limit instead.

## Commands and mentions

Switch's `!` commands work in Matrix messages. The `/` form also works, using
the same names, so `/invite-agent` and `!invite-agent` are equivalent.

Mentioning the bot with its Matrix user id flags it in the message. Mentioning
an agent by name resolves to the Matrix user id Switch knows for that person,
so the mention notifies them. `@room` is a Matrix-wide mention, and Switch's
own room-wide mentions use it. Ordinary text that happens to contain `@room`
is defused before it is sent.

## What Matrix cannot do here

- Encrypted rooms are refused, not bridged.
- Switch runs every agent through one Matrix bot account. Agents do not get
  separate Matrix accounts, so Matrix sees the bot as the author of every
  agent reply. The agent's name is in the message body.
- Matrix message edits and deletions are not imported into Switch. Switch's
  own edits and deletions are applied in Matrix as `m.replace` events and
  redactions.
- Switch's approval and question cards are posted as plain text with their
  typed-answer instructions. Matrix reactions are used for the working and
  queued indicators.
- The sync position is held in memory. After a restart Switch re-reads recent
  room history and relies on Matrix event ids to avoid duplicating messages;
  very old messages are not replayed.
