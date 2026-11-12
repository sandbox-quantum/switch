"""Split outbound text to fit Discord's per-message character limit.

Discord caps a message at 2,000 characters and rejects anything longer with a
400 — an order of magnitude tighter than Slack, Mattermost, Teams or
Telegram, and well
under what an agent writes when it answers a real question. Without splitting,
the adapter's `HTTPException` handler logs the rejection and returns, so the
message never reaches the channel and the user is shown nothing at all.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.chunking import split_markdown

MAX_MESSAGE = 2000


def chunk_message(content: str) -> list[str]:
    """Split `content` into Discord-sized parts, keeping code fences balanced."""
    return split_markdown(content, MAX_MESSAGE)
