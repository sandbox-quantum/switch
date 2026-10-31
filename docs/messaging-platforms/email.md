# Email

Connect a mailbox to Switch so people can email a room. Each new email starts a
thread in the room, each reply lands in its thread, and agents answer by email
under their own names.

One connection is one mailbox and one room. For a second room, connect a second
mailbox. Use a mailbox of its own, such as `agents@example.com`, not somebody's
personal inbox: everything that arrives in it from an allowed sender goes to the
room.

Switch reads the mailbox over IMAP and sends over SMTP, so it works with any
mail provider that offers both, and needs no public address or webhook.

## What you need

- The mailbox's IMAP and SMTP server names.
- Its password. Most large providers require an **app password** rather than
  the account password:

| Provider | IMAP server | SMTP server | Password |
|---|---|---|---|
| Gmail / Google Workspace | `imap.gmail.com` | `smtp.gmail.com` | Turn on 2-Step Verification, then create an [app password](https://myaccount.google.com/apppasswords). |
| Fastmail | `imap.fastmail.com` | `smtp.fastmail.com` | Create an app password with IMAP and SMTP access under Settings, Privacy & Security. |
| iCloud Mail | `imap.mail.me.com` | `smtp.mail.me.com` (`starttls`, port 587) | Create an app-specific password at account.apple.com. |

Microsoft 365 no longer accepts passwords over IMAP and SMTP for most tenants,
so it does not work with this connection.

## Connect it

In Switch Console, open **Connect a messaging app**, choose **Email** and fill
in the form. Switch logs in to both servers before saving, so a wrong password
or server name is refused there, with the server's own answer.

| Field | What it means |
|---|---|
| Email address | The mailbox people write to. Agents reply from this address. |
| Password | The mailbox password or app password. |
| IMAP server, SMTP server | Where mail is read and sent. |
| Who may write in | Addresses, or `@domain` for a whole domain, separated by commas. Mail from anyone else is not posted. An agent's new message goes to the addresses listed here. |
| Login name | Only when it differs from the email address. |
| IMAP port, IMAP security | `ssl` on 993 (the default), `starttls` on 143. |
| SMTP port, SMTP security | `ssl` on 465 (the default), `starttls` on 587. |
| Folder | The folder new mail arrives in. `INBOX` by default. |
| Only believe senders the mail server verified | On by default. See [Who can write in](#who-can-write-in). |
| Receiving server's name | How your provider names itself in `Authentication-Results`, for example `mx.google.com`. Recommended. |

`none` is also accepted for both security settings, for a test server on your
own network. It sends the password unencrypted.

A mail server on a private address is refused unless it is allowed with
`OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

The room is created as soon as the mailbox is connected. Add agents to it in
Switch Console, as for any other room. An agent answers only its owner by
default, so for mail from other people set the agent's **Who can talk to your
agent** to **Anyone**, or to rules that name them.

Only mail that arrives after you connect is posted. What was in the mailbox
before stays there.

## Using it

- **Talk to an agent** by writing its name in the email, such as `@scout`, as
  you would in a chat. As everywhere in Switch, a full stop straight after the
  name reads as part of it, so write `Hi @scout, ...`, not `Thanks @scout.`
- **Threads:** a new email starts a thread, with its subject as the first line.
  Replying keeps you in that thread, and Switch matches replies by their
  `In-Reply-To` and `References` headers rather than the subject.
- **Who gets an agent's reply:** the people on that thread who are on the *Who
  may write in* list. Someone copied into the conversation who is not on the
  list does not receive it.
- **Commands:** an email whose text starts with `!` is a command, such as
  `!list-agents`.
- **Attachments** work both ways, up to the deployment's attachment limit. A
  file over the limit is not silently dropped: the room, or the email, says
  which file was refused and why.
- **Quoted history and signatures** are left out of what reaches the room: quoted
  lines, `On ... wrote:` blocks, forwarded headers, and anything after a `-- `
  signature line. HTML-only mail is converted to text.

### Answering an approval

Email has no buttons. When an agent needs a decision, it arrives as an email of
its own in the thread, ending with a handle such as `A1`. Reply with the handle
and your choice, on the first line:

```
A1 1
```

or `A1 yes`, `A1 no`. A reply that says only `yes`, without the handle, is
treated as an ordinary message, so an email about something else can never
decide a request. The person answering has to be someone Switch knows, as on
any other platform.

## Who can write in

Mail reaches the room only if all of these hold. Otherwise it stays in the
mailbox, marked as handled, and the reason is logged by switch-core.

1. **The sender is on the list.**
2. **The sender is genuine.** A `From:` line is whatever the sender typed, so
   the list alone proves nothing. Switch reads the `Authentication-Results`
   header your mail provider adds and requires DMARC to have passed, or DKIM or
   SPF for a domain matching the `From:` address.
3. **A person wrote it.** Auto-replies, bounces, delivery reports and mailing-list
   traffic are never posted. Everything Switch sends is marked `Auto-Submitted`,
   so a vacation responder doesn't answer it. That is what stops two mailboxes
   writing to each other forever.

Set **Receiving server's name** so that only your provider's header is believed.
Without it Switch uses the topmost `Authentication-Results` header, which your
provider writes above anything the sender wrote.

Turn the check off only for a mail server that adds no such header. The list
then trusts whatever `From:` says, so anyone who guesses an allowed address can
post to the room and give agents instructions.

## How it behaves

- **Restarts lose nothing and repeat nothing.** Switch marks each message with
  the IMAP keyword `$SwitchSeen` once the room has it, and leaves it unread for
  anyone using the mailbox. The mark is on the mail server, so it survives a
  restart or the connection moving to another switch-core process.
- **New mail arrives within seconds** on servers with IMAP IDLE. On others
  Switch checks every 30 seconds.
- **Servers that keep no custom keywords:** Switch marks handled mail as read
  instead, and logs a warning. Mail someone opens in a mail client before Switch
  sees it is then not posted, which is another reason to give the room its own
  mailbox.
- **Several switch-core processes:** only the one holding the connection reads
  the mailbox. Any of them can send.
- **A wrong password later on** is logged as an error, and Switch keeps retrying,
  backing off to every five minutes.
- **Messages not in a thread** go to the addresses on the *Who may write in*
  list as new emails. Those include notices from Switch itself, such as the
  note that an agent is starting a session, which is posted at the top of the
  room rather than in the thread that started it.

## What email can't do

- **Create channels:** one mailbox is one room. Plus-addressing is not used.
- **Search people:** a mailbox has no directory.
- **Edit or delete:** a sent email can't be changed, so neither can an agent's
  message once it is out.
- **Show progress:** a turn's running status isn't emailed, because each change
  would be another message. If a turn fails, that is sent once.
- **Typing and reactions:** email has neither.
- **Buttons:** cards are answered by replying, as above.
- **Sent folder:** agents' replies are not copied to the mailbox's Sent folder.

## Removing it

Disconnect the connection in Switch Console. Switch stops reading the mailbox,
and the mail stays where it is. The `$SwitchSeen` keywords stay on the messages
too and do nothing.
