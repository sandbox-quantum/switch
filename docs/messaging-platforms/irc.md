# IRC

Switch connects to IRC with a bot that dials out over TCP/TLS to one network
and a fixed list of channels — the same self-created shape as any other
adapter here, with your own credentials typed into Switch Console. There is
no app to install and nothing that calls in: IRC has no such thing.

## What's supported

| Capability | Status |
| --- | --- |
| Mention → reply under the agent's name | Supported — the name is written at the start of the line (`<AgentName> ...`), since one IRC connection serves every agent |
| Unaddressed messages reaching the room | Supported |
| `!commands` | Supported |
| Formatting | Partial — bold only (`\x02`); IRC has no native heading, link or list syntax |
| Long replies | Split to the 512-byte line limit, on word boundaries, never mid-character |
| Flood protection | A token bucket paces outbound lines |
| The agent shows it's working / answering a question or approval card | Supported, as plain text — the channel's own ordinary text, not a native status indicator or button |
| Threads | **Not supported.** IRC has no threads; every reply posts to the channel at the top level |
| Edits | **Not supported.** IRC has no edit. `update_message` posts a new line: `(edited) <new text>` |
| Deletes | **Not supported.** IRC has no delete. `delete_message` posts a new line: `(message removed)` |
| Attachments (outbound) | **Not supported.** Switch's base fallback names the file in text instead of uploading it, since IRC has no file transfer in the protocol |
| Attachments (inbound) | **Not supported** — nothing to receive |
| Reactions | **Not supported** |
| Channel creation | **Not supported.** IRC channels are joined, not provisioned; add a channel to the connection and invite/op the bot, then reconnect |
| User directory search | **Not supported.** Only people who have spoken in a connected channel are known to Switch |
| Restart recovery | IRC has no history replay. A message sent to the channel while the bridge was not connected is lost, not replayed, when it reconnects — this is a fact about IRC, not a bug in the adapter |

## Creating the bot

1. **Pick a network.** [Libera.Chat](https://libera.chat) is the common
   choice for open-source projects; a self-hosted server works the same way.
2. **Register an account for the bot**, so it can authenticate with SASL
   instead of a bare nick. On Libera.Chat (and most NickServ-based networks):
   connect once with an IRC client using the nick you want the bot to have,
   then:
   ```
   /msg NickServ REGISTER <password> <your-email>
   ```
   Confirm the verification email if the network requires one. On a
   self-hosted [Ergo](https://ergo.chat) server, the equivalent is the
   `REGISTER` command itself (no separate NickServ):
   ```
   REGISTER <accountname> * <password>
   ```
   Either way, the account's name and password are what you type into
   Switch Console as **SASL username** and **SASL password**.
3. **Invite the bot into its channels**, or have an operator `/invite` it,
   for any channel that is invite-only. For an open channel, nothing extra
   is needed — the bot joins the channels listed in its connection once it
   connects.
4. **Op the bot** (`/mode #channel +o <nick>`) if you want it to be able to
   speak in a moderated channel, or to survive a channel that kicks
   unrecognised accounts.

## Connecting in Switch Console

Open **Connect a messaging app → IRC** and fill in:

| Field | Meaning |
| --- | --- |
| Host | The network's server address (e.g. `irc.libera.chat`) |
| Port | Default `6697` (TLS) |
| Use TLS | On by default. Turn off only for a network with no TLS listener at all — never to work around a certificate problem |
| Verify TLS certificate | On by default. Turning it off accepts any certificate, including one from an attacker in a position to intercept the connection — only do this against a private test server with a self-signed certificate you've chosen to trust |
| Nick | The bot's nickname |
| SASL username / SASL password | The account registered above. Optional — leave blank for a network with no account system, where the bot connects as a bare nick |
| Server password | The network's connection password (`PASS`), if it requires one. This is not an account password; most networks need neither this nor SASL |
| Channels | The channels to join, e.g. `#switch`, one per line |

Click **Connect**. Wrong credentials — a bad SASL password, a bad server
password, or a nick already taken on the network — are checked live and
reported immediately, before the bridge is saved.

**Disconnecting** the bridge sends `QUIT` and closes the connection, which
leaves every channel as a side effect — the bot is on the network only as
long as the bridge is running. Deleting a *room* that is mapped to one of
its channels sends an explicit `PART` for that channel alone, with a note
that the room was deleted.

## Limits worth knowing before you connect

- **One bot, one nick, every agent.** Unlike Slack or Discord, IRC has no
  per-message identity override, so every agent's name is written into the
  text itself, at the start of the line. This is the normal shape of an IRC
  relay bot, not a Switch limitation.
- **No DMs.** A private message sent to the bot's own nick is not relayed to
  a room — only channel traffic is.
- **No history.** If the bridge is disconnected or restarted, anything sent
  to the channel in the meantime never reaches Switch. There is no IRC
  mechanism to ask a server to replay it.

## Troubleshooting

- **"SASL authentication failed"** — the account name or password is wrong,
  or the account hasn't finished email verification on a network that
  requires it.
- **"Nickname is already in use"** repeated, then a connection refusal — the
  configured nick is taken by another client and the bot's retries (adding a
  suffix) were all also taken. Pick a less common nick, or make sure nothing
  else is already connected as it.
- **Messages from the bot never arrive** — check the bot is actually opped
  or otherwise permitted to speak; a channel in moderated mode (`+m`) silently
  drops messages from anyone without voice or ops.
- **The bot connects but a channel is empty** — the configured channel name
  must match exactly, including the leading `#`.
