"""Parsing and framing for the IRC wire format (RFC 1459/2812, IRCv3 tags).

Pure functions and small dataclasses only — no socket, no asyncio — so the
framing itself is tested without a server.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field

MAX_LINE_BYTES = 512
"""The protocol's own line limit, counting the trailing CRLF and, on the wire
a reader sees, the server-prepended sender prefix."""

# Numeric replies this adapter acts on. RFC 2812 and IRCv3 SASL (ircv3.net).
RPL_WELCOME = "001"
ERR_NICKNAMEINUSE = "433"
ERR_NICKCOLLISION = "436"
ERR_PASSWDMISMATCH = "464"
ERR_YOUREBANNEDCREEP = "465"
RPL_SASLSUCCESS = "903"
ERR_SASLFAIL = "904"
ERR_SASLTOOLONG = "905"
ERR_SASLABORTED = "906"
ERR_SASLALREADY = "907"

# A line we send carries only what we write (`COMMAND params :trailing`); the
# server re-prefixes it with our own `nick!user@host ` before relaying it to
# anyone else, in a length we cannot know in advance — some networks cloak
# hosts to a fixed width, others don't. This is reserved out of our own
# budget so a line that fits what *we* send is not silently truncated by the
# time someone else reads it.
RESERVED_FOR_SERVER_PREFIX = 100


@dataclass(frozen=True)
class ParsedLine:
    tags: dict[str, str]
    prefix: str | None
    command: str
    params: list[str] = field(default_factory=list)

    @property
    def nick(self) -> str | None:
        if self.prefix is None:
            return None
        return self.prefix.split("!", 1)[0]

    @property
    def trailing(self) -> str | None:
        return self.params[-1] if self.params else None


def _unescape_tag_value(value: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(value):
        ch = value[i]
        if ch == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            out.append(
                {":": ";", "s": " ", "\\": "\\", "r": "\r", "n": "\n"}.get(nxt, nxt)
            )
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def parse_line(raw: str) -> ParsedLine:
    """Parse one line already stripped of its trailing CRLF."""
    rest = raw
    tags: dict[str, str] = {}
    if rest.startswith("@"):
        tag_part, _, rest = rest.partition(" ")
        for entry in tag_part[1:].split(";"):
            if not entry:
                continue
            key, _, value = entry.partition("=")
            tags[key] = _unescape_tag_value(value)
        rest = rest.lstrip(" ")

    prefix: str | None = None
    if rest.startswith(":"):
        prefix_part, _, rest = rest.partition(" ")
        prefix = prefix_part[1:]
        rest = rest.lstrip(" ")

    if " :" in rest:
        head, _, trailing = rest.partition(" :")
        params = head.split(" ") if head else []
        params.append(trailing)
    elif rest.startswith(":"):
        params = [rest[1:]]
    else:
        params = rest.split(" ") if rest else []

    if not params:
        return ParsedLine(tags=tags, prefix=prefix, command="", params=[])
    command = params[0]
    return ParsedLine(tags=tags, prefix=prefix, command=command, params=params[1:])


def format_line(command: str, params: list[str]) -> str:
    """Build one wire line (without CRLF) for `command params...`.

    The last param is sent as trailing (`:`-prefixed) when it contains a
    space, starts with `:`, or is empty — the three shapes that would
    otherwise be misread as more than one parameter, or as none.

    A literal CR or LF is removed from every param first. Callers that build
    chat text already split on line breaks before this (`chunking.
    split_to_lines`), but this is the last function standing between a
    string and the wire, so a value that reached it with one anyway — a
    config field, a bug upstream — is neutralised rather than allowed to
    forge a second command.
    """
    parts = [command]
    for i, param in enumerate(params):
        param = param.replace("\r", "").replace("\n", "")
        is_last = i == len(params) - 1
        if is_last and (param == "" or param.startswith(":") or " " in param):
            parts.append(f":{param}")
        else:
            parts.append(param)
    return " ".join(parts)


def sasl_plain_payload(username: str, password: str) -> str:
    """The base64 `AUTHENTICATE` payload for SASL PLAIN (authzid empty)."""
    raw = f"\0{username}\0{password}".encode()
    return base64.b64encode(raw).decode("ascii")
