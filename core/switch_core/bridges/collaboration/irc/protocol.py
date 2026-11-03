"""IRC's wire format: one line read, one line built, and how much text fits.

A line is at most 512 bytes with its CRLF, and what the bot sends is relayed
to everyone else with the bot's own `:nick!user@host ` in front of it, so the
text of a message has to leave room for that as well. Tags (IRCv3) have a
budget of their own and are not counted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_LINE_BYTES = 512

# What the server puts in front of a relayed line besides the nick: `!`, the
# username (`USERLEN`, 10 on most networks, padded here for the ones that
# allow more), `@` and the host, which can be a cloak as long as a hostname.
_SOURCE_RESERVE = len(":!@ ") + 18 + 63

# A nick taken by someone else is retried with this many underscores at most
# (`client.py`), and a line is cut for the longest of those.
NICK_FALLBACKS = 3

# RFC 2812's nick characters. Networks allow different lengths (`NICKLEN`), so
# only the shape is checked here and the network has the last word.
_NICK = re.compile(r"[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}")

# A channel name: `#` or `&`, then anything but a space, a comma, a bell, a
# colon or a control character, which is what every network refuses or reads
# as a separator.
_CHANNEL = re.compile(r"[#&][^\x00-\x20,:\x7f]{1,49}")

_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")

_TAG_UNESCAPED = {":": ";", "s": " ", "\\": "\\", "r": "\r", "n": "\n"}


@dataclass(frozen=True)
class Line:
    command: str
    params: tuple[str, ...]
    source: str | None = None
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def nick(self) -> str | None:
        """Who sent it, for a line from a client (`nick!user@host`)."""
        if self.source is None or "!" not in self.source:
            return None
        return self.source.split("!", 1)[0]


def parse(raw: str) -> Line:
    """One line as the server sent it, without its CRLF."""
    rest = raw
    tags: dict[str, str] = {}
    if rest.startswith("@"):
        tag_text, _, rest = rest[1:].partition(" ")
        for item in tag_text.split(";"):
            key, _, value = item.partition("=")
            if key:
                tags[key] = _unescape_tag(value)
        rest = rest.lstrip(" ")
    source = None
    if rest.startswith(":"):
        source, _, rest = rest[1:].partition(" ")
        rest = rest.lstrip(" ")
    trailing: str | None = None
    if " :" in rest:
        rest, trailing = rest.split(" :", 1)
    elif rest.startswith(":"):
        rest, trailing = "", rest[1:]
    words = rest.split()
    if not words:
        raise ValueError("an IRC line with no command")
    params = words[1:] + ([trailing] if trailing is not None else [])
    return Line(
        command=words[0].upper(), params=tuple(params), source=source, tags=tags
    )


def _unescape_tag(value: str) -> str:
    out: list[str] = []
    escaped = False
    for char in value:
        if escaped:
            out.append(_TAG_UNESCAPED.get(char, char))
            escaped = False
        elif char == "\\":
            escaped = True
        else:
            out.append(char)
    return "".join(out)


def build(command: str, *params: str) -> str:
    """A line to send, without its CRLF.

    Refuses anything that would end the line early or smuggle in a second one:
    a CR, LF or NUL anywhere, or a space in any parameter but the last. Text
    from agents and people reaches here, and a line break in it would be a
    command of its own to the server.
    """
    for param in params:
        if any(char in param for char in "\r\n\x00"):
            raise ValueError("an IRC parameter must not contain CR, LF or NUL")
    *middle, last = params or ("",)
    for param in middle:
        if not param or " " in param or param.startswith(":"):
            raise ValueError(f"{param!r} cannot be a middle IRC parameter")
    if not params:
        line = command
    elif not last or " " in last or last.startswith(":"):
        line = " ".join([command, *middle, f":{last}"])
    else:
        line = " ".join([command, *middle, last])
    if len(line.encode()) > MAX_LINE_BYTES - 2:
        raise ValueError(f"an IRC line is limited to {MAX_LINE_BYTES} bytes")
    return line


def casefold(name: str) -> str:
    """A nick or channel as the network compares them: A-Z folded and nothing
    else, which is what modern networks use (`CASEMAPPING=ascii`). RFC 1459's
    mapping of `[]` to `{}` is left alone, so two such names stay two ids."""
    return name.translate(_ASCII_LOWER)


def is_nick(name: str) -> bool:
    return _NICK.fullmatch(name) is not None


def is_channel(name: str) -> bool:
    return _CHANNEL.fullmatch(name) is not None


def text_budget(nick: str, target: str) -> int:
    """How many bytes of text fit in one `PRIVMSG` to `target`, once the server
    has put the bot's source in front of it, whichever fallback nick the bot
    is using."""
    longest_nick = len(nick.encode()) + NICK_FALLBACKS
    command = len(f"PRIVMSG {target} :".encode())
    return MAX_LINE_BYTES - 2 - _SOURCE_RESERVE - longest_nick - command
