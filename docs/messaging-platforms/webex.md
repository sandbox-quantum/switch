# Cisco Webex

Connect a bot you own. Switch receives signed Webex webhooks on any Core pod
and sends messages through the Webex Messaging REST API v1.

## Create and connect the bot

1. Sign in to [Webex for Developers](https://developer.webex.com/my-apps).
   Choose **Create a New App → Create a Bot**. Pick a name, username and icon.
2. Copy the bot access token, displayed once after creation. Use a dedicated
   bot for this connection. Personal access tokens are refused.
3. Make Core reachable over public HTTPS. For local testing, run
   `cloudflared tunnel --url http://localhost:8000` and set
   `MESSAGING_PUBLIC_URL` to its HTTPS origin before starting Core.
4. In Switch Console choose **Connect a messaging app → Cisco Webex**.
   Enter the bot access token and connect. Switch checks the token immediately
   using `GET /v1/people/me`; a refused token produces a connection error.
5. Switch generates and persists a signing secret, then registers the
   connection's webhook address automatically. There is no URL to paste in
   Webex. The bridge owner registers `messages/created`,
   `attachmentActions/created` and `memberships/created`.
6. Add the bot to a Webex space, or start a direct conversation with its bot
   username. A new group membership connects the space to a Switch room.
   In a group space, mention the Webex bot and then type
   `!invite-agent @your-agent`. To address that agent, mention the Webex bot
   and type `@your-agent your question`.
7. Link your Webex account under Console's account settings. Send the displayed
   `!link-account CODE` in a direct conversation with the bot, or mention the
   bot before that command in a group. Linking identifies the person who may
   instruct an owner-only agent or answer its requests.

The token grants the bot's own messaging and membership access; no user OAuth
consent, administrator token or enterprise compliance scope is needed. Workspace
policies may restrict adding bots or members. To rotate a token, regenerate it
on the same bot and edit the connection. To use another bot, create a new
connection. Disconnecting removes only this connection's webhook registrations;
restarting Core retains and refreshes them, including a changed tunnel origin.
Unchanged active hooks are reused without a write. If Webex rate-limits setup,
Core logs the wait and retries after its `Retry-After` delay. Leave Core running
rather than repeatedly reconnecting; the bridge serves events once setup finishes.

## Messages, files and controls

- All agents share the Webex bot identity. Each post starts with the agent's
  name; Webex does not let a bot impersonate several sender identities.
- Spaces become rooms. `parentId` preserves threaded replies in both directions.
- Supported Webex HTML is converted to Markdown on receipt. Outgoing Markdown
  supports emphasis, links, lists and code. Long replies split on UTF-8 byte
  boundaries, preferring whitespace and reopening fenced code blocks.
- Files are downloaded with bot authorization and a streaming byte limit,
  then uploaded to Switch. Failed or oversized downloads travel as attachment
  failures for the room to disclose. Outgoing files use multipart uploads;
  an oversized upload produces a visible refusal in its thread.
- `!commands`, including account linking and agent invitation, use the normal
  Switch command handler. Group commands must mention the Webex bot first.
- Adaptive Cards show working/completed turn status. Approval and single-choice
  question buttons carry the durable Switch request token and option position.
  Any pod fetches the authenticated Webex attachment action and attributes it
  to the submitting person; Switch checks the saved request and authorization.
  Closed or truncated forms have no live buttons. Forms needing multiple
  answers, free text, or more than five buttons use the printed typed-answer
  instructions, such as `A1 1` or the question-specific example on the card.
- Switch can create group spaces and add people by Webex person ID or email.
  Failed additions are reported individually. Agents share the existing bot,
  so adding an agent requires no additional Webex membership.

## Platform and recovery limits

- **Unaddressed group messages:** Webex only notifies a bot of messages that
  mention it. Unaddressed messages in a direct conversation do reach Switch.
  See [Webex bot restrictions](https://developer.webex.com/messaging/docs/bots).
- **Edits and deletes:** Switch can edit and delete its bot's Webex posts.
  Webex exposes no message-update webhook. Webex does expose deletion events,
  but the current Switch inbound adapter contract cannot remove an already
  relayed room event; inbound deletions are not mirrored by this adapter.
- **Typing and reactions:** Webex provides no bot typing endpoint. The persisted
  activity card is the work indicator; reactions are not advertised.
- **Directory and slash commands:** Directory search is disabled. Use people
  who have spoken to the bot or explicit IDs/emails. Webex has no native
  Switch slash-command installation; use `!commands`.
- **Files:** Webex's API ceiling is 100 MB. Switch's configured attachment
  ceiling also applies. Authenticated downloads accept Webex content URLs only;
  redirects are refused instead of forwarding the bot token elsewhere.
- **Retries and pods:** Only the lease owner changes webhook registrations.
  Any pod verifies signatures and dispatches events. Receipts are shared in
  Postgres, keyed by resource, event and data ID, not the registration ID.
  A claim commits before dispatch without retaining a database connection.
  Completed repeats return success; an in-progress repeat or dispatch failure
  returns 503. Failure releases the claim in a separate transaction for retry.
  A process killed after claiming but before completion leaves an unhandled
  receipt requiring operator investigation; this is not automatic crash replay.
- **Uncertain card posts:** Confirmed card references and request tokens survive
  a restart. Webex bot history cannot reliably recover the bot's own card after
  a lost POST response. Switch preserves the unconfirmed reservation rather
  than posting twice, discloses the uncertainty, and leaves the request
  answerable in Console. Do not infer exactly-once delivery across a hard crash.

Webex can disable unreachable webhooks. Correct the public URL/network problem
and restart the connection to reactivate its registrations. Platform retries
are not a substitute for monitoring disabled hooks and unhandled receipts.

References: [webhook delivery and signatures](https://developer.webex.com/admin/docs/receive-and-verify-webhooks),
[events](https://developer.webex.com/admin/docs/webhook-event-reference),
[files and formatting](https://developer.webex.com/messaging/docs/basics),
[Adaptive Cards](https://developer.webex.com/messaging/docs/buttons-and-cards).
