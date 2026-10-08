# Data retention

What Switch deletes on its own, what a workspace can ask it to delete, and how
that relates to the GDPR. The first half describes what is built. The second
half is a design note for what is not built yet, so later work starts from a
shared picture and not from scratch.

## What is built

### A message-retention window per workspace

Each workspace keeps room messages forever until an owner or admin sets a
window on the Workspace page ("Data retention"). With a window of N days, room
messages older than N days are deleted from every room in the workspace,
archived rooms included. Their attachments go with them, as does the record of
which chat-platform post carried each message.

- **Storage.** `tenant_retention_policies` holds one row per workspace that has
  a window. No row means keep forever, so turning retention on is always the
  workspace's choice and never a deployment default.
- **API.** `GET`, `PUT` and `DELETE /tenants/{id}/retention` read, set and clear
  the window. `GET /tenants/{id}/retention/preview?days=N` counts what a window
  would delete now, which the page shows before anything is saved. All four are
  limited to owners and admins.
- **Audit.** Setting and clearing the window are recorded as
  `retention_policy.set` and `retention_policy.cleared`, with the previous and
  new values.
- **Enforcement.** A pass runs at startup and then hourly, as a background
  task of its own (`retention_loop` in `retention/service.py`). It is kept out
  of the session-activity upkeep loop, which expires approval requests every
  few seconds, so a long pass cannot hold up what unblocks a stuck session. A
  change therefore takes effect within the hour, not in the request that made
  it. Deletion runs in batches of 1000 messages, each in its own transaction,
  and each workspace gets two minutes per pass. A larger backlog, such as the
  first pass after a short window is set on an old workspace, is finished by
  the passes after it, and running out of time logs a warning. Messages, files
  and leftover records are separate steps: one failing is logged and does not
  skip the others.

### Message numbering survives deletion

Messages are numbered per room (`messages.seq`), and every delivery cursor is a
position in that sequence. New numbers came from "highest existing + 1", so a
room whose messages had all been deleted would have started again at 1. Every
cursor already past that point would then have silently skipped the new
messages. `rooms.seq_floor` records the highest live position retention has
deleted, and numbering continues above whichever is higher. Reconstructed
history (negative `seq`) never moves the floor.

Other effects of deleting old messages, all already handled:

- `read_context` reads by time window and reports `truncated` correctly.
- A reply whose thread root has been deleted shows the root as elided.
- Unread counts come from an in-memory buffer, not from the table.
- Posting a new reply into a thread whose root was deleted is refused with
  "thread_id not found". That is a visible failure, not a silent one.

One effect is not signalled. A message an agent has not yet received (its
cursor is behind it) and that ages out is simply never delivered, with no
"history lost" notice. In practice this needs an agent to be days behind a
room. A window shorter than the longest an agent may be offline is a choice
the workspace makes with that trade-off.

A downgrade past this migration drops `seq_floor`, so a room retention has
emptied numbers from 1 again, and cursors past that point skip new messages
until they are reset.

### Orphaned files are swept

Attachment bytes live in `media_blobs`, which deliberately has no foreign key to
the attachments that use it: two messages may quote the same file. Every hourly
pass deletes blobs that no attachment row refers to, whatever the workspace's
policy, because an orphaned file is not something anyone chose to keep. That
covers files left behind by retention and also those left behind when a room is
deleted, which nothing cleaned up before.

A blob is only a candidate once it is a day old. A file is uploaded before the
message that carries it, in a separate transaction. A blob named by a pending
hosted-cutover import is never a candidate.

### Leftover operational records

After a 30-day grace period, every pass also deletes:

- approval requests that are settled: closed, or answered or expired and
  already delivered. An answer still owed to an agent is kept, however old.
  Their platform posts are deleted with them.
- invitations that expired or were revoked
- messaging install links that expired. Once expired, a replayed link is
  refused whether or not the row exists.

### What is deliberately not touched

