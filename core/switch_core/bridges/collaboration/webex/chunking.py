"""Split outbound Markdown to fit one Webex message.

Webex measures a message's text in bytes, not characters, so a reply in a
script that takes several bytes a character is cut sooner than its length
suggests. A code fence open at a cut is closed there and reopened in the next
part, so each part still renders on its own.
"""

from __future__ import annotations

# Webex refuses a message whose `markdown` is longer than 7439 bytes. Some
# room is kept for the sender's label the adapter puts on the first part.
MAX_MESSAGE_BYTES = 7000

_FENCE = "```"


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def _cut_line(line: str, budget: int) -> list[str]:
    """One line too long for a message, cut at spaces where it can be."""
    pieces: list[str] = []
    rest = line
    while _size(rest) > budget:
        end = len(rest)
        while _size(rest[:end]) > budget:
            end -= max(1, (_size(rest[:end]) - budget) // 4)
        space = rest.rfind(" ", 0, end)
        cut = space if space > end // 2 else end
        pieces.append(rest[:cut])
        rest = rest[cut:].lstrip(" ")
    pieces.append(rest)
    return pieces


def chunk_message(text: str, limit: int = MAX_MESSAGE_BYTES) -> list[str]:
    if _size(text) <= limit:
        return [text]
    budget = limit - 2 * (len(_FENCE) + 1) - 32
    chunks: list[str] = []
    lines: list[str] = []
    used = 0
    fence: str | None = None

    def flush() -> None:
        nonlocal lines, used
        body = "\n".join(lines)
        if fence is not None:
            body = f"{body}\n{_FENCE}"
        if body.strip():
            chunks.append(body)
        lines = [fence] if fence is not None else []
        used = _size(fence) + 1 if fence is not None else 0

    for line in text.split("\n"):
        for piece in _cut_line(line, budget):
            cost = _size(piece) + 1
            if lines and used + cost > budget:
                flush()
            lines.append(piece)
            used += cost
        stripped = line.strip()
        if stripped.startswith(_FENCE):
            fence = None if fence is not None else stripped
    if lines:
        fence = None
        flush()
    return chunks or [text]
