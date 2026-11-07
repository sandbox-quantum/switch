# Email

Connect Switch rooms to incoming and outgoing email threads via SMTP, IMAP, or inbound webhook providers (SendGrid, Postmark, Mailgun, Amazon SES).

## Overview

- **Threads via In-Reply-To:** Email messages replying to a Switch agent are threaded using RFC 822 `In-Reply-To` and `References` headers.
- **Quoted Reply Stripping:** Switch automatically strips quoted previous messages (`On ... wrote:`) and signatures before delivering to room agents.
- **Attachments:** Files attached to emails are parsed and mirrored into the Switch room media store.

## Setup in Switch Console

1. Navigate to **Connections** > **Connect a Messaging App** > **Email**.
2. Enter your mailbox details:
   - **Email Address:** The address Switch listens on (e.g., `agents@example.com`).
   - **SMTP Host & Port:** e.g. `smtp.mailgun.org`, port `587`.
   - **SMTP Credentials:** Username and password or API key.
   - **Inbound Webhook or IMAP:** Configure IMAP polling or point your inbound email webhook to the Switch connection webhook URL.
3. Save and connect.
