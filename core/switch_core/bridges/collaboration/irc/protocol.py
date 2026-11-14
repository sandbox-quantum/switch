"""The IRC wire format: one line, parsed into its parts and built back.

A line is `[@tags] [:source] COMMAND param ... [:trailing]`, at most 512 bytes
with its CRLF, not counting the tags (IRCv3 gives those their own 8191). Only
what the bridge needs is here; it is not a general IRC library.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# The longest line a server accepts, CRLF included and tags excluded.
MAX_LINE_BYTES = 512

# Characters that would end a line early or end the string, and so turn the
# rest of a parameter into a command of its own.
_FORBIDDEN = ("\r", "\n", "\0")

_TAG_UNESCAPE = {":": ";", "s": " ", "\\": "\\", "r": "\r", "n": "\n"}


class LineError(ValueError):
    """A line could not be built, because a parameter would break the line."""


@dataclass(frozen=True)
class Source:
    """Who sent a line: `nick!user@host`, or a server's name alone."""

    nick: str
    user: str | None = None
    host: str | None = None

    @classmethod
    def parse(cls, text: str) -> Source:
        nick, _, rest = text.partition("!")
        user, _, host = rest.partition("@")
        if not rest:
            nick, _, host = text.partition("@")
            return cls(nick=nick, host=host or None)
        return cls(nick=nick, user=user or None, host=host or None)


@dataclass(frozen=True)
class Line:
    command: str
    params: list[str] = field(default_factory=list)
    source: Source | None = None
    tags: dict[str, str] = field(default_factory=dict)

    def param(self, index: int, default: str = "") -> str:
        return self.params[index] if index < len(self.params) else default


def _unescape_tag(value: str) -> str:
    out: list[str] = []
    chars = iter(value)
    for char in chars:
        if char != "\\":
            out.append(char)
            continue
        following = next(chars, "")
        out.append(_TAG_UNESCAPE.get(following, following))
    return "".join(out)


def parse(raw: str) -> Line:
    """One line from the server, without its CRLF."""
    rest = raw.rstrip("\r\n")
    tags: dict[str, str] = {}
    if rest.startswith("@"):
        tag_text, _, rest = rest[1:].partition(" ")
        for item in tag_text.split(";"):
            if not item:
                continue
            key, _, value = item.partition("=")
            tags[key] = _unescape_tag(value)
        rest = rest.lstrip(" ")
    source = None
    if rest.startswith(":"):
        source_text, _, rest = rest[1:].partition(" ")
        source = Source.parse(source_text)
        rest = rest.lstrip(" ")
    trailing = None
    if " :" in rest:
        rest, trailing = rest.split(" :", 1)
    elif rest.startswith(":"):
        rest, trailing = "", rest[1:]
    words = rest.split()
    command = words[0].upper() if words else ""
    params = words[1:]
    if trailing is not None:
        params.append(trailing)
    return Line(command=command, params=params, source=source, tags=tags)


def build(command: str, *params: str) -> str:
    """A line to send, without its CRLF.

    Refuses a parameter holding CR, LF or NUL, which would end the line early
    and send the rest as a command of its own; and, but for the last, one that
    is empty, holds a space or starts with a colon, which IRC cannot carry
    there.
    """
    if not command or any(not char.isalnum() for char in command):
        raise LineError(f"Not an IRC command: {command!r}")
    for value in params:
        if any(char in value for char in _FORBIDDEN):
            raise LineError("A line cannot carry CR, LF or NUL")
    *middle, last = params or ("",)
    for value in middle:
        if not value or " " in value or value.startswith(":"):
            raise LineError(f"Only the last parameter may be {value!r}")
    words = [command.upper(), *middle]
    if params:
        needs_colon = not last or " " in last or last.startswith(":")
        words.append(f":{last}" if needs_colon else last)
    line = " ".join(words)
    if len(line.encode()) + 2 > MAX_LINE_BYTES:
        raise LineError(f"The line is longer than {MAX_LINE_BYTES} bytes")
    return line


def casefold(name: str, mapping: str = "rfc1459") -> str:
    """A nick or channel as the server compares it (ISUPPORT `CASEMAPPING`).

    Only ASCII letters change under `ascii`; `rfc1459` also folds `[]\\~` to
    `{}|^`, which those networks treat as the same characters. Never Python's
    own `lower`, which folds letters a server keeps apart.
    """
    folded = "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in name)
    if mapping in ("rfc1459", "strict-rfc1459"):
        upper = "[]\\" if mapping == "strict-rfc1459" else "[]\\~"
        lower = "{}|" if mapping == "strict-rfc1459" else "{}|^"
        folded = folded.translate(str.maketrans(upper, lower))
    return folded


def is_channel(target: str, chantypes: str = "#&") -> bool:
    return bool(target) and target[0] in chantypes


def valid_channel(name: str, chantypes: str = "#&") -> bool:
    """Whether `name` can be joined: a channel prefix, then no space, comma,
    BELL or control character, within the usual 50 characters."""
    return (
        is_channel(name, chantypes)
        and 1 < len(name) <= 50
        and not any(c in " ,\x07" or ord(c) < 32 for c in name)
    )


def valid_nick(nick: str) -> bool:
    """Whether `nick` is a nick every network accepts: a letter or one of
    `[]\\`_^{|}` first, then those, digits and `-`."""
    if not nick or len(nick) > 30:
        return False
    special = "[]\\`_^{|}"
    if not (nick[0].isascii() and (nick[0].isalpha() or nick[0] in special)):
        return False
    return all(
        c.isascii() and (c.isalnum() or c in special or c == "-") for c in nick[1:]
    )
