"""Split outbound text to fit Discord's per-message character limit.

Discord caps a message at 2,000 characters and rejects anything longer with a
400 — an order of magnitude tighter than Slack, Mattermost, Teams or
Telegram, and well under what an agent writes when it answers a real question.
Without splitting, the adapter's `HTTPException` handler logs the rejection
and returns, so the message never reaches the channel and the user is shown
nothing at all.
"""

from __future__ import annotations

MAX_MESSAGE = 2000

_FENCE = "```"


def _current_len(buf: list[str], language: str | None) -> int:
    """Return the length of the message if buf were flushed right now."""
    if not buf:
        return 0
    base = sum(len(x) for x in buf) + (len(buf) - 1)
    if language is not None:
        base += 1 + len(_FENCE)
    return base


def _room_in_buf(buf: list[str], language: str | None, limit: int) -> int:
    """Return the remaining character capacity in buf for an additional line."""
    if not buf:
        overhead = (1 + len(_FENCE)) if language is not None else 0
        return max(0, limit - overhead)
    overhead = _current_len(buf, language) + 1
    return max(0, limit - overhead)


def _has_content(buf: list[str], language: str | None) -> bool:
    """Return True if buf contains actual content beyond an opening fence."""
    if not buf:
        return False
    if language is not None:
        return len(buf) > 1
    return True


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

    chunks: list[str] = []
    buf: list[str] = []
    language: str | None = None

    def flush() -> None:
        nonlocal buf
        if not buf:
            return
        body = "\n".join(buf)
        if language is not None:
            body += f"\n{_FENCE}"
        chunks.append(body)
        buf = []
        if language is not None:
            buf.append(f"{_FENCE}{language}")

    def add_line(line: str) -> None:
        nonlocal buf
        rest = line
        while True:
            room = _room_in_buf(buf, language, limit)
            if len(rest) <= room:
                buf.append(rest)
                break

            if _has_content(buf, language):
                flush()
                continue

            cut = rest.rfind(" ", 0, room + 1)
            if cut <= 0:
                cut = room
            piece = rest[:cut]
            buf.append(piece)
            rest = rest[cut:].lstrip(" ")
            flush()

    for raw_line in content.split("\n"):
        stripped = raw_line.strip()
        if stripped.startswith(_FENCE):
            if language is None:
                new_lang = stripped[len(_FENCE) :].strip()
                fence_overhead = len(raw_line) + 1 + len(_FENCE)
                if buf and _room_in_buf(buf, None, limit) < fence_overhead + 1:
                    flush()
                buf.append(raw_line)
                language = new_lang
            else:
                if _current_len(buf, None) + 1 + len(raw_line) <= limit:
                    buf.append(raw_line)
                    language = None
                else:
                    flush()
                    language = None
        else:
            add_line(raw_line)

    if buf:
        chunks.append("\n".join(buf))

    return chunks
