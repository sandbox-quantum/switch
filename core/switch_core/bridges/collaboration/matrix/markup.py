"""Switch Markdown to a Matrix message, and a long reply into several.

A Matrix message carries its text twice: `body`, the plain fallback, and
`formatted_body`, the HTML a client draws. The body here is the Markdown
itself, which is what Element sends as well, and the HTML is made from it at
the last moment so that a long reply can be cut as Markdown, where a cut is
safe, rather than as HTML.
"""

from __future__ import annotations

import html
import re
from typing import Any
from urllib.parse import urlsplit

import markdown

#: One message's text, in UTF-8 bytes. A whole event may not pass 65,536 bytes,
#: and it holds the text twice (as Markdown and as HTML), so this stays well
#: under a third of that even when the HTML adds tags.
MAX_CHUNK_BYTES = 12_000

_ALLOWED_LINK_SCHEMES = frozenset({"http", "https", "mailto"})
_HREF = re.compile(r'<a href="([^"]*)"[^>]*>')
_FENCE = re.compile(r"^\s*(```|~~~)")


def _converter() -> markdown.Markdown:
    md = markdown.Markdown(extensions=["fenced_code", "tables", "nl2br", "sane_lists"])
    # What an agent writes is untrusted text. Raw HTML is shown as text, and
    # images are left out because a Matrix image must be an uploaded file.
    md.preprocessors.deregister("html_block")
    md.inlinePatterns.deregister("html")
    md.inlinePatterns.deregister("image_link")
    md.inlinePatterns.deregister("image_reference")
    return md


def _link(match: re.Match[str]) -> str:
    target = html.unescape(match.group(1))
    scheme = urlsplit(target).scheme.lower()
    if scheme in _ALLOWED_LINK_SCHEMES:
        return f'<a href="{html.escape(target, quote=True)}">'
    return "<a>"


def to_html(text: str) -> str:
    """`text` as the HTML subset Matrix clients draw."""
    return _HREF.sub(_link, _converter().convert(text))


def text_content(text: str, label: str | None) -> dict[str, Any]:
    """The content of an `m.text` message, headed by `label` when there is one.

    Every agent posts through the one bot, so the label is the whole of an
    agent's identity on Matrix. It is escaped here and never goes through
    Markdown, so a display name cannot forge markup.
    """
    rendered = to_html(text)
    if label is None:
        return {
            "msgtype": "m.text",
            "body": text,
            "format": "org.matrix.custom.html",
            "formatted_body": rendered,
        }
    name = html.escape(label, quote=False)
    if "\n" not in text and rendered.startswith("<p>"):
        formatted = f"<p><strong>{name}</strong>: {rendered[3:]}"
        body = f"{label}: {text}"
    else:
        formatted = f"<p><strong>{name}</strong></p>\n{rendered}"
        body = f"{label}\n{text}"
    return {
        "msgtype": "m.text",
        "body": body,
        "format": "org.matrix.custom.html",
        "formatted_body": formatted,
    }


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def _hard_cut(line: str, limit: int) -> list[str]:
    """A single line longer than `limit`, in pieces that fit."""
    pieces: list[str] = []
    current = ""
    for character in line:
        if _size(current) + _size(character) > limit:
            pieces.append(current)
            current = ""
        current += character
    if current:
        pieces.append(current)
    return pieces


def chunk_message(text: str, limit: int = MAX_CHUNK_BYTES) -> list[str]:
    """`text` in pieces of at most `limit` bytes, cut between lines.

    A code block the cut falls in is closed at the end of one piece and
    reopened at the start of the next, so each piece renders on its own.
    """
    if _size(text) <= limit:
        return [text]
    pieces: list[str] = []
    current: list[str] = []
    used = 0
    fence: str | None = None
    for raw in text.split("\n"):
        for line in _hard_cut(raw, limit - 8) if _size(raw) > limit - 8 else [raw]:
            cost = _size(line) + 1
            if current and used + cost > limit - 8:
                if fence is not None:
                    current.append(fence)
                pieces.append("\n".join(current))
                current = [fence] if fence else []
                used = sum(_size(item) + 1 for item in current)
            current.append(line)
            used += cost
        marker = _FENCE.match(raw)
        if marker is not None:
            fence = None if fence is not None else marker.group(1)
    if current:
        pieces.append("\n".join(current))
    return pieces
