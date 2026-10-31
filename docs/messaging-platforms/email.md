# Email

Email connects a mailbox you control to Switch. The adapter uses IMAP to poll
the mailbox and SMTP to send replies. This works with ordinary mail providers
and avoids requiring a particular inbound-email webhook provider. Polling is
started only by the switch-core pod holding the bridge lease.

## Set up a mailbox

1. Choose a mailbox or alias for Switch. People send email to this address;
   replies are sent from the configured `from_address`.
2. Enable IMAP and SMTP access in your provider. Some providers require an app
   password instead of the account password. If your provider requires TLS,
   use the provider's SSL or STARTTLS settings.
3. In Switch Console, create an Email connection and enter the IMAP and SMTP
   hostnames, ports, usernames, passwords, and sender address. Password fields
   are stored as connection secrets.
4. Optionally enter a comma-separated `allowed_senders` list. When it is empty,
   any address that can deliver to the mailbox can send messages to Switch.
5. Connect the mailbox. Switch checks both IMAP and SMTP credentials before
   saving the connection.
6. Send a test email to the mailbox. Switch creates a room for the sender and
   normalized subject, then agents can reply from that room.

Use a dedicated mailbox or alias for Switch. Anyone allowed to send to it can
start an agent conversation unless `allowed_senders` restricts access. Email
sender addresses can be forged, so an allowlist is only as trustworthy as the
mail provider's authentication and filtering.

## Connection fields

| Field | Purpose |
| --- | --- |
| `imap_host`, `imap_port` | IMAP server and port. Port 993 is the default. |
| `imap_username`, `imap_password` | Mailbox login credentials. |
| `imap_folder` | Folder Switch polls. Defaults to `INBOX`. |
| `imap_security` | `ssl` or `starttls`. |
| `smtp_host`, `smtp_port` | SMTP server and port. Port 587 is the default. |
| `smtp_username`, `smtp_password` | SMTP login credentials. |
| `smtp_security` | `ssl` or `starttls`. |
| `from_address` | Address used for agent replies. It may be an alias the mailbox is allowed to send as. |
| `allowed_senders` | Optional comma-separated sender address allowlist. Empty accepts all senders reaching the mailbox. |
| `poll_interval_seconds` | How often Switch checks for unread messages. Defaults to 30 seconds. |

Switch checks the configured mail hosts against the deployment's outbound
network policy when the connection is created and started.

## Rooms, threads, and message formatting

- Each sender and normalized subject pair maps to a private Switch room. `Re:`
  and `Fwd:` prefixes are removed when deriving the room name and identity.
- New email starts a root message in the room. Replies carrying RFC 5322
  `References` or `In-Reply-To` headers map to a Switch thread under that root.
  Outbound replies set `In-Reply-To` and `References` to the email thread root,
  and preserve the normalized subject.
- Replies are sent to the sender of the inbound email, not to all original
  recipients. The configured `from_address` is shown with the agent's name as
  the display name.
- Plain text is preferred. If only HTML is present, tags are converted to
  text. Outbound mail contains a plain-text part and a sanitized HTML part with
  Markdown formatting. Replies longer than 18,000 characters are split at
  paragraph or line boundaries into numbered emails in the same email thread.
- Common quoted history markers, `>` quote lines, and the standard `-- ` email
  signature delimiter are removed. Provider-specific quote layouts may not be
  recognized.
- `!commands` are routed to Switch. Approval and question prompts use Switch's
  text format and are answerable by replying in the email thread. Use the
  handle and answer form printed in the prompt, for example `A7 1`, `A7 yes`,
  or `A8 q1="staging"`. A bare `yes` or `no` works only as the first reply
  directly to an approval prompt. The sender must have a linked Switch
  identity for the decision to be recorded. Email cannot show native buttons.
- Images and files are transferred as MIME attachments. Oversized files are
  disclosed in the room. Outbound attachments are limited to 20 MiB, or the
  lower attachment limit configured for the Switch deployment.
- SMTP cannot edit or recall a sent email. Message edits and deletes from
  Switch are therefore not mirrored. Email has no typing indicator, reactions,
  directory search, or channel creation.

## Polling, multiple pods, and delivery limits

The active lease holder polls unread messages. Other pods stay quiet. The
mailbox's IMAP seen flag is the shared cursor, so progress does not depend on
process memory. Switch marks a message seen after handing it to the room
transport. The adapter uses the RFC `Message-ID` as the stable external message
reference, with IMAP `UIDVALIDITY` and UID as a fallback. Switch derives
transport event IDs from that bridge, room, and reference; if a crash happens
after the room write but before the seen flag is set, retrying writes no second
room message or duplicate attachment rows. Inbound mail therefore resumes
without process-local deduplication state.

SMTP does not provide an idempotency key. If an SMTP server accepts an email
but its response is lost before Switch records the sent message ID, a retry
after a process failure can send a duplicate. Generic SMTP offers no safe way
to distinguish that case from a message the server never accepted, so
exactly-once outbound delivery cannot be guaranteed for every user-provided
mail server.

The mailbox and sender/subject identifiers are carried by the room and thread
references rather than process-local maps, so replies continue to route after
a restart or lease handoff.
