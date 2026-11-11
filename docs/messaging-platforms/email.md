# Email

Connect Switch to any standard email mailbox using IMAP (inbound) and SMTP (outbound).

People can email your agent mailbox, messages land in a Switch room, and agent replies are sent directly via email with native RFC 5322 threading.

---

## How it works

- **Inbound:** Switch connects to the IMAP server and periodically polls for new unread messages in the designated folder (`INBOX`).
- **Outbound:** When an agent replies or an admin message is sent, Switch dispatches the message via SMTP with proper `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To`, and `References` headers.
- **Threading:** Email threads map to Switch room threads based on `Message-ID` and `In-Reply-To` / `References`. Replies sent by agents remain in the same email conversation thread in email clients (Gmail, Apple Mail, Outlook).
- **Room Routing:**
  - Standard emails from a user open a direct 1-to-1 conversation with the sender (`channel_id` is the sender's email address).
  - Plus-addressing is supported: an email sent to `mailbox+<room_id>@example.com` automatically routes the message into `<room_id>`.
- **Quoted replies & Signatures:** Cleaned automatically. Inbound replies strip quoted lines (`> ...`) and forward headers (`On ... wrote:`, `-----Original Message-----`) as well as signature blocks (`-- \n`) so room transcripts remain readable.
- **Commands:** In-room commands (`!help`, `!status`, `!cancel`, etc.) are recognized and executed when sent as an email body.
- **Attachments:** Both inbound and outbound attachments are supported up to the configured size limit (default: 20MB). Oversized files are visibly flagged in the room as an attachment failure.

---

## Connection Settings

| Field | Required | Description |
|---|---|---|
| `email_address` | Yes | The email address this bridge uses (e.g. `agent@example.com`). |
| `sender_name` | No | Display name used on outbound emails (default: `Switch Agent`). |
| `imap_host` | Yes | IMAP server hostname (e.g. `imap.gmail.com`, `outlook.office365.com`). |
| `imap_port` | Yes | IMAP port (typically `993` for SSL/TLS, `143` for STARTTLS). |
| `imap_username` | Yes | Username or email used to log in to IMAP. |
| `imap_password` | Yes | Password or App Password for IMAP authentication. |
| `imap_use_ssl` | No | Connect using SSL/TLS encryption (default: `True`). |
| `imap_folder` | No | Mailbox folder to poll (default: `INBOX`). |
| `poll_interval_seconds` | No | Polling interval in seconds (default: `15`, min: `1`, max: `300`). |
| `smtp_host` | Yes | SMTP server hostname (e.g. `smtp.gmail.com`, `smtp.office365.com`). |
| `smtp_port` | Yes | SMTP port (typically `587` for STARTTLS, `465` for SSL). |
| `smtp_username` | Yes | Username or email used to log in to SMTP. |
| `smtp_password` | Yes | Password or App Password for SMTP authentication. |
| `smtp_use_tls` | No | Connect using STARTTLS encryption (default: `True`). |
| `smtp_use_ssl` | No | Connect using direct SSL encryption (default: `False`). |
| `allowed_senders` | No | Optional list of allowed email addresses or domain wildcards (e.g. `["*@company.com"]`). If empty, all senders are accepted. |
| `max_attachment_size_bytes` | No | Maximum attachment size in bytes (default: `20971520` = 20MB). |

---

## Multi-pod Execution

When running Switch with multiple pods:
- The Email bridge declares `keeps_quiet_unless_listening = True`.
- Only the pod holding the bridge lease polls the IMAP mailbox, preventing race conditions and duplicated message processing.
- Messages are marked as `\Seen` on IMAP and deduplicated by their RFC `Message-ID`.

---

## What Email cannot do

- **Channel creation:** Email has no server-side channel creation API (`supports_channel_creation = False`). Conversations are initiated by emailing the address or using plus-addressing.
- **Directory search:** Email has no central directory enumeration API (`supports_directory_search = False`).
- **Interactive Buttons / Cards:** Email clients do not execute custom callbacks. Request cards and approvals are rendered as formatted notification summaries with guidance to review decisions in Switch Console.
