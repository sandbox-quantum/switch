"""Reading and writing mail for the email bridge, with no network in it.

Everything here works on bytes and strings so it can be tested on its own: what
an incoming message says and whether it may reach the room, how much of its
body is new, and the message an agent's reply goes out as.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email import policy
from email.headerregistry import Address
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import format_datetime, getaddresses, parseaddr
from html.parser import HTMLParser
from uuid import uuid4

import markdown

from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    OutboundAttachment,
)

#: Set on every message the bridge sends, so it recognises its own mail if a
#: copy comes back to the mailbox (a Cc, a forward, a misconfigured alias).
SWITCH_HEADER = "X-Switch-Bridge"

_MESSAGE_ID = re.compile(r"<[^<>\s]+>")

# Where a reply's quoted history starts, in the forms mail clients write it.
# Gmail, Apple Mail and Thunderbird: "On <date>, <name> wrote:", which a long
# name can wrap onto a second line.
_ON_WROTE = re.compile(r"^\s*On\b.{0,300}\bwrote:\s*$", re.IGNORECASE | re.DOTALL)
# Outlook and others quote the headers of the message being answered.
_ORIGINAL_MESSAGE = re.compile(
    r"^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$", re.IGNORECASE
)
_HEADER_BLOCK = re.compile(r"^\s*\*?From:\*?\s.+$", re.IGNORECASE)
_HEADER_FOLLOWERS = re.compile(r"^\s*\*?(Sent|Date|To|Subject|Cc):\*?\s", re.IGNORECASE)
_OUTLOOK_RULE = re.compile(r"^\s*_{10,}\s*$")
# A signature starts at the conventional "-- " line.
_SIGNATURE = re.compile(r"^--\s?$")
# Phone clients append one of these after everything the person wrote.
_SENT_FROM = re.compile(r"^\s*(Sent from my |Get Outlook for )", re.IGNORECASE)

_SUBJECT_PREFIX = re.compile(
    r"^\s*((re|fwd?|aw|sv|vs)\s*(\[\d+\])?\s*:\s*)+", re.IGNORECASE
)


class MailboxConfigError(ValueError):
    """An email address or allow-list entry the bridge cannot use."""


def normalise_address(value: str) -> str:
    """`value` as a bare, lower-cased address, or raise if it is not one."""
    _, address = parseaddr(value.strip())
    address = address.strip().lower()
    if address.count("@") != 1 or not all(address.split("@")):
        raise MailboxConfigError(f"{value!r} is not an email address")
    return address


def parse_allowed_senders(value: str) -> tuple[str, ...]:
    """Read the allow list: addresses, and `@domain` for a whole domain.

    Comma, semicolon or newline separated, because the connect form gives it
    one text field and people paste lists in all three shapes.
    """
    entries: list[str] = []
    for raw in re.split(r"[,;\n]", value):
        entry = raw.strip().lower()
        if not entry:
            continue
        if entry.startswith("@"):
            domain = entry[1:]
            if not domain or "@" in domain or "." not in domain:
                raise MailboxConfigError(f"{raw.strip()!r} is not a domain")
            entries.append(entry)
        else:
            entries.append(normalise_address(entry))
    if not entries:
        raise MailboxConfigError(
            "name at least one address or @domain that may write in"
        )
    return tuple(dict.fromkeys(entries))


def sender_allowed(address: str, allowed: tuple[str, ...]) -> bool:
    """Whether `address` is on the allow list, by itself or by its domain."""
    address = address.lower()
    domain = address.rpartition("@")[2]
    return address in allowed or f"@{domain}" in allowed


def message_ids(value: str | None) -> list[str]:
    """Every `<id>` in a Message-ID, In-Reply-To or References header."""
    return _MESSAGE_ID.findall(value or "")


def thread_root(message: EmailMessage) -> str | None:
    """The first message of the conversation `message` replies to, or None.

    References lists the conversation oldest first, so its first entry is the
    root whatever client wrote it. A client that sends only In-Reply-To names
    the message answered, which is the best root there is.
    """
    references = message_ids(message.get("References"))
    if references:
        return references[0]
    replied = message_ids(message.get("In-Reply-To"))
    return replied[0] if replied else None


def clean_subject(subject: str) -> str:
    """The subject without its `Re:`/`Fwd:` prefixes."""
    return _SUBJECT_PREFIX.sub("", subject or "").strip()


def reply_subject(subject: str) -> str:
    cleaned = clean_subject(subject)
    return f"Re: {cleaned}" if cleaned else "Re:"


def automated_reason(message: EmailMessage, return_path: str | None) -> str | None:
    """Why `message` was sent by software rather than a person, or None.

    Auto-replies, bounces and list traffic never reach the room: answering
    them is how two mailboxes end up mailing each other forever.
    """
    auto_submitted = (message.get("Auto-Submitted") or "").strip().lower()
    if auto_submitted and auto_submitted != "no":
        return f"Auto-Submitted: {auto_submitted}"
    precedence = (message.get("Precedence") or "").strip().lower()
    if precedence in {"bulk", "list", "junk", "auto_reply"}:
        return f"Precedence: {precedence}"
    if message.get("List-Id") is not None:
        return "a mailing list message (List-Id)"
    for header in ("X-Autoreply", "X-Autorespond"):
        if message.get(header) is not None:
            return f"an auto-reply ({header})"
    if return_path is not None and return_path.strip() in {"<>", ""}:
        return "a bounce (empty return path)"
    if message.get_content_type() == "multipart/report":
        return "a delivery report"
    return None


@dataclass(frozen=True)
class AuthenticationVerdict:
    passed: bool
    detail: str


def _aligned(domain: str | None, from_domain: str) -> bool:
    if not domain:
        return False
    domain = domain.lower().strip(".")
    return (
        domain == from_domain
        or domain.endswith(f".{from_domain}")
        or from_domain.endswith(f".{domain}")
    )


def authentication_verdict(
    message: EmailMessage, from_address: str, authentication_server: str | None
) -> AuthenticationVerdict:
    """Whether the receiving server vouched for the sender's domain.

    A `From:` header is whatever the sender typed, so on its own it proves
    nothing. The receiving server records what it checked in an
    `Authentication-Results` header (RFC 8601): DMARC, or DKIM or SPF for a
    domain aligned with the `From:` address. Only the server's own header is
    believed. With `authentication_server` set, that is the header naming that
    server; without it, the topmost one, which the receiving server adds above
    every header the sender wrote.
    """
    headers = [str(h) for h in message.get_all("Authentication-Results") or []]
    if authentication_server:
        wanted = authentication_server.strip().lower()
        headers = [h for h in headers if _authserv_id(h) == wanted]
        if not headers:
            return AuthenticationVerdict(
                False, f"no Authentication-Results header from {authentication_server}"
            )
    elif not headers:
        return AuthenticationVerdict(False, "no Authentication-Results header")
    else:
        headers = headers[:1]

    from_domain = from_address.rpartition("@")[2].lower()
    results = headers[0].split(";")[1:]
    for result in results:
        text = " ".join(result.split()).lower()
        method, _, rest = text.partition("=")
        method = method.strip()
        outcome = rest.split(" ", 1)[0]
        if outcome != "pass":
            continue
        if method == "dmarc":
            return AuthenticationVerdict(True, "dmarc=pass")
        if method == "dkim":
            domain = _property(text, "header.d") or _property(text, "header.i")
            if domain and _aligned(domain.rpartition("@")[2], from_domain):
                return AuthenticationVerdict(True, f"dkim=pass for {domain}")
        if method == "spf":
            mailfrom = _property(text, "smtp.mailfrom")
            if mailfrom and _aligned(mailfrom.rpartition("@")[2], from_domain):
                return AuthenticationVerdict(True, f"spf=pass for {mailfrom}")
    return AuthenticationVerdict(
        False, f"nothing aligned with {from_domain} passed in {headers[0]!r}"
    )


def _authserv_id(header: str) -> str:
    """The server named at the head of an Authentication-Results header,
    without the version number RFC 8601 allows after it."""
    head = header.split(";", 1)[0].split()
    return head[0].lower() if head else ""


def _property(text: str, name: str) -> str | None:
    match = re.search(rf"\b{re.escape(name)}=([^\s;]+)", text)
    return match.group(1).strip('"') if match else None


class _TextExtractor(HTMLParser):
    """Readable text from a message's HTML, without what it quotes."""

    _BLOCK = {
        "p",
        "div",
        "br",
        "tr",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "table",
        "ul",
        "ol",
        "hr",
    }
    _SKIP = {"script", "style", "head", "title", "blockquote"}
    # Containers mail clients put a reply's quoted history in.
    _QUOTE_CLASSES = {
        "gmail_quote",
        "moz-cite-prefix",
        "yahoo_quoted",
        "protonmail_quote",
    }
    _QUOTE_IDS = {
        "divrplyfwdmsg",
        "appendonsend",
        "mail-editor-reference-message-container",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skipping: list[str] = []
        self._link: str | None = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").lower().split())
        quoted = (
            bool(classes & self._QUOTE_CLASSES)
            or (values.get("id") or "").lower() in self._QUOTE_IDS
        )
        if self._skipping or tag in self._SKIP or quoted:
            if tag not in {"br", "hr", "img", "meta", "link", "input"}:
                self._skipping.append(tag)
            return
        if tag in self._BLOCK:
            self._parts.append("\n")
        if tag == "li":
            self._parts.append("- ")
        if tag == "a":
            self._link = values.get("href")
            self._link_text = []

    def handle_endtag(self, tag: str) -> None:
        if self._skipping:
            if self._skipping[-1] == tag:
                self._skipping.pop()
            return
        if tag == "a" and self._link is not None:
            text = "".join(self._link_text).strip()
            if (
                self._link.startswith(("http://", "https://", "mailto:"))
                and self._link != text
            ):
                self._parts.append(f" ({self._link})")
            self._link = None
        if tag in self._BLOCK:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skipping:
            return
        if self._link is not None:
            self._link_text.append(data)
        self._parts.append(data)

    def text(self) -> str:
        joined = "".join(self._parts).replace("\xa0", " ")
        lines = [" ".join(line.split()) for line in joined.splitlines()]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def html_to_text(markup: str) -> str:
    """The text a person reads in `markup`, quoted history left out."""
    extractor = _TextExtractor()
    extractor.feed(markup)
    extractor.close()
    return extractor.text()


def _quote_opening(lines: list[str], index: int) -> int:
    """How many lines an `On ... wrote:` at `index` takes, or 0 if there is none."""
    line = lines[index]
    if _ON_WROTE.match(line):
        return 1
    if (
        index + 1 < len(lines)
        and line.strip().lower().startswith("on ")
        and _ON_WROTE.match(f"{line} {lines[index + 1]}")
    ):
        return 2
    return 0


def _next_line_is_quoted(lines: list[str], index: int) -> bool:
    for line in lines[index:]:
        if line.strip():
            return line.lstrip().startswith(">")
    return False


def strip_reply(text: str) -> str:
    """What the sender wrote this time: no quoted history, no signature.

    A reply carries everything said before it, and posting that into the room
    with every message would bury each new line under the whole conversation.
    """
    lines = text.replace("\r\n", "\n").split("\n")
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if (
            _SIGNATURE.match(line)
            or _ORIGINAL_MESSAGE.match(line)
            or _OUTLOOK_RULE.match(line)
        ):
            break
        opening = _quote_opening(lines, index)
        if opening:
            # The quote may come first with the answer beneath it, so this ends
            # the message only when what follows is not marked as a quote.
            if not _next_line_is_quoted(lines, index + opening):
                break
            index += opening
            continue
        if (
            _HEADER_BLOCK.match(line)
            and index + 1 < len(lines)
            and _HEADER_FOLLOWERS.match(lines[index + 1])
        ):
            break
        if not line.lstrip().startswith(">"):
            kept.append(line)
        index += 1
    while kept and (not kept[-1].strip() or _SENT_FROM.match(kept[-1])):
        kept.pop()
    while kept and not kept[0].strip():
        kept.pop(0)
    return "\n".join(kept)


@dataclass
class ReadMessage:
    """One incoming message, read into what the room needs from it."""

    message_id: str | None
    root_id: str | None
    sender_address: str
    sender_name: str
    subject: str
    text: str
    recipients: list[str] = field(default_factory=list)
    attachments: list[Attachment] = field(default_factory=list)
    attachment_failures: list[AttachmentFailure] = field(default_factory=list)
    automated: str | None = None
    from_switch: bool = False
    message: EmailMessage | None = None


def read_message(raw: bytes, max_attachment_bytes: int) -> ReadMessage:
    """Parse `raw` and take out what the room needs, refusing nothing yet.

    Whether the message may reach the room at all is the caller's decision;
    this only reports what it found.
    """
    message = BytesParser(policy=policy.default).parsebytes(raw)
    assert isinstance(message, EmailMessage)
    name, address = parseaddr(str(message.get("From", "")))
    address = address.lower()
    recipients = [
        a.lower()
        for _, a in getaddresses(
            [
                str(v)
                for v in (message.get_all("To") or []) + (message.get_all("Cc") or [])
            ]
        )
        if a
    ]
    ids = message_ids(message.get("Message-ID"))
    text = _body_text(message)
    attachments, failures = _attachments(message, max_attachment_bytes)
    return ReadMessage(
        message_id=ids[0] if ids else None,
        root_id=thread_root(message),
        sender_address=address,
        sender_name=name.strip() or address.partition("@")[0],
        subject=str(message.get("Subject", "")).strip(),
        text=strip_reply(text),
        recipients=recipients,
        attachments=attachments,
        attachment_failures=failures,
        automated=automated_reason(message, message.get("Return-Path")),
        from_switch=message.get(SWITCH_HEADER) is not None,
        message=message,
    )


def _body_text(message: EmailMessage) -> str:
    plain = message.get_body(preferencelist=("plain",))
    if plain is not None:
        return str(plain.get_content())
    rich = message.get_body(preferencelist=("html",))
    if rich is not None:
        return html_to_text(str(rich.get_content()))
    return ""


def _attachments(
    message: EmailMessage, max_bytes: int
) -> tuple[list[Attachment], list[AttachmentFailure]]:
    attachments: list[Attachment] = []
    failures: list[AttachmentFailure] = []
    for index, part in enumerate(message.iter_attachments()):
        filename = part.get_filename() or f"attachment-{index + 1}"
        payload = part.get_payload(decode=True)
        if not isinstance(payload, bytes):
            failures.append(
                AttachmentFailure(filename=filename, reason="it could not be decoded")
            )
            continue
        if len(payload) > max_bytes:
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason=f"it is {_size(len(payload))}, over the {_size(max_bytes)} limit",
                )
            )
            continue
        attachments.append(
            Attachment(
                filename=filename, mimetype=part.get_content_type(), data=payload
            )
        )
    return attachments, failures


