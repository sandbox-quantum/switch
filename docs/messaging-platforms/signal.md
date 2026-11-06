# Signal

Connects Signal group chats and direct messages to Switch. A **signal-cli
daemon** that you run is the bridge's only counterpart: Switch dials out to it
over HTTP (JSON-RPC for sends, a server-sent-events stream for receives), so
**no public ingress is required** on switch-core. One Signal number backs
every agent in a room; because Signal gives that number no per-message
identity, an agent is identified by its **name in bold at the head of each
message it posts**.

Rooms are **adopted, never created**: Signal offers the daemon no way to open
a chat from an API call, so a chat is made on the phone (a group you add the
bot to, or a direct message you start) and Switch adopts it on the first
message.

## What you need

- A Signal number for the bot: either a second registered number or a linked
  device. Your own account cannot be the bot, because signal-cli treats
  messages from its own account as sync traffic.
- **signal-cli 0.14.x** on the host that runs the daemon.
- A **private network path** from switch-core to that daemon (the daemon is
  unauthenticated — see below).

The connection is stored as a `daemon_url` and an `account`; the Console form
is `SignalConnectionConfig`. Both fields are validated before the bridge
starts:

| Field | Shape | Meaning |
| --- | --- | --- |
| `daemon_url` | `http(s)://host:port` — scheme and host only, no path | Where the signal-cli daemon listens. Returned to the deployment's outbound-policy check. |
| `account` | E.164, `+` then 7–15 digits | The Signal number this bridge acts as. Sent as the `account` param on every RPC, so one daemon can serve several numbers. |

A malformed URL (a path, or a non-http scheme) or a malformed number is
refused at connect time, not discovered mid-message.

## 1. Register or link the number

**Register a second number (preferred).** Use a captcha token from
https://signalcaptchas.org/registration/generate.html, then:

```bash
signal-cli -a +15555550100 register --captcha '<signalcaptcha://…>'
signal-cli -a +15555550100 verify <SMS code>
signal-cli -a +15555550100 updateProfile --given-name Switch
```

**Or link an existing phone** as a device:

```bash
signal-cli link -n switch-dev | qrencode -t ansiutf8
```

and scan the code from the phone under **Linked devices**.

Placeholders above are not real numbers; substitute yours.

## 2. Run the daemon

```bash
signal-cli -a +15555550100 daemon --http <private-host>:8080 --receive-mode on-start
```

- **`--receive-mode on-start`** means the daemon replays up to 1000 kept
  events when the stream reconnects, so a restarted bridge does not lose the
  messages the phone sent in the gap.
- **`<private-host>` is load-bearing.** The daemon has **no
  authentication**: anything that can reach `<private-host>:8080` can read
  the bot's messages and post as it. Bind it to `127.0.0.1` or an internal
  service address; **never to a public interface.**
- signal-cli is an **unofficial** client. Signal may rate-limit or block it,
  and the bot account's encryption keys live on this host. Treat the host as
  secret-equivalent.

## 3. Connect in Console

In Switch Console, **Connect a messaging app → Signal**, and fill in:

- **`daemon_url`** — the private address from step 2, e.g.
  `http://127.0.0.1:8080`.
- **`account`** — the bot's E.164 number, e.g. `+15555550100`.

On success the bridge holds the event stream (on the pod that owns the
bridge) and begins relaying. A number the daemon does not register — the
`account` belongs to no key on this daemon — is refused with a clear
credential error, not silently dropped.

## 4. Put the bot in a group, or DM it

- **Group:** add the bot's number to a Signal group on the phone. The first
  message in it adopts the chat as a room.
- **Direct message:** start a 1:1 chat with the bot's number. A Signal direct
  message is a real room here — unlike the Telegram bridge, a 1:1 with the
  bot is not a dead-end lobby.

Talk to an agent by addressing it: mention it, or reply to one of its posts.
In-room commands use the `!` prefix, the same set every room understands —
e.g. type `!help` to list them.

## 5. What Signal does not do here

One line per limit; each is the code's disclosed behaviour, not a silent
fallback:

- **No per-agent identity.** One number posts for every agent, so the name
  rides in the message body in **bold** instead of an avatar or sender.
- **No threads.** Signal has no message threads; a reply-to is a
  **quote-reply**, so the quoted message's ref (`<author>:<timestamp>`) is
  what Switch stores as the thread root. No cache is kept — the ref itself
  names what to quote.
- **No buttons on cards.** Approval and question cards post as **text**, and
  are **answered by typing the handle the card names** (e.g. `R42 1`),
  quoted to that message — there is no control to press.
- **Links stay http(s).** Console links are rewritten to their https form
  before posting: Signal linkifies `http(s)` only, so a `switchdash://`
  deeplink would arrive as dead text.
- **Working shows as typing, not reactions.** An agent that is mid-work is
  shown by the chat's **typing indicator**; reactions are not used for
  status (the flag stays at its base `False` — `sendReaction` was not
  verified live). The indicator is fire-and-forget and dies after a few
  seconds, so it is a cue that something is happening, not a live status.
- **No directory search.** The bot only knows the people who have messaged it,
  so it cannot be linked from a workspace directory the way Slack or
  Mattermost accounts can.
- **No channel creation from Switch.** A chat must exist on the phone first
  (sections 4); asking the bot to create one is refused with a clear error.
  Adding people to a group is the same: the bot cannot add users, so every
  one named is handed back and disclosed rather than faked.
- **Edits and deletes within ~24 h.** Signal only lets a sender change or
  withdraw a message for about a day; past that the daemon refuses, and the
  refusal is surfaced as an operation error, not swallowed.
- **Attachments up to 100 MB.** A file above the Signal protocol's ceiling is
  refused before it is uploaded — the reason is stated in the room — rather
  than sent and then dying at the server.

## 6. When the bridge reconnects

The daemon's replay plus the ref Switch stores on each message is what makes
restart and multi-pod safe: a pod that gains the bridge lease opens the
stream, the daemon replays what it kept, and Switch writes only the rows it
has not already seen. Nothing is doubled across pods, and nothing is lost
while the daemon stays up.
