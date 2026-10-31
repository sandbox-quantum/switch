# External Matrix

Switch can connect a dedicated bot account to rooms on any Matrix homeserver.
This connection is separate from Switch's internal Matrix transport: it uses the
external homeserver's standard Client-Server API and never points at or reuses
Switch's internal Tuwunel account.

## Create the bot account

1. Create a dedicated Matrix account on the homeserver you want to bridge.
2. Sign in with Element or another Matrix client.
3. Open **Settings → Help & About → Access token** (the exact location varies by
   client) and copy an access token. Treat it like a password.
4. Invite the bot account to each unencrypted room you want in Switch. The bot
   automatically accepts invitations while its bridge lease is active.

The token needs permission to sync, join invited rooms, read room state and
members, send/redact messages, upload/download media, create rooms, and invite
members. Those are ordinary powers of the bot account; no application service or
homeserver administrator token is required.

## Connect in Switch Console

Choose **Matrix** under **Connect a messaging app**, then enter:

- **Homeserver URL** — the bare origin, such as `https://matrix.example.com`.
- **Bot access token** — the dedicated bot account's access token.

Switch verifies the token with `/_matrix/client/v3/account/whoami` before saving
it. The homeserver URL is also checked by the deployment's outbound network
policy on create, edit, and every start.

## Rooms, threads, and identity

- Joined Matrix rooms map one-to-one to Switch rooms. A room with exactly the
  bot and one other joined member maps as a direct room; other rooms map as
  groups.
- Matrix `m.thread` roots are preserved as Switch thread roots in both
  directions.
- Every agent uses the same bot account, so outgoing messages show the agent's
  name at the start of the body. Matrix does not let one access token impersonate
  a different sender per event.
- Matrix HTML formatting is used with a required plain-text fallback.
- `!commands` work as ordinary room messages.
- Files are uploaded/downloaded through Matrix media endpoints and refused
  visibly when they exceed Switch's configured media limit.
- Switch can create rooms, invite Matrix user IDs, search the homeserver's user
  directory, edit its own messages with `m.replace`, and delete them with a
  redaction.

The adapter persists every `/sync` `next_batch` token in the bridge's connection
row after dispatching its events. On a crash before persistence, the homeserver
replays those events and their Matrix event IDs deduplicate them. On lease
handoff, the next pod resumes from the same cursor; quiet pods never run `/sync`.

## End-to-end encryption

Encrypted rooms are deliberately unsupported in this first version. The adapter
does not create a Matrix device, store cross-signing keys, or persist Megolm
sessions, so it refuses outbound messages and ignores ciphertext instead of
silently posting plaintext or pretending an encrypted event was delivered. The
connection shows an operator warning when it encounters an encrypted room.

Invite the bot to an unencrypted room. Supporting E2EE later requires a reviewed
shared device/key-store design that survives pod handoff; a process-local key
store would lose messages and split trust across replicas.

## Current limitations

- Approval and question cards use Switch's numbered text-answer fallback rather
  than Matrix widgets.
- Inbound Matrix edits and redactions are recognized but not applied because the
  shared collaboration ingress currently has no inbound edit/delete port.
- Room aliases are not required; stable room IDs are used throughout.