def _size(count: int) -> str:
    return f"{count / (1024 * 1024):.1f} MB"


def new_message_id(mailbox: str) -> str:
    """A Message-ID on the mailbox's own domain."""
    return f"<switch.{uuid4().hex}@{mailbox.rpartition('@')[2]}>"


def stable_message_id(mailbox: str, key: str) -> str:
    """The same Message-ID every time for one `key`, so a resend of one thing
    is the same message to the mail client that receives it twice."""
    safe = re.sub(r"[^A-Za-z0-9.-]", "-", key)
    return f"<switch.{safe}@{mailbox.rpartition('@')[2]}>"


def render_html(text: str) -> str:
    """`text`, which is Switch Markdown, as the HTML alternative of a message.

    Anything that already looks like HTML in an agent's text is escaped first,
    so it is shown, never interpreted. A line break stays a line break, as it
    does in a chat, and a backslash stays: a Windows path is not an escape.
    """
    renderer = markdown.Markdown(extensions=["fenced_code", "sane_lists", "nl2br"])
    renderer.inlinePatterns.deregister("escape")
    body = renderer.convert(html.escape(text, quote=False))
    return f'<!doctype html><html><body style="font-family:sans-serif">{body}</body></html>'


def build_message(
    *,
    mailbox: str,
    sender_name: str,
    recipients: list[str],
    subject: str,
    text: str,
    message_id: str,
    root_id: str | None,
    bridge_id: str,
    attachments: list[OutboundAttachment],
    date: datetime | None,
) -> EmailMessage:
    """The message an agent's words go out as.

    From the mailbox itself, under the agent's name, so a reply comes back to
    the room. In-Reply-To and References name the conversation's first
    message, which is what keeps it one thread in the reader's mail client and
    one thread in the room. `Auto-Submitted` tells the other side's
    auto-responder not to answer.
    """
    message = EmailMessage(policy=policy.SMTP)
    message["From"] = Address(display_name=sender_name, addr_spec=mailbox)
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message["Date"] = format_datetime(date or datetime.now(UTC))
    message["Message-ID"] = message_id
    if root_id is not None:
        message["In-Reply-To"] = root_id
        message["References"] = root_id
    message["Auto-Submitted"] = "auto-replied" if root_id else "auto-generated"
    message[SWITCH_HEADER] = bridge_id
    message.set_content(text)
    message.add_alternative(render_html(text), subtype="html")
    for attachment in attachments:
        maintype, _, subtype = attachment.mimetype.partition("/")
        message.add_attachment(
            attachment.data,
            maintype=maintype or "application",
            subtype=subtype or "octet-stream",
            filename=attachment.filename,
        )
    return message
