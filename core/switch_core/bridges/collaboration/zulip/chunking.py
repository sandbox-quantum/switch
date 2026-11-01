"""Chunking helper for Zulip (10,000 character limit)."""

from __future__ import annotations

MAX_ZULIP_MESSAGE_LENGTH = 10000


def split_zulip_message(text: str, limit: int = MAX_ZULIP_MESSAGE_LENGTH) -> list[str]:
    """Split outbound messages cleanly on newline or space boundaries under limit."""
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        cut_idx = remaining.rfind("\n", 0, limit)
        if cut_idx == -1 or cut_idx < limit // 3:
            cut_idx = remaining.rfind(" ", 0, limit)
        if cut_idx == -1 or cut_idx < limit // 3:
            cut_idx = limit

        chunk = remaining[:cut_idx].rstrip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut_idx:].lstrip("\n")
    return chunks