- **The audit log** (`audit_events`). It is append-only by design, and the
  runtime database role cannot delete from it. See below.
- **Usage records** (`tenant_usage`). They are billing and quota data, hold no
  message content, and are aggregated per hour.
- **Copies on chat platforms.** A message bridged to Slack, Mattermost, Discord,
  Teams or Telegram is also stored by that platform under the customer's own
  retention settings. Switch does not delete it there, and the Workspace page
  says so.

## Design note: GDPR

The relevant obligations are storage limitation (Art. 5(1)(e)), erasure
(Art. 17), access and portability (Art. 15 and 20), and accountability. The
retention window covers storage limitation for message content. The rest is
below, in the order it is likely to be needed.

### Where personal data lives

| Data | Where | Personal data |
|---|---|---|
| Message content and attachments | `messages`, `message_attachments`, `media_blobs` | Anything people write. Sender ids. |
| Switch accounts | `users`, `oidc_identities`, `tenant_members` | Name, email, IdP subject |
| Chat-platform identities | `external_users`, `external_user_claims` | Platform user id and username |
| Invitations | `invitations` | Invitee email |
| Audit log | `audit_events` | Actor user id, target ids, details |
| Session activity | `session_activity_items`, `approval_requests` | Who answered what. Prompt and tool text. Already pruned after 7 days (activity) or 30 days once settled (approvals). |
| Logs and backups | outside the database | Whatever the deployment's log and backup policy keeps |

### Erase a person (built)

A workspace owner can erase one person from the People list on the Workspace
page, for example to answer an Art. 17 request. Admins cannot; the action
cannot be undone.

**Who a person is.** Everyone in a room is a chat-platform identity: an
`external_users` row on one bridge, standing behind a `clients` row that is
the room participant. Most have no Switch account. One person seen on two
platforms is two identities. When a member has claimed the chosen identity,
the dialog also offers the other identities that member claims, unticked:
claims are self-asserted and several members may claim one account, so a
shared claimant is a hint, not proof of a shared person.

**The flow.**

1. The owner picks the person and confirms by typing their name. The typed
   name is not stored.
2. `POST /tenants/{id}/erasures` queues a `person_erasures` row naming the
   identities, and records `person_erasure.requested` (who asked, the internal
   identity ids). It refuses an identity outside the workspace (404) or one
   already being erased (409).
