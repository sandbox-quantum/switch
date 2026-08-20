"""Split outbound text to fit Discord's per-message character limit.

Discord caps a message at 2,000 characters and rejects anything longer with a
400 — an order of magnitude tighter than Slack, Mattermost, Teams or
Telegram, and well
under what an agent writes when it answers a real question. Without splitting,
the adapter's `HTTPException` handler logs the rejection and returns, so the
message never reaches the channel and the user is shown nothing at all.
"""

from __future__ import annotations

MAX_MESSAGE = 2000

_FENCE = "```"


def _hard_wrap(line: str, budget: int) -> list[str]:
    """Break one over-long line, preferring a space over cutting a word."""
    if len(line) <= budget:
        return [line]

    pieces: list[str] = []
    rest = line
    while len(rest) > budget:
        cut = rest.rfind(" ", 0, budget + 1)
        if cut <= 0:
            cut = budget
        pieces.append(rest[:cut])
        rest = rest[cut:].lstrip(" ")
    if rest:
        pieces.append(rest)
    return pieces


def chunk_message(content: str, limit: int = MAX_MESSAGE) -> list[str]:
    """Split `content` into pieces that each fit `limit`.

    Breaks on line boundaries where it can, and on a word where a single line
    is itself too long, so the split lands somewhere the reader would have
    paused anyway.

    A split that lands inside a fenced code block closes the fence at the end
    of one chunk and reopens it — with the same language — at the start of the
    next. Agents post code constantly, and a fence torn in half renders the
    whole remainder as unformatted text with a stray ``` in it.
    """
    if len(content) <= limit:
        return [content]

    # Leave room for a closing fence on this chunk and a reopening one on the
    # next, so honouring a code block can never push a chunk over the limit.
    budget = limit - (2 * len(_FENCE) + 2)

    chunks: list[str] = []
    buf: list[str] = []
    used = 0
    language: str | None = None

    def flush() -> None:
        nonlocal buf, used
        if not buf:
            return
        body = "\n".join(buf)
        if language is not None:
            body += f"\n{_FENCE}"
        chunks.append(body)
        buf = []
        used = 0
        if language is not None:
            opener = f"{_FENCE}{language}"
            buf.append(opener)
            used = len(opener) + 1

    for raw_line in content.split("\n"):
        for line in _hard_wrap(raw_line, budget):
            if used + len(line) + 1 > budget and buf:
                flush()
            buf.append(line)
            used += len(line) + 1

            stripped = line.strip()
            if stripped.startswith(_FENCE):
                if language is None:
                    language = stripped[len(_FENCE) :].strip()
                else:
                    language = None

    if buf:
        # The tail is emitted as-is: an unclosed fence here was unclosed in the
        # original too, and inventing a terminator would change the content.
        chunks.append("\n".join(buf))

    return chunks
