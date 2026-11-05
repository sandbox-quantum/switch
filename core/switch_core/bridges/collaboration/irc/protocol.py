"""IRC's wire format, as far as the bridge needs it (RFC 1459/2812 with the
IRCv3 message tags): reading a line, writing one, and cutting a reply into
lines a server will relay whole.

Pure functions, so the adapter's network code stays small and these are
tested without a server.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: A line is at most 512 bytes with its CRLF (RFC 1459 §2.3). The tags in
#: front of it have a separate budget (IRCv3), which the bridge never sends.
MAX_LINE_BYTES = 512

#: What a server prepends when it relays our line to everyone else:
#: `:nick!user@host `. We cannot know our own host as the server writes it,
#: so this much is kept free for it: a 30-character nick and user and a
#: 63-character host, the common limits, plus the punctuation.
SOURCE_ALLOWANCE = 1 + 30 + 1 + 10 + 1 + 63 + 1


@dataclass(frozen=True)
class Line:
    """One parsed IRC line."""

    command: str
    params: list[str]
    source: str | None = None
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def nick(self) -> str | None:
        """The nick in the line's source, or None for a server's line."""
        if self.source is None:
            return None
        if "!" in self.source or "@" in self.source:
            return self.source.split("!", 1)[0].split("@", 1)[0]
        # A bare source is a server's name (it has a dot) or a nick.
        return None if "." in self.source else self.source


_TAG_ESCAPES = {":": ";", "s": " ", "\\": "\\", "r": "\r", "n": "\n"}


def _unescape_tag(value: str) -> str:
    out: list[str] = []
    chars = iter(value)
    for char in chars:
        if char != "\\":
            out.append(char)
            continue
        nxt = next(chars, "")
        out.append(_TAG_ESCAPES.get(nxt, nxt))
    return "".join(out)


def parse_line(raw: str) -> Line | None:
    """Read one line, without its CRLF. None for an empty or unreadable one."""
    rest = raw.rstrip("\r\n")
    tags: dict[str, str] = {}
    if rest.startswith("@"):
        tag_part, _, rest = rest[1:].partition(" ")
        for item in tag_part.split(";"):
            if not item:
                continue
            key, _, value = item.partition("=")
            tags[key] = _unescape_tag(value)
        rest = rest.lstrip(" ")
    source: str | None = None
    if rest.startswith(":"):
        source, _, rest = rest[1:].partition(" ")
        rest = rest.lstrip(" ")
    if not rest:
        return None
    params: list[str] = []
    while rest:
        if rest.startswith(":"):
            params.append(rest[1:])
            break
        word, _, rest = rest.partition(" ")
        if word:
            params.append(word)
        rest = rest.lstrip(" ")
    if not params:
        return None
    command, *args = params
    return Line(command=command.upper(), params=args, source=source, tags=tags)


_UNSAFE = re.compile(r"[\r\n\x00]")


def format_line(command: str, *params: str) -> str:
    """One line to send, without its CRLF. The last parameter may hold
    spaces; no parameter may hold a line break, which would let a message
    smuggle a second command onto the wire."""
    if not params:
        return command
    for param in params:
        if _UNSAFE.search(param):
            raise ValueError("an IRC parameter cannot hold CR, LF or NUL")
    *middle, last = params
    for param in middle:
        if not param or " " in param or param.startswith(":"):
            raise ValueError(f"{param!r} cannot be a middle IRC parameter")
    # The last parameter is marked with `:` only where it must be: when it
    # is empty, holds a space or starts with one.
    if not last or " " in last or last.startswith(":"):
        last = f":{last}"
    return " ".join([command, *middle, last])


def privmsg_budget(target: str) -> int:
    """How many bytes of text one `PRIVMSG target :text` can carry and
    still reach every reader whole, once the server has put our source in
    front of it."""
    overhead = len(f"PRIVMSG {target} :".encode()) + 2 + SOURCE_ALLOWANCE
    return MAX_LINE_BYTES - overhead


def split_text(text: str, budget: int) -> list[str]:
    """Cut `text` into lines of at most `budget` UTF-8 bytes each.

    One line per line of the text, blank ones dropped (IRC has no empty
    message). A line too long is cut at the last space that fits, or, in a
    word longer than the budget, at the last whole character that fits, so
    no character is ever split across two messages."""
    if budget < 8:
        raise ValueError("too small a budget to say anything")
    out: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.rstrip()
        while line:
            if len(line.encode()) <= budget:
                out.append(line)
                break
            cut = _fit(line, budget)
            space = line.rfind(" ", 0, cut + 1)
            if space > 0:
                cut = space
            out.append(line[:cut].rstrip())
            line = line[cut:].lstrip()
    return out


def _fit(text: str, budget: int) -> int:
    """The number of leading characters of `text` within `budget` bytes."""
    used = 0
    for index, char in enumerate(text):
        used += len(char.encode())
        if used > budget:
            return index
    return len(text)


# mIRC formatting: bold, colour (with up to two numbers), hex colour, reset,
# reverse, italics, strikethrough, monospace, underline.
_FORMATTING = re.compile(
    r"\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?)?"
    r"|[\x02\x0f\x11\x16\x1d\x1e\x1f]"
)


def strip_formatting(text: str) -> str:
    """`text` without IRC's colour and style codes."""
    return _FORMATTING.sub("", text)


BOLD = "\x02"
ITALIC = "\x1d"
MONOSPACE = "\x11"

_LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")
_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__")
_ITALIC = re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])")
_CODE = re.compile(r"`([^`\n]+)`")
_HEADING = re.compile(r"^#{1,6}\s+(.*)$", re.MULTILINE)
_FENCE = re.compile(r"^```[\w+-]*\s*$", re.MULTILINE)


def markdown_to_irc(text: str) -> str:
    """Switch Markdown in IRC's own markup: bold, italics and monospace become
    style codes, a link becomes `text (url)`, a heading a bold line, and a
    code fence's markers are dropped so its lines are sent as they are."""
    text = _FENCE.sub("", text)
    text = _LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", text)
    text = _CODE.sub(lambda m: f"{MONOSPACE}{m.group(1)}{MONOSPACE}", text)
    text = _BOLD.sub(lambda m: f"{BOLD}{m.group(1) or m.group(2)}{BOLD}", text)
    text = _ITALIC.sub(lambda m: f"{ITALIC}{m.group(1)}{ITALIC}", text)
    return _HEADING.sub(lambda m: f"{BOLD}{m.group(1)}{BOLD}", text)


def is_channel(target: str) -> bool:
    """Whether `target` names a channel rather than a person."""
    return target[:1] in "#&+!"
