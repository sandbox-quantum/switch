#!/usr/bin/env python3
"""Feed a mailbox to the email collaboration bridge, for local development.

The bridge takes a raw RFC 5322 message on an HTTP webhook and nothing else —
no IMAP, no SMTP. In production an inbound-parse provider (Postmark, Mailgun,
SendGrid) does the POSTing, which needs a domain, MX records and a publicly
reachable endpoint. This stands in for that when all you want is to send the
agent real mail from your own client: it polls a mailbox you already own and
POSTs whatever it finds, unchanged.

**Development tooling.** It trades the provider's delivery guarantees for a
loop and an app password. Do not point it at a mailbox you care about — see
"What it changes in the mailbox" below.

Configuration, all from the environment (nothing is read from a file, so
nothing has to be redacted before sharing a terminal):

    IMAP_HOST        e.g. imap.gmail.com
    IMAP_USER        the mailbox to read
    IMAP_PASSWORD    an app password, not the account password
    IMAP_FOLDER      default INBOX. A dedicated label/folder is much safer.
    WEBHOOK_URL      http://127.0.0.1:8099/inbound/<secret>
    POLL_SECONDS     default 10

What it changes in the mailbox: it searches `UNSEEN`, and marks a message
`\\Seen` only after the webhook accepts it. A message the bridge rejects is
left unread and retried on the next pass, so a transient failure does not lose
mail — but a message the bridge *always* rejects is retried forever. That is
deliberate: a poison message you can see in your inbox beats one silently
dropped, and the log names it every time.

It never deletes, moves, or replies.
"""

from __future__ import annotations

import email
import functools
import imaplib
import os
import sys
import time
import urllib.error
import urllib.request

#: Line-buffered output. This is a loop people leave running and tail, and a
#: block-buffered pipe shows nothing until the buffer fills — which for a quiet
#: mailbox is never.
print = functools.partial(print, flush=True)  # noqa: A001

POLL_DEFAULT_SECONDS = 10
#: Long enough for a slow local stack, short enough that a wedged request does
#: not stall the loop past the next poll.
REQUEST_TIMEOUT_SECONDS = 30


def _required(name: str) -> str:
    """A missing value is a startup error, not a default to invent."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(
            f"{name} is not set. See the module docstring for the full list."
        )
    return value


def _deliver(url: str, raw: bytes) -> None:
    """POST one message. Raises on anything but a 2xx."""
    request = urllib.request.Request(
        url,
        data=raw,
        headers={"Content-Type": "message/rfc822"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"HTTP {response.status}")


def _describe(raw: bytes) -> str:
    """`From` and `Subject`, for a log line that identifies the message."""
    try:
        parsed = email.message_from_bytes(raw)
    except Exception:
        return "<unparseable>"
    return f"{parsed.get('From', '?')} — {parsed.get('Subject', '(no subject)')}"


def poll_once(client: imaplib.IMAP4_SSL, url: str) -> int:
    """Deliver every unread message. Returns how many were accepted.

    The `NOOP` is not a keepalive, it is the poll. IMAP does not push anything
    to an idle client: the server's view of the mailbox is fixed at `SELECT`
    and only advances when the client speaks, so re-running `SEARCH` on a
    quiet connection returns the same answer forever. Without this, new mail
    is delivered only when the connection happens to drop and the reconnect
    re-selects — which looks like it works, intermittently, and is the worst
    way for this to be wrong.
    """
    client.noop()
    status, data = client.search(None, "UNSEEN")
    if status != "OK":
        raise RuntimeError(f"IMAP search failed: {status}")

    delivered = 0
    for message_id in data[0].split():
        # BODY.PEEK avoids setting \Seen as a side effect of reading: the flag
        # is what tracks delivery, so it must not move until the POST lands.
        status, payload = client.fetch(message_id, "(BODY.PEEK[])")
        if status != "OK" or not payload or not isinstance(payload[0], tuple):
            print(
                f"  ! could not fetch {message_id!r}, leaving unread", file=sys.stderr
            )
            continue

        raw = payload[0][1]
        try:
            _deliver(url, raw)
        except (urllib.error.URLError, RuntimeError, OSError) as error:
            # Left unread on purpose, so the next pass retries it.
            print(
                f"  ! rejected, left unread: {_describe(raw)} ({error})",
                file=sys.stderr,
            )
            continue

        client.store(message_id, "+FLAGS", "\\Seen")
        delivered += 1
        print(f"  → delivered: {_describe(raw)}")
    return delivered


def main() -> None:
    host = _required("IMAP_HOST")
    user = _required("IMAP_USER")
    password = _required("IMAP_PASSWORD")
    url = _required("WEBHOOK_URL")
    folder = os.environ.get("IMAP_FOLDER", "INBOX").strip() or "INBOX"
    interval = int(os.environ.get("POLL_SECONDS", POLL_DEFAULT_SECONDS))

    print(
        f"polling {user} [{folder}] every {interval}s -> {url.split('/inbound/')[0]}/inbound/…"
    )

    while True:
        try:
            client = imaplib.IMAP4_SSL(host)
            client.login(user, password)
            client.select(folder)
            try:
                while True:
                    poll_once(client, url)
                    time.sleep(interval)
            finally:
                try:
                    client.logout()
                except Exception:
                    pass
        except KeyboardInterrupt:
            print("\nstopped")
            return
        except Exception as error:
            # A dropped IMAP connection is ordinary — reconnect rather than
            # exit, or an overnight demo dies on the first network blip.
            print(
                f"! {type(error).__name__}: {error} — reconnecting in {interval}s",
                file=sys.stderr,
            )
            time.sleep(interval)


if __name__ == "__main__":
    main()
