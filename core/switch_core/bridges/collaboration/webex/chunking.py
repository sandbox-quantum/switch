"""Split outbound text to fit Cisco Webex per-message character limit."""

from __future__ import annotations

# Cisco Webex messages endpoint caps markdown/text at 7439 characters.
MAX_MESSAGE = 7439

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
    """Split content into chunks that each fit limit, preserving code fences."""
    if len(content) <= limit:
        return [content]

    budget = limit - (2 * len(_FENCE) + 2)
    chunks: list[str] = []
    buf: list[str] = []
    used = 0
    language: str | None = None

    def flush() -> None:
        nonlocal used, buf
        if not buf:
            return
        text = "\n".join(buf)
        if language is not None:
            text = f"{text}\n{_FENCE}"
        chunks.append(text)
        buf = []
        used = 0

    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith(_FENCE):
            if language is None:
                language = stripped.removeprefix(_FENCE).strip()
            else:
                language = None

        wrapped_lines = _hard_wrap(line, budget)
        for subline in wrapped_lines:
            line_cost = len(subline) + 1
            if used + line_cost > budget and buf:
                flush()
                if language is not None:
                    prefix = f"{_FENCE}{language}" if language else _FENCE
                    buf.append(prefix)
                    used += len(prefix) + 1

            buf.append(subline)
            used += line_cost

    flush()
    return chunks or [content]
