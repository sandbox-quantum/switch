from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

CaseMapping = Literal["ascii", "rfc1459", "strict-rfc1459"]
_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_ESCAPES = {"s": " ", ":": ";", "r": "\r", "n": "\n", "\\": "\\"}
_NICK = re.compile(r"[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}\Z")


def fold(value: str, mapping: CaseMapping) -> str:
    value = value.translate(_LOWER)
    if mapping != "ascii":
        value = value.translate(str.maketrans("[]\\", "{}|"))
    if mapping == "rfc1459":
        value = value.replace("^", "~")
    return value


def is_nick(value: str) -> bool:
    return _NICK.fullmatch(value) is not None


def is_channel(value: str) -> bool:
    return (
        value.startswith(("#", "&"))
        and 1 < len(value.encode()) <= 200
        and not any(ord(c) <= 32 or ord(c) == 127 or c in ",:" for c in value)
    )


def _unescape(value: str) -> str:
    return re.sub(
        r"\\(.)?", lambda match: _ESCAPES.get(match[1], match[1] or ""), value
    )


@dataclass(frozen=True)
class Line:
    command: str
    params: tuple[str, ...]
    source: str | None
    tags: dict[str, str]

    @property
    def nick(self) -> str | None:
        return (
            self.source.split("!", 1)[0] if self.source and "!" in self.source else None
        )


def parse(raw: str) -> Line:
    raw = raw.removesuffix("\n").removesuffix("\r")
    if not raw or any(c in raw for c in "\x00\r\n"):
        raise ValueError("Invalid IRC line")
    tags: dict[str, str] = {}
    if raw.startswith("@"):
        tag_text, separator, raw = raw.partition(" ")
        if not separator or len(tag_text.encode()) > 8191:
            raise ValueError("Invalid IRC tags")
        for entry in tag_text[1:].split(";"):
            key, _, value = entry.partition("=")
            tags[key] = _unescape(value)
    source = None
    if raw.startswith(":"):
        source, separator, raw = raw[1:].partition(" ")
        if not separator:
            raise ValueError("IRC prefix has no command")
    head, separator, trailing = raw.partition(" :")
    words = head.split()
    if not words:
        raise ValueError("IRC line has no command")
    params = words[1:] + ([trailing] if separator else [])
    return Line(words[0].upper(), tuple(params), source, tags)


def build(command: str, *params: str, label: str | None = None) -> bytes:
    if not re.fullmatch(r"[A-Z]+|[0-9]{3}", command):
        raise ValueError("Invalid IRC command")
    if any(any(c in value for c in "\r\n\x00") for value in params):
        raise ValueError("IRC parameters cannot contain line breaks or NUL")
    if any(not p or p.startswith(":") or " " in p for p in params[:-1]):
        raise ValueError("Invalid IRC middle parameter")
    body = command
    if params:
        body += " " + " ".join(params[:-1]) if len(params) > 1 else ""
        body += " :" + params[-1]
    if label is not None:
        if not re.fullmatch(r"[a-f0-9]{32}", label):
            raise ValueError("Invalid IRC label")
        body = f"@label={label} {body}"
    if len(body.encode()) > 510:
        raise ValueError("IRC command exceeds the 512-byte line limit")
    return (body + "\r\n").encode()
