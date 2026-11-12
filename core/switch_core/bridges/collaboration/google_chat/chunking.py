"""Split outbound text to fit Google Chat's per-message character limit (4096 chars)."""

from __future__ import annotations

MAX_MESSAGE_LENGTH = 4096


def split_message(text: str, limit: int = MAX_MESSAGE_LENGTH) -> list[str]:
    """Split text into chunks of at most `limit` characters, preferring newline boundaries."""
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break

        # Look for newline break within limit
        cut_idx = remaining.rfind("\n", 0, limit)
        if cut_idx == -1 or cut_idx < limit // 3:
            # Look for space
            cut_idx = remaining.rfind(" ", 0, limit)
        if cut_idx == -1 or cut_idx < limit // 3:
            cut_idx = limit

        chunk = remaining[:cut_idx].rstrip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut_idx:].lstrip("\n")
    return chunks
