"""The IRC wire format, and the text rules that ride on it.

Pure functions only — no sockets, no event loop — so every rule here is tested
on its own: parsing a line (RFC 1459 with IRCv3 message tags), building one
safely, cutting a reply to the line limit on UTF-8 boundaries, and converting
between Switch Markdown and IRC's control-code formatting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: RFC 1459 caps a line at 512 bytes, CRLF included.
MAX_LINE_BYTES = 512

#: Room left for what the server prepends when it relays our PRIVMSG to
#: everyone else: `:nick!user@host `. The user is at most 10 characters on most
#: networks and a hostname at most 63, so 1 + 1 + 10 + 1 + 63 + 1 covers it with
#: the nickname added on top by `payload_budget`.
_PREFIX_ALLOWANCE = 77

_NICK_RE = re.compile(r"[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}")
_CHANNEL_RE = re.compile(r"[#&][^\s,\x07\x00]{1,49}")

# mIRC formatting: bold, colour (with optional fg[,bg]), hex colour, reset,
# monospace, italics, strikethrough, underline, reverse.
_FORMATTING_RE = re.compile(
    r"\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9A-Fa-f]{6}(?:,[0-9A-Fa-f]{6})?)?"
    r"|[\x02\x0f\x11\x1d\x1e\x1f\x16]"
)

BOLD = "\x02"
ITALIC = "\x1d"


def is_valid_nick(nick: str) -> bool:
    return _NICK_RE.fullmatch(nick) is not None


def is_channel(target: str) -> bool:
    return _CHANNEL_RE.fullmatch(target) is not None


def normalize_target(target: str) -> str:
    """IRC compares channel and nick names case-insensitively (rfc1459
    casemapping), so one channel must have one id however it was typed."""
    return target.translate(str.maketrans("[]\\~", "{}|^")).lower()


@dataclass
class IrcMessage:
    command: str
    params: list[str] = field(default_factory=list)
    prefix: str | None = None
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def nick(self) -> str | None:
        """The nickname out of a `nick!user@host` prefix, or None for a server."""
        if self.prefix is None or "!" not in self.prefix:
            return None
        return self.prefix.split("!", 1)[0]


_TAG_UNESCAPES = {":": ";", "s": " ", "\\": "\\", "r": "\r", "n": "\n"}


def _unescape_tag(value: str) -> str:
    out: list[str] = []
    chars = iter(value)
    for char in chars:
        if char == "\\":
            nxt = next(chars, "")
            out.append(_TAG_UNESCAPES.get(nxt, nxt))
        else:
            out.append(char)
    return "".join(out)


def parse_line(line: str) -> IrcMessage:
    """Parse one line received from a server (without its CRLF).

    Raises ValueError for a line with no command, which a well-behaved server
    never sends; the caller logs and skips it rather than dropping the link.
    """
    rest = line.rstrip("\r\n")
    tags: dict[str, str] = {}
    if rest.startswith("@"):
        raw_tags, _, rest = rest[1:].partition(" ")
        for item in raw_tags.split(";"):
            if not item:
                continue
            key, _, value = item.partition("=")
            tags[key] = _unescape_tag(value)
        rest = rest.lstrip(" ")
    prefix = None
    if rest.startswith(":"):
        prefix, _, rest = rest[1:].partition(" ")
        rest = rest.lstrip(" ")
    trailing = None
    if " :" in rest:
        rest, trailing = rest.split(" :", 1)
    elif rest.startswith(":"):
        rest, trailing = "", rest[1:]
    words = rest.split()
    if not words:
        raise ValueError(f"IRC line has no command: {line!r}")
    params = words[1:]
    if trailing is not None:
        params.append(trailing)
    return IrcMessage(command=words[0].upper(), params=params, prefix=prefix, tags=tags)


def _clean_param(value: str) -> str:
    """A parameter can never carry a line break or a NUL: either would let
    text end our command and start another one of its choosing."""
    return value.replace("\r", " ").replace("\n", " ").replace("\x00", "")


def build_line(command: str, *params: str) -> str:
    """One command line, CRLF included. Every middle parameter must be a
    single word; the last one may hold spaces and goes as the trailing."""
    cleaned = [_clean_param(p) for p in params]
    for middle in cleaned[:-1]:
        if not middle or " " in middle or middle.startswith(":"):
            raise ValueError(f"Not a valid middle IRC parameter: {middle!r}")
    parts = [command, *cleaned[:-1]]
    if cleaned:
        last = cleaned[-1]
        # The colon only where the last parameter needs it, so `JOIN #ops`
        # reads as every client writes it.
        needs_colon = not last or " " in last or last.startswith(":")
        parts.append(":" + last if needs_colon else last)
    return " ".join(parts) + "\r\n"


def payload_budget(nick: str, target: str) -> int:
    """Bytes of text one PRIVMSG to `target` may carry and still reach
    everyone whole, once the server has prepended our full prefix."""
    overhead = (
        _PREFIX_ALLOWANCE
        + len(nick.encode())
        + len(f"PRIVMSG {target} :".encode())
        + 2  # CRLF
    )
    return MAX_LINE_BYTES - overhead


def _cut_utf8(text: str, limit: int) -> tuple[str, str]:
    """Split `text` so the head is at most `limit` bytes, never mid-character
    and, where there is one, at the last space."""
    encoded = text.encode()
    if len(encoded) <= limit:
        return text, ""
    head = encoded[:limit].decode("utf-8", errors="ignore")
    space = head.rfind(" ")
    if space > len(head) // 2:
        return head[:space], text[space + 1 :]
    return head, text[len(head) :]


def split_message(text: str, limit: int) -> list[str]:
    """Cut a rendered body into IRC lines of at most `limit` bytes each.

    IRC has no multi-line message, so each line of the body becomes at least
    one line on the wire. Blank lines are dropped: IRC refuses an empty
    PRIVMSG, and a paragraph break reads fine without one. A line too long for
    the wire is cut at a word boundary where it can be, and never through a
    multi-byte character.
    """
    if limit < 8:
        raise ValueError("IRC line budget too small to carry any text")
    lines: list[str] = []
    for raw in text.splitlines():
        rest = raw.rstrip()
        while rest:
            head, rest = _cut_utf8(rest, limit)
            if head.strip():
                lines.append(head)
            rest = rest.lstrip(" ") if rest else rest
    return lines


def strip_formatting(text: str) -> str:
    """Remove mIRC colour and style codes, which mean nothing to Switch."""
    return _FORMATTING_RE.sub("", text)


_FENCE_RE = re.compile(r"^\s*```.*$", re.MULTILINE)
_HEADING_RE = re.compile(r"^(\s*)#{1,6}\s+(.+?)\s*#*\s*$", re.MULTILINE)
_BOLD_RE = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__")
_ITALIC_RE = re.compile(r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])")
_LINK_RE = re.compile(r"\[([^\]\n]+)\]\((\S+?)\)")
_IMAGE_RE = re.compile(r"!\[([^\]\n]*)\]\((\S+?)\)")


def markdown_to_irc(text: str) -> str:
    """Render Switch Markdown with what IRC clients draw.

    Bold and italics become their control codes, headings become bold lines,
    and a link becomes its text followed by the URL, which every client
    linkifies. Code fences lose their backtick lines — the code inside is
    already plain text — and inline code keeps its backticks, which read as
    code to anyone who has used chat before; IRC's monospace code is too
    rarely drawn to rely on.
    """
    text = _FENCE_RE.sub("", text)
    text = _IMAGE_RE.sub(lambda m: f"{m.group(1) or 'image'}: {m.group(2)}", text)
    text = _LINK_RE.sub(
        lambda m: (
            m.group(2)
            if m.group(1).strip() == m.group(2)
            else f"{m.group(1)} ({m.group(2)})"
        ),
        text,
    )
    text = _HEADING_RE.sub(lambda m: f"{m.group(1)}{BOLD}{m.group(2)}{BOLD}", text)
    text = _BOLD_RE.sub(lambda m: f"{BOLD}{m.group(1) or m.group(2)}{BOLD}", text)
    text = _ITALIC_RE.sub(lambda m: f"{ITALIC}{m.group(1)}{ITALIC}", text)
    return text


_IRC_BOLD_RE = re.compile(r"\x02([^\x02\x0f\n]*?\S)\x02")


def irc_to_markdown(text: str) -> str:
    """Bring a line typed in IRC into Switch: a closed bold run survives as
    Markdown bold, every other formatting code is dropped."""
    return strip_formatting(_IRC_BOLD_RE.sub(lambda m: f"**{m.group(1)}**", text))
