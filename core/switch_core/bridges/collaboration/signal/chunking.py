from __future__ import annotations

MAX_SIGNAL_MESSAGE = 2_000


def chunk_signal_message(text: str, limit: int = MAX_SIGNAL_MESSAGE) -> list[str]:
    """Split without cutting words where possible; never emit an empty chunk."""
    remaining = text.strip()
    if not remaining:
        return [""]
    chunks: list[str] = []
    while len(remaining) > limit:
        cut = remaining.rfind("\n", 0, limit + 1)
        if cut < limit // 2:
            cut = remaining.rfind(" ", 0, limit + 1)
        if cut < limit // 2:
            cut = limit
        chunks.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks
