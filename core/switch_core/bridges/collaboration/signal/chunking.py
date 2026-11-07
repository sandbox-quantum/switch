"""Message chunking for Signal adapter.

Capped at 2,000 characters for mobile readability. Splits on whitespace or
newlines where possible, falling back to clean slicing.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

MAX_SIGNAL_MESSAGE_LENGTH = 2000


def chunk_message(text: str, limit: int = MAX_SIGNAL_MESSAGE_LENGTH) -> list[str]:
    """Split text into chunks of at most `limit` characters."""
    if not text:
        return [""]

    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text

    while len(remaining) > limit:
        cut = limit

        # Prefer newline split
        nl_idx = remaining.rfind("\n", 0, cut)
        if nl_idx > cut // 2:
            cut = nl_idx + 1
        else:
            # Fall back to space split
            space_idx = remaining.rfind(" ", 0, cut)
            if space_idx > cut // 2:
                cut = space_idx + 1

        chunks.append(remaining[:cut].rstrip("\r\n"))
        remaining = remaining[cut:].lstrip("\r\n")

    if remaining:
        chunks.append(remaining)

    return chunks
