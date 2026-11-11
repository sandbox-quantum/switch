# Signal Collaboration Bridge

This page explains how to connect a Signal account to Switch using the
signal-cli JSON-RPC HTTP daemon.

## Prerequisites

- **signal-cli** installed and configured on a machine accessible to Switch.
  - See the [signal-cli documentation](https://docs.signal.org/signal-cli/) for installation instructions.
  - A **dedicated Signal number** is strongly recommended. Using your personal Signal number
    will bridge your personal conversations into Switch rooms, which is usually not desired.
- The signal-cli daemon running with `--http` flag:
  ```bash
  signal-cli -u +1234567890 daemon --http=0.0.0.0:8080
  ```
  - For a linked device (recommended): first link with `signal-cli link -u +1234567890`,
    then run the daemon with the same `-u` flag.
  - For a standalone registration: `signal-cli -u +1234567890 register`, verify,
    then run the daemon.
- The daemon must be reachable from the Switch server over HTTP/HTTPS.
  - **Never expose the signal-cli HTTP endpoint to the public internet!**
  - Bind to localhost/private networks only, or place behind a reverse proxy with authentication.
  - If you must expose it, place it behind a reverse proxy with HTTP Basic authentication
    (configure the `username` and `password` connection fields in Switch).

## Connection Configuration

In Switch Console, add a new Signal bridge with these fields:

| Field | Description | Required |
|-------|-------------|----------|
| **Daemon URL** | The signal-cli HTTP daemon base URL (e.g. `http://localhost:8080`) | Yes |
| **Account** | The registered Signal phone number in +E.164 format (e.g. `+1234567890`) or ACI UUID | Yes |
| **Username** | Optional HTTP Basic auth username (if the daemon is behind a reverse proxy) | No |
| **Password** | Optional HTTP Basic auth password (if the daemon is behind a reverse proxy) | No |

## How It Works

- **Groups only**: Signal groups are bridged as Switch rooms. 1:1 direct messages are not bridged.
- **Quote-replies for threading**: Signal has no native threads. Replies in Switch are sent as Signal quote-replies.
- **Typing indicators**: Shown via Signal's typing indicator (15-second timeout).
- **Edits and deletes**: Outbound edits/deletes are mirrored via Signal's edit and remote-delete APIs.
- **Attachments**: Sent as data URIs; received via Signal's attachment API.
- **Formatting**: Signal messages are plain text, so Switch Markdown is rendered as plain text (emphasis markers are dropped, links are spelled out, headings and code fences are unwrapped). Signal text-style ranges are not sent.
- **Long messages**: Split cleanly at paragraph boundaries below Signal's message size limit.
- **Approval/question cards**: Rendered as plain text with typed-answer grammar (`A1 yes`, etc.). Answers are submitted by replying to the card message with the option handle (e.g., `A1 yes`).

## Security Considerations

**⚠️ Critical: Use a dedicated Signal number!**

- signal-cli is an **unofficial client**. Using it may violate Signal's Terms of Service and risk account bans.
- **Never use your personal Signal number** for a Switch bridge. Register a dedicated/secondary number.
- The signal-cli HTTP endpoint has **no built-in authentication**. Anyone who can reach it can send messages as that number.
  - **Never expose the daemon port to the public internet.**
  - Bind to localhost or private networks only.
  - If the daemon must cross network boundaries, front it with a reverse proxy with HTTP Basic auth (configure `username`/`password` in Switch).
- The signal-cli data directory contains the account's private keys. Protect and back it up; loss means re-registration.
- Keep signal-cli updated; protocol changes can break older versions.

## Supported Features

| Feature | Status |
|---------|--------|
| Group messaging | ✅ |
| Direct messages | ❌ (1:1 chats not bridged) |
| Quote-replies (threading) | ✅ |
| Text formatting | Plain text only (links spelled out; bold/italic/code markers dropped) |
| Attachments (images, files) | ✅ |
| Edits & deletes (outbound) | ✅ |
| Typing indicators | ✅ |
| Approval/question cards (typed answers) | ✅ |
| Slash commands | ❌ (use `!command`) |
| Channel creation from Switch | ❌ (create group in Signal app) |
| Directory search | ❌ |
| Reactions as activity indicator | ❌ (status text used) |
| Inbound edit/delete mirroring | ❌ (no contract port) |

## Unsupported / Known Limitations

- **No channel creation from Switch**: Create the group in the Signal app, add your registered number, and Switch will adopt it on the first message.
- **No directory search**: Only people who have spoken in a connected room can be named.
- **No slash commands**: Use `!command` syntax (e.g., `!help`).
- **No inbound edit/delete mirroring**: Signal doesn't expose an API to mirror inbound edits/deletes.
- **1:1 chats not bridged**: Only Signal groups are bridged as rooms.
- **Single-device constraint**: Signal allows one primary device + up to 5 linked devices. The signal-cli daemon acts as a linked device; messages sent from your primary phone will appear in Switch, but messages sent from Switch won't appear on your phone unless it's the primary device (Signal protocol limitation).

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `Could not reach the signal-cli daemon` | Check URL, network connectivity, and that `signal-cli daemon --http` is running. |
| `Account ... is not registered` | The phone number/ACI is not registered on this daemon. Run `signal-cli -u +1234567890 daemon --http` with the correct number. |
| `HTTP 401/403` on health check | The daemon (or a reverse proxy) rejected the request. Check proxy credentials. |
| Messages not appearing | Check daemon logs; ensure the Signal account is a member of the group. |
| Attachments not downloading | Check `_max_attachment_bytes` config and Signal's file size limits. |

## Multi-pod Deployments

- Only the lease-holding pod opens the SSE connection to the daemon.
- Other pods relay outbound messages through the lease holder.
- On lease handoff, the new holder resumes from the last processed event (in-memory cursor + optional file-backed cursor for crash recovery).

## Known Gaps (Honest Disclosure)

Per the project's error-handling philosophy, we document known gaps rather than hide them:

1. **Restart message loss**: If Switch restarts while the daemon is running, events that arrived during the downtime are lost (signal-cli buffers only the last 1000 events). This is a known gap; we document it rather than implementing a fragile fix.
2. **Duplicate messages on daemon restart**: If signal-cli restarts while Switch is running, up to 1000 buffered events are replayed. Core deduplication prevents duplicate room messages, but may cause rare spurious "answer didn't land" notices for approval answers, and re-upload of attachment blobs (invisible to users).
3. **Self-message suppression**: Messages sent from the account's primary phone appear as `syncMessage` events and are correctly ignored. Messages sent from a linked device other than the daemon *may* appear as regular messages if the daemon receives them via Signal's sync mechanism. A dedicated number avoids this.
4. **Edit/delete window**: Signal allows editing/deleting own messages within a time window (~7 days). Edits/deletes outside this window will fail with a platform error (surfaced as a notice in the room).
5. **No inbound edit/delete mirroring**: Inbound edits/deletes on Signal have no adapter callback in the contract; they are not mirrored to Switch rooms. Outbound edits/deletes (room → Signal) work.
6. **Single-device constraint**: signal-cli acts as a linked device. If your primary phone is also active, both will receive messages. Use a dedicated number for the bridge.

## Registering or Linking an Account

1. **Dedicated number (recommended)**:
   ```bash
   signal-cli -u +1234567890 register
   # ... follow SMS/voice verification prompts ...
   signal-cli -u +1234567890 daemon --http=0.0.0.0:8080
   ```

2. **Linked device (secondary device)**:
   ```bash
   # On your primary phone: Signal Settings → Linked devices → Link new device
   signal-cli link -u +1234567890
   # Scan QR code with primary phone
   signal-cli -u +1234567890 daemon --http=0.0.0.0:8080
   ```

The daemon must stay running. Use a process manager (systemd, Docker, etc.) for production.

## Connecting in Switch Console

1. Open Switch Console → Connect a messaging app → Signal.
2. Enter the daemon URL (e.g., `http://localhost:8080`).
3. Enter the registered account (phone number or ACI UUID).
4. If using a reverse proxy with basic auth, fill in username/password.
5. Click **Connect**. Switch will verify the daemon and account.

## Multi-pod Deployments

- Only the lease-holding pod connects to the daemon's SSE stream.
- Other pods relay outbound messages through the lease holder.
- On lease handoff, the new holder resumes from the last processed event.

## Permissions & Rate Limits

- The daemon respects signal-cli's rate limits. Exceeding them returns HTTP 429 (rate limit).
- Signal enforces message size limits; oversized messages are converted to text file attachments by signal-cli.
- Edit/delete windows are limited by Signal's protocol (typically 15 minutes for edits, ~7 days for delete-for-everyone).

---

*This documentation is for the Signal collaboration bridge as of the version shipped with this release. For the latest signal-cli capabilities, see the [signal-cli documentation](https://github.com/AsamK/signal-cli).*