3. A background loop (`retention/erasure.py`, every 5 s) claims a request,
   marking it running in the same statement and skipping one another process
   holds, and works it. For each identity it:
   - deletes every message it sent, in every room including archived ones, in
     batches with their attachments, bridge post mappings and the copies held
     for hosted agents (wake-mailbox deliveries not yet admitted, cutover
     items), keeping each room's `seq_floor` and adding to the request's
     counts in the same transaction;
   - stops the client that stood in for the person;
   - in one transaction: drops their name and the words they typed from
     approval answers (`answered_by` becomes `erased`; the options they picked
     stay, as the agent's record of what it was told), takes their name out of
     the names of direct rooms they were in, deletes the identity row (claims
     go by cascade), its room memberships and its client, and only then
     deletes anything they sent meanwhile. Deleting the client waits for any
     send naming it to commit, and afterwards no send can name it, so nothing
     they send outlives the transaction;
   - tells the running bridge to forget the identity, so writing again
     provisions a new one;
   - deletes the stored files that only their messages carried, with the same
     hosted-cutover guard as the hourly sweep but no grace period, because
     these files are known to have been attached.
4. The page polls `GET /tenants/{id}/erasures` for progress, and re-reads the
   people list once the last request finishes. On success the request records
   `person_erasure.completed` with its counts.
5. A failure before an identity's rows are deleted marks the request `failed`
   with the error. It is not retried, and since the identity is still there
   the owner can queue it again. A failure after (the bridge could not be
   told, the files could not be deleted) is logged as a warning and does not
   fail the request: the identity is gone, so queueing again could not help.
   The bridge forgets on its next restart, and the hourly sweep takes the
   files a day later. A request whose process died is resumed by the next
   pass once its progress is ten minutes old.

**The client row goes, it is not renamed.** Its transport id is built from the
person's username, so keeping it would keep the name. With every message they
sent deleted, nothing would show a placeholder anyway.

**What stays, and why.**

- **Quotes and mentions in other people's messages.** Erasing them would
  rewrite other people's records. The usual reading of Art. 17 does not
  require it. This includes mentions as data: another message's `m.mentions`
  holds the person's transport id, which embeds their username.
- **Their Switch account and membership.** Removing a member is its own
  action, and deleting an account is deployment-level because one account may
  belong to several workspaces.
- **Copies on chat platforms.** The platform's copy is the customer's to
  erase in that platform. The dialog says so.
- **Agents' copies.** An agent may hold the person's messages, or their
  transport id, in its own transcript or memory, on a machine Switch does not
  control.
- **Session activity lines** may quote what the person wrote. They are pruned
  after 7 days.
- **The bridge's in-memory mention map** keeps the platform's
  username-to-id pair until the bridge restarts. The person is still on that
  platform, so the pair is the platform's data, not Switch's record of them.
- **Channel room names.** Only direct rooms are named after a person. A
  channel's name is the platform's.

**People from a disconnected chat app.** Disconnecting an app deletes its
identity and client rows but keeps their messages in the detached rooms. These
former participants are found by their messages instead: every sender whose id
has the shape a bridge gives a person (`@switch-{platform}-{bridge id}-…`) and
for whom no client row is left. The People list shows them under "Disconnected
app", named by the display names their messages carry, and an erasure request
names them by that sender id (`former_sender_ids`). Erasing one deletes their
messages, files, bridge post mappings and hosted copies, scrubs their approval
answers, and replaces their names in the direct rooms among the rooms their
messages were deleted from, since their memberships went with their client.
There is no identity left to delete and no bridge to tell. Listing them scans
the tenant's messages, which is fine for an owner-only page opened rarely; an
index on the sender's shape would be the fix if it is not.

### Data export (not built)

An owner or admin export of everything held about one person in the workspace,
as machine-readable JSON: account fields, platform identities, and messages
they sent, with attachments. The same identity resolution as erasure applies.
This is the natural next step, since it needs the same identity lookup as
erasure (`ErasureStore.people_with_ids`).

### Deleting a workspace (not built)

`tenants` has no `deleted_at` today. Deleting a workspace needs an ordered
teardown across every tenant-scoped table, because the tenant foreign keys do
not cascade. It also needs a grace period and an audit record kept outside the
tenant. This is a multi-tenancy-phase concern, noted here because it is the
largest remaining erasure path.

### The audit log

The audit log cannot be pruned by the application on purpose: the runtime role
has `UPDATE` and `DELETE` revoked, so a compromised process cannot erase its
tracks. Bounding it needs a separate, privileged job, for example a
`SECURITY DEFINER` function owned by the migration role that deletes events
older than a fixed horizon. The horizon should be a deployment setting, not a
workspace one, because the log protects the operator as well as the customer.
Audit entries hold ids and small details, not message content, so keeping them
longer than messages is defensible under the accountability principle.

### Backups and logs

Deleted rows remain in database backups until those backups expire. A
deployment's backup retention should be documented alongside its message
retention, and restoring a backup should be followed by a retention pass, which
happens on its own within the hour. Application logs do not include message
bodies by default. Any change that starts logging them should be treated as
personal-data processing.

### Not covered yet

- `bridge_message_map` rows orphaned by deleting a whole room. Retention
  removes the rows for the messages it deletes, but not these.
- Expired controller enrolment codes. Each is tied to an `api_keys` row that
  needs to go with it.
- `tasks`, `hosted_operations` and agent-controller operation history.
