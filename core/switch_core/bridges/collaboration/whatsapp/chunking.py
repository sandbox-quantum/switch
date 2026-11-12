"""Split outbound text to fit WhatsApp's per-message character limit.

The Cloud API refuses a text body over 4,096 characters rather than truncating
it, which an agent answering a real question passes routinely. A piece is cut
on the latest paragraph break that leaves it at least half full, then the
latest line break, then the latest space, and only cut mid-word when there is
none. A cut inside a code block closes the block at the end of one piece and
reopens it at the start of the next, so neither half arrives as stray backticks
around plain text.
"""

from __future__ import annotations

MAX_MESSAGE = 4096

#: A media caption is capped well below a text body.
MAX_CAPTION = 1024

_FENCE = "```"


def _cut(text: str, limit: int) -> int:
    """The best place to cut `text` at or before `limit`."""
    for separator in ("\n\n", "\n", " "):
        at = text.rfind(separator, 0, limit)
        if at > limit // 2:
            return at
    return limit


def _drop_separator(text: str) -> str:
    """The rest of a body after the one break it was cut on.

    Only that break is the seam between two messages. Stripping more would eat
    the indentation of a code line or a blank line that is part of the body.
    """
    for separator in ("\n\n", "\n", " "):
        if text.startswith(separator):
            return text[len(separator) :]
    return text


def chunk_message(body: str) -> list[str]:
    """Break a body into pieces of at most `MAX_MESSAGE` characters."""
    limit = MAX_MESSAGE
    if len(body) <= limit:
        return [body]
    chunks: list[str] = []
    rest = body
    reopen = ""
    while True:
        candidate = reopen + rest
        if len(candidate) <= limit:
            chunks.append(candidate)
            return chunks
        # Room for a closing fence, in case the cut lands inside a block.
        budget = limit - len(_FENCE) - 1
        cut = _cut(candidate, budget)
        head = candidate[:cut]
        inside_block = head.count(_FENCE) % 2 == 1
        chunks.append(f"{head}\n{_FENCE}" if inside_block else head)
        reopen = f"{_FENCE}\n" if inside_block else ""
        rest = _drop_separator(candidate[cut:])
        if not rest:
            return chunks
