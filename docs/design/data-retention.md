# Data retention

What Switch deletes on its own, what a workspace can ask it to delete, and how
that relates to the GDPR. The first half describes what is built. The second
half is a design note for what is not built yet, so later work starts from a
shared picture and not from scratch.

## What is built

### A message-retention window per workspace

Each workspace keeps room messages forever until a workspace admin sets a
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
  limited to workspace admins.
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
message that carries it, in a separate transaction. A blob named by a chat
upload that is staged but not yet sent is never a candidate.

### Leftover operational records

After a 30-day grace period, every pass also deletes:

- approval requests that are settled: closed, or answered or expired and
  already delivered. An answer still owed to an agent is kept, however old.
  Their platform posts are deleted with them.
- invitations that expired or were revoked
- messaging install links that expired. Once expired, a replayed link is
  refused whether or not the row exists.

### What is deliberately not touched

- **A live workspace's audit log** (`audit_events`). It is append-only by
  design, and the runtime database role cannot delete from it. Only a deleted
  workspace's history is purged, two years after the deletion. See below.
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

A workspace admin can erase one person from the People list on the Workspace
page, for example to answer an Art. 17 request. Because it cannot be undone,
it takes the caller's own admin membership, as deleting the workspace does:
the deployment operator's bypass and an organization admin acting as one are
refused.

**Who a person is.** Everyone in a room is a chat-platform identity: an
`external_users` row on one bridge, standing behind a `clients` row that is
the room participant. Most have no Switch account. One person seen on two
platforms is two identities. When a member has claimed the chosen identity,
the dialog also offers the other identities that member claims, unticked:
claims are self-asserted and several members may claim one account, so a
shared claimant is a hint, not proof of a shared person.

**The flow.**

1. The admin picks the person and confirms by typing their name. The typed
   name is not stored.
2. `POST /tenants/{id}/erasures` queues a `person_erasures` row naming the
   identities, and records `person_erasure.requested` (who asked, the internal
   identity ids). It refuses an identity outside the workspace (404) or one
   already being erased (409).
3. A background loop (`retention/erasure.py`, every 5 s) claims a request,
   marking it running in the same statement and skipping one another process
   holds, and works it. For each identity it:
   - deletes every message it sent, in every room including archived ones, in
     batches with their attachments, bridge post mappings and the copies stored
     as events for agents (`agent_events`), keeping each room's `seq_floor` and adding to the request's
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
     staged-upload guard as the hourly sweep but no grace period, because
     these files are known to have been attached.
4. The page polls `GET /tenants/{id}/erasures` for progress, and re-reads the
   people list once the last request finishes. On success the request records
   `person_erasure.completed` with its counts.
