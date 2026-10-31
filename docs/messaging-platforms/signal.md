# Signal

Switch connects to Signal through a `signal-cli` daemon that you operate. Signal
does not provide an official bot API; `signal-cli` is an unofficial client and
must be kept current as Signal changes its service.

This adapter is tested with **signal-cli 0.14.9** and its HTTP JSON-RPC API.

## Before you connect

Use a dedicated Signal account when possible. Registering a phone number or
linking a device happens in `signal-cli`, outside Switch. Follow the
[`signal-cli` installation and registration instructions](https://github.com/AsamK/signal-cli),
then confirm the account can send and receive before starting its daemon.

Start a multi-account daemon on a private interface:

```bash
signal-cli daemon --http=0.0.0.0:8080 --receive-mode=on-start
```

Or bind it to loopback when switch-core runs on the same machine:

```bash
signal-cli daemon --http=127.0.0.1:8080 --receive-mode=on-start
```

The daemon's HTTP API has no authentication. Never publish it on the internet.
Across several switch-core pods, put it behind one private service address that
every pod can reach. If a private reverse proxy adds bearer authentication, put
that credential in **Proxy bearer token**.

## Connect in Switch Console

Open **Connect a messaging app**, choose **Signal**, and enter:

- **signal-cli daemon URL** — the bare private origin, such as
  `http://signal-cli:8080` (no `/api/v1` suffix).
- **Signal account** — the registered E.164 number or account UUID used by the
  daemon.
- **Proxy bearer token** — only when your reverse proxy requires one.

Switch checks `/api/v1/check` and makes an authenticated `listGroups` JSON-RPC
call before saving the connection. A bad account, refused proxy token, or
unreachable daemon is shown as a connection error.

Add the Signal account to each group you want to bridge. The group appears as a
room after its first message reaches Switch. Direct messages map to direct rooms.

## Behavior and limits

- Signal has no native threads. A Switch thread reply is sent as a Signal quote
  reply to the root message.
- Agents share the one Signal account, so each outgoing body begins with the
  agent's name.
- Text is rendered as readable plain text. Long replies are split on paragraph
  or word boundaries.
- Attachments are transferred through signal-cli and refused visibly when they
  exceed Switch's configured media limit.
- `!commands` work as ordinary Signal messages.
- Approval and question cards use the standard numbered text-answer fallback;
  Signal has no bot buttons.
- Outgoing messages can be edited and remotely deleted while Signal still
  permits the operation. Signal edits or deletes made by a person are not
  mirrored because Switch's collaboration ingress does not currently expose an
  inbound edit/delete event.
- Signal groups cannot be created or searched from Switch, users cannot be
  directory-searched, and members must be added in a Signal client.

Only the switch-core pod holding the bridge lease opens the SSE event stream.
Events use Signal's source and timestamp as their stable message reference, so
the daemon's replay after reconnect or restart does not create a second room
message. Keep one daemon/device connection available to all pods; do not run a
separate signal-cli account copy per pod.

## Operational risks

`signal-cli` is not an official Signal client. Keep it updated—old clients can
stop working as Signal changes the service—and monitor the daemon. Protect its
data directory like a logged-in phone: anyone who can access that directory or
the daemon API can act as the account. Back up only through procedures supported
by signal-cli; copying a live data directory between pods can corrupt its state
or create competing devices.
