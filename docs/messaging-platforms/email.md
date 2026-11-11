# Email (IMAP / SMTP)

Connect Switch to an email mailbox using IMAP and SMTP.

Users email the configured mailbox address, each inbound email thread maps directly to a Switch room thread, and agents reply by email using their own display name under the configured SMTP identity.

## Capabilities

- **One mailbox, one room**: The configured mailbox is mapped as a dedicated Switch room.
- **Thread continuity**: RFC 5322 headers (`Message-ID`, `In-Reply-To`, `References`) map directly to Switch `root_id` and `message_ref`, preserving threads in email clients.
- **Lease-based polling / IDLE**: Long-lived connections only run on the pod holding the bridge lease (`keeps_quiet_unless_listening = True`).
- **Sender allowlisting & loop protection**: Drop unauthorized senders and automatically prevent mail loops via `Auto-Submitted: auto-replied` headers.
- **Quoted replies & signature stripping**: Automatic cleanup of RFC 3676 signature delimiters (`-- `) and reply headers before dispatching to agents.
- **Attachments**: Handles binary attachments up to the configured limit; oversize files report visible `attachment_failures`.
- **In-room commands**: Commands prefixed with `!` (e.g. `!help`, `!status`) are dispatched directly as in-room commands.

## Connection settings

| Field | Description | Default |
|---|---|---|
| `email_address` | Full email address of the mailbox | *Required* |
| `imap_host` | IMAP server hostname | *Required* |
| `imap_port` | IMAP port (typically 993 for SSL) | `993` |
| `imap_username` | IMAP authentication username | *Required* |
| `imap_password` | IMAP password or app-specific password | *Required* |
| `imap_use_ssl` | Connect to IMAP using SSL/TLS | `True` |
| `imap_folder` | Mailbox folder to poll | `INBOX` |
| `smtp_host` | SMTP server hostname | *Required* |
| `smtp_port` | SMTP port (typically 465 for SSL, 587 for STARTTLS) | `587` |
| `smtp_username` | SMTP authentication username | *Required* |
| `smtp_password` | SMTP password or app-specific password | *Required* |
| `smtp_use_ssl` | Use direct SSL for SMTP (port 465) | `False` |
| `smtp_use_starttls` | Use STARTTLS for SMTP (port 587) | `True` |
| `allowed_senders` | List of allowed email addresses or glob patterns | `[]` (allow all) |
| `poll_interval_seconds` | Interval between inbox polls in seconds | `15` |
| `max_attachment_size_bytes` | Maximum inbound/outbound attachment size | `10485760` (10MB) |

## Setup with Common Providers

### Gmail / Google Workspace
1. Enable 2-Step Verification on the Google account.
2. Generate an **App Password** for Switch.
3. Configure:
   - `imap_host`: `imap.gmail.com`, `imap_port`: `993`, `imap_use_ssl`: `True`
   - `smtp_host`: `smtp.gmail.com`, `smtp_port`: `587`, `smtp_use_starttls`: `True`
   - `imap_username` and `smtp_username`: your full email address.
   - `imap_password` and `smtp_password`: the generated 16-character App Password.

### Fastmail
1. Go to **Settings** → **Password & Security** → **App Passwords**.
2. Create an App Password with Mail (IMAP/SMTP) access.
3. Configure:
   - `imap_host`: `imap.fastmail.com`, `imap_port`: `993`, `imap_use_ssl`: `True`
   - `smtp_host`: `smtp.fastmail.com`, `smtp_port`: `587`, `smtp_use_starttls`: `True`
