"""Building a reply that lands in the conversation it answers.

A mail client groups a thread by walking `In-Reply-To` and `References`. Get
them wrong and every reply is a new conversation: the recipient sees a pile of
unrelated messages with similar subjects, which is exactly how a correspondent
learns they are talking to a machine.

Kept separate from the adapter, and free of I/O, so the header arithmetic — the
part that is fiddly and easy to get subtly wrong — can be tested without a mail
server.
"""

from __future__ import annotations

import re
from email.message import EmailMessage
from email.utils import getaddresses

_RE_PREFIX = re.compile(r"^\s*re\s*:\s*", re.IGNORECASE)


def _reply_subject(original: str) -> str:
    """`Re:` exactly once.

    Prefixing unconditionally produces `Re: Re: Re: Re: booking` after four
    turns. Stripping every existing prefix first also normalises the pile a
    human correspondent's client may already have built.
    """
    stripped = original
    while _RE_PREFIX.match(stripped):
        stripped = _RE_PREFIX.sub("", stripped, count=1)
    return f"Re: {stripped.strip()}"


def _recipient(original: EmailMessage) -> str:
    """Where the answer goes.

    `Reply-To` wins over `From`: a sender who set it meant it, and answering the
    other address is how a reply lands in a mailbox nobody reads.
    """
    raw = original.get("Reply-To") or original.get("From") or ""
    addresses = [addr for _name, addr in getaddresses([str(raw)]) if addr]
    if not addresses:
        raise ValueError("cannot reply to a message with no usable sender address")
    return addresses[0]


def _markdown_to_html(body: str) -> str:
    """Enough Markdown for a mail body, and no dependency to add.

    Paragraphs, bullet lists, bold and inline code — which is what an agent
    writing prose to a person actually produces. Anything richer is better left
    to the plain-text half than half-rendered.
    """
    html_parts: list[str] = []
    for block in re.split(r"\n\s*\n", body.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if lines and all(line.startswith(("- ", "* ")) for line in lines):
            items = "".join(f"<li>{_inline(line[2:])}</li>" for line in lines)
            html_parts.append(f"<ul>{items}</ul>")
        else:
            html_parts.append(f"<p>{_inline(' '.join(lines))}</p>")
    return "<html><body>" + "".join(html_parts) + "</body></html>"


def _inline(text: str) -> str:
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    return re.sub(r"`(.+?)`", r"<code>\1</code>", escaped)


def build_reply(
    original: EmailMessage, *, body: str, from_address: str
) -> EmailMessage:
    """A reply to `original`, threaded and ready to send.

    Raises when the original carries no `Message-ID`: there is nothing to thread
    against, and a reply that claims to answer nothing is worse than an error —
    it arrives as a new conversation with a subject implying it is not.
    """
    message_id = (original.get("Message-ID") or "").strip()
    if not message_id:
        raise ValueError(
            "cannot reply to a message with no Message-ID; there is nothing to "
            "thread the reply against"
        )

    reply = EmailMessage()
    reply["From"] = from_address
    reply["To"] = _recipient(original)
    reply["Subject"] = _reply_subject(str(original.get("Subject") or ""))
    reply["In-Reply-To"] = message_id

    # The chain the recipient's client walks, oldest first, with the message
    # being answered appended. Carrying only the immediate parent attaches the
    # reply to one message rather than to the conversation.
    existing = str(original.get("References") or "").split()
    reply["References"] = " ".join([*existing, message_id])

    reply.set_content(body)
    reply.add_alternative(_markdown_to_html(body), subtype="html")
    return reply
