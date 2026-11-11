"""Split an outbound message to fit Webex's per-message size, cleanly.

Webex rejects a message whose text or Markdown is over 7,439 bytes. A reply an
agent writes for a real question is often longer, so it is sent as several
messages, cut between lines. A code block the cut falls in is closed at the end
of one piece and reopened at the start of the next, so each renders on its own.
"""

from __future__ import annotations

import re

#: Webex's limit is 7,439 bytes; the margin leaves room for the agent's name at
#: the head of each piece.
MAX_MESSAGE_BYTES = 7000

_FENCE = re.compile(r"^\s*(```|~~~)")


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def _hard_cut(line: str, limit: int) -> list[str]:
    """One line longer than `limit`, in pieces that fit."""
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


def chunk_message(text: str, limit: int = MAX_MESSAGE_BYTES) -> list[str]:
    """`text` in pieces of at most `limit` bytes."""
    if _size(text) <= limit:
        return [text]
    room = limit - 8  # a closing fence is added when a cut falls inside a block
    pieces: list[str] = []
    current: list[str] = []
    used = 0
    fence: str | None = None
    for raw in text.split("\n"):
        for line in _hard_cut(raw, room) if _size(raw) > room else [raw]:
            cost = _size(line) + 1
            if current and used + cost > room:
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