5. A failure before an identity's rows are deleted marks the request `failed`
   with the error. It is not retried, and since the identity is still there
   the admin can queue it again. A failure after (the bridge could not be
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

**Members who wrote from Switch Console.** A member chatting from Switch
Console writes through a member client (`type = 'member'`) of their own,
whose transport id is `@switch-member-{user id}:{server}`: it embeds the
account's id, never a name or email. The People list shows these clients
under "Switch Console", and an erasure request names them by client id
(`member_client_ids`). Erasing one deletes the messages it sent, their files,
bridge post mappings and agent event copies, and scrubs its approval answers,
exactly as for an identity. The client, its memberships and the Switch
account stay: the member is still a member and can go on writing, and
removing them is its own action. Once their account is deleted, the client
is kept under "Former member" (see below) and can still be erased.

**People from a disconnected chat app.** Disconnecting an app deletes its
identity and client rows but keeps their messages in the detached rooms. These
former participants are found by their messages instead: every sender whose id
has the shape a bridge gives a person (`@switch-{platform}-{bridge id}-…`) and
for whom no client row is left. The People list shows them under "Disconnected
app", named by the display names their messages carry, and an erasure request
names them by that sender id (`former_sender_ids`). Erasing one deletes their
messages, files, bridge post mappings and agent event copies, scrubs their approval
answers, and replaces their names in the direct rooms among the rooms their
messages were deleted from, since their memberships went with their client.
There is no identity left to delete and no bridge to tell. Listing them scans
the tenant's messages, which is fine for an admin-only page opened rarely; an
index on the sender's shape would be the fix if it is not.

### Deleting a Switch account (built)

Deleting an account (`accounts/deletion.py`), by its holder or by the server's
administrator, keeps the messages it sent, so other people's conversations
stay whole, but takes the person's name off them. The account's name goes
from every place a copy of it was stored, replaced by "Former member":

- `messages.sender_name`, and the `sender_name` (or, for a command, the
  `user_name`) inside each message's content, for every row the account's
  member client sent, in every workspace it held rows in. This runs in
  batches of 1000 rows, each in its own transaction, before the transaction
  that removes the membership, which renames whatever was sent meanwhile;
- the copies stored as events for agents (`agent_events`): the sender's name
  on a message, the user's on a command, the member's on a join;
- the member client's `display_name`, and its link to the account, which is
  cleared. The client and its transport id stay, since the id embeds only the
  account's id;
- the account's name in the descriptions of the Switch Console chats the
  client is in ("Switch Console chat with …").

Invitations addressed to the account's email are deleted in every workspace,
whether still open, accepted, expired or revoked, matching the address without
regard to case. Audit rows are not changed: they hold the account's id, not
its name, and are kept for accountability (see "The audit log").

Not renamed: what other people wrote (quotes, mentions), names in session
activity lines, which are pruned after 7 days, a chat or room name someone
chose, copies on chat platforms, and the name a running process still holds
in memory for the client until it next loads it. Erasing the messages
altogether is the workspace admin's erase action above.

### Data export (not built)

A workspace admin's export of everything held about one person in the workspace,
as machine-readable JSON: account fields, platform identities, and messages
they sent, with attachments. The same identity resolution as erasure applies.
This is the natural next step, since it needs the same identity lookup as
erasure (`ErasureStore.people_with_ids`).

### Deleting a workspace (built separately)

A workspace admin can delete a workspace once it has been emptied
(`accounts/workspace_deletion.py`): its own setup goes with it in one
transaction, including its retention policy and erasure requests, and the
deletion is recorded in the server's audit log. The workspace's own audit
history stays for two years, then goes (below).

### Purging an organization on request (built)

When a customer asks for everything to be deleted, the operator runs
`switch-purge-organization ORGANIZATION` where switch-core runs, with its
configuration (`accounts/organization_purge.py`). Without `--execute` it only
reports what would go and what stays; with `--execute --request REFERENCE` it
purges, and the reference to the request goes in the server's audit log.
Nothing waits for the customer to empty anything first.

1. **Outside Switch first.** Every service sign-in is removed and revoked at
   its vendor with the tokens issued on it, and each cloud machine of an
   account the purge deletes is set to be deleted. While a machine is still
   being torn down or a token is still live at its vendor, the purge says so,
   deletes nothing and exits 3; the same command, run again, carries on.
2. **A record of the run**, in the server's audit log
   (`organization.purge_started`), naming the accounts it is to delete.
3. **Every workspace**, in its own transaction, with everything in it. Just
   before, its live messaging installs are ended as disconnecting them does
   (Slack's bot token revoked, a Teams organization withdrawn from, a Telegram
   chat left). After, the processes running its agents, clients, bridges and
   machines are told: agents' connections close and their cached keys go at
   once, as when an agent is deleted.
4. **The organization's own rows**, except its audit log, which outlives it
   as a workspace's does. The server's audit log records the purge.
5. **Every account that belonged to nothing else**: no membership of another
   workspace or organization and no rows left in one. Others keep their
   account and lose only what was here; the server's administrator account is
   always kept. Each deletion, or failure, is recorded on its own.

A run that stops part-way is finished by running the command again. The
record of each started run brings back the accounts found through workspaces
already deleted, and finds the organization by its id, slug or WorkOS id once
its own rows are gone, for the accounts still to delete.

A cloud machine whose owner keeps their account is not torn down: it loses
the organization's workspaces and is prepared again without them.

The workspaces' audit history stays for two years, as for any deleted
workspace. Nothing at WorkOS is changed, because the WorkOS environment may be
shared with other products: the command prints the WorkOS organization and
users to remove there, for whoever owns it. Copies on chat platforms stay, as
always.

The server's default workspace refuses the purge. The command refuses a
database connection that row-level security does not bind, since the service
broker finds a workspace's sign-ins through it.

### The audit log

Audit entries keep the acting account's id, including after the account is
deleted. The legal basis is accountability (Art. 5(2)): the log is how the
operator and the customer show who did what. Entries hold ids and small
details, not message content, so keeping them longer than messages is
proportionate.

A workspace's audit log is kept for as long as the workspace exists. Once the
workspace is deleted, its history is kept for `AUDIT_HISTORY_HORIZON`, two
years, and then deleted by the hourly retention pass
(`retention/audit_history.py`). The horizon is a constant, not a workspace
setting, because the log protects the operator as well as the customer.

- **When the workspace was deleted** comes from the server's audit log, which
  outlives every workspace: the `workspace.deleted` row deleting it wrote. A
  workspace whose `tenants` row exists is never purged, whatever that log says.
- **Purged:** the workspace's `audit_events`, every row carrying its tenant id.
- **Kept:** the server's `workspace.deleted` row, which proves when the
  workspace went and so why its history did; and the organization's audit log
  (`organization_audit_events`), which is the organization's history rather
  than the workspace's and outlives the organization: nothing purges it.

The runtime role has `UPDATE` and `DELETE` revoked on the audit tables, so a
compromised process cannot erase its tracks, and the serving process is not
given the schema owner's password. The purge is therefore a database function,
`purge_deleted_workspace_audit_history()` (`db/audit_history_ddl.py`), which
the retention pass calls on its ordinary runtime connection:

- It is `SECURITY DEFINER` and owned by the schema owner, so it deletes as the
  owner of `audit_events`. Row-level security does not apply to the table's
  owner (nothing sets `force row level security`), so it reaches every
  tenant's rows with none bound.
- It takes no arguments. The horizon is written into its body and the time is
  the database's `now()`, so a caller cannot widen what it deletes: holding
  `EXECUTE` on it allows only what the retention pass would do anyway, and the
  runtime role still cannot delete an audit row any other way.
- Its `search_path` is pinned (`pg_catalog, public, pg_temp`), `EXECUTE` is
  revoked from `PUBLIC`, and the runtime role is granted it with the other
  functions in the schema when the grants are re-issued.

Because the horizon is part of the function, changing
`AUDIT_HISTORY_HORIZON` needs a migration that replaces the function. Startup
refuses to serve if the function is missing, is not `SECURITY DEFINER`, or the
runtime role may not execute it.

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
- `tasks` and agent-controller operation history.
