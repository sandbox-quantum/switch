"""Bound outbound Matrix events below common homeserver event-size limits."""

from __future__ import annotations

MAX_MESSAGE = 4000


def chunk_message(content: str, *, limit: int = MAX_MESSAGE) -> list[str]:
    """Split plain text on readable boundaries without dropping characters."""
    if len(content) <= limit:
        return [content]

    chunks: list[str] = []
    rest = content
    while len(rest) > limit:
        cut = rest.rfind("\n", 0, limit + 1)
        if cut <= 0:
            cut = rest.rfind(" ", 0, limit + 1)
        if cut <= 0:
            cut = limit
        chunks.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        chunks.append(rest)
    return chunks
