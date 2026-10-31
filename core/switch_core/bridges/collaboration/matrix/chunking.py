"""Split outbound Markdown so one Matrix event stays a sensible size.

Matrix has no per-message character limit of its own, but a homeserver caps the
whole event (64 KiB by default) and an agent's answer can run past that. The
limit here leaves room for the HTML form and the event's relation fields, and
splits on lines, reopening a fenced code block across the cut so the second
half does not arrive as prose.
"""

from __future__ import annotations

MAX_MESSAGE = 30000

_FENCE = "```"


def _hard_wrap(line: str, budget: int) -> list[str]:
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
    if len(content) <= limit:
        return [content]

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
        body = "\n".join(buf)
        if language is None or body != f"{_FENCE}{language}":
            chunks.append(body)
    return chunks
