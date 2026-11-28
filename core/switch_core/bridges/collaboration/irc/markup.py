from __future__ import annotations

import re

from switch_core.bridges.collaboration.session.renderers import Markup

_COLOUR = re.compile(
    r"\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9A-Fa-f]{6}(?:,[0-9A-Fa-f]{6})?)?"
)
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def plain(text: str) -> str:
    return _CONTROLS.sub("", _COLOUR.sub("", text)).replace("\r", "")


def render(text: str) -> str:
    text = plain(text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", text)
    lines = []
    fenced = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            line = re.sub(r"^#{1,6} +", "", line)
            line = re.sub(r"(\*\*|__)(.+?)\1", r"\2", line)
            line = re.sub(r"`([^`]+)`", r"\1", line)
        lines.append(line)
    return "\n".join(lines)


def split_lines(text: str, budget: int) -> list[str]:
    if budget < 4:
        raise ValueError("IRC target leaves no room for a message")
    result = []
    for line in plain(text).splitlines():
        if not line:
            continue
        while len(line.encode()) > budget:
            chunk = line.encode()[:budget].decode("utf-8", errors="ignore")
            # Keep code indentation intact. Reflow only ordinary prose.
            boundary = chunk.rfind(" ") if not line.startswith((" ", "\t")) else -1
            if boundary > len(chunk) // 2:
                chunk = chunk[:boundary]
                line = line[len(chunk) + 1 :]
            else:
                line = line[len(chunk) :]
            result.append(chunk)
        if line:
            result.append(line)
    return result


class IrcMarkup(Markup):
    def bold(self, text: str) -> str:
        return text

    def code(self, text: str) -> str:
        return text


IRC_MARKUP = IrcMarkup()
