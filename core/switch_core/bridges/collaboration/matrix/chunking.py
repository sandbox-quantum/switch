"""Split outbound Markdown into pieces a homeserver will take as one event each.

A Matrix event may be at most 65,536 bytes of JSON, everything included, and a
message carries its text twice: the Markdown `body` and the rendered
`formatted_body`, where escaping can make one character five. So the split is
made on the Markdown, before rendering, at a size well under the cap and
measured in UTF-8 bytes, which is what the homeserver counts.

Cuts land on line boundaries, and inside a line on a space. A cut inside a
fenced code block closes the fence and reopens it in the next piece, as the
Discord bridge does, so the rest of the code is not shown as prose.
"""

from __future__ import annotations

#: The most a message's Markdown may take, in UTF-8 bytes. Its HTML is at most
#: about five times that, so body, HTML and envelope stay under the 64 KiB cap.
MAX_BODY_BYTES = 8000

_FENCE = "```"


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


# A code block reopened in the next piece carries its language tag only up to
# this long, so the room a reopening takes is bounded.
_MAX_LANGUAGE = 32
_CLOSER = f"\n{_FENCE}"


def _hard_wrap(line: str, budget: int, *, in_code: bool) -> list[str]:
    """Break one line longer than `budget` bytes, on a space where there is one.

    Inside code the cut is made where it falls and nothing is trimmed, so the
    code's own spacing survives being split.
    """
    pieces: list[str] = []
    rest = line
    while _size(rest) > budget:
        # The longest prefix that fits, never cutting a character in two.
        end = len(rest.encode("utf-8")[:budget].decode("utf-8", errors="ignore"))
        cut = -1 if in_code else rest.rfind(" ", 0, end + 1)
        if cut <= 0:
            cut = max(end, 1)
        pieces.append(rest[:cut])
        rest = rest[cut:] if in_code else rest[cut:].lstrip(" ")
    if rest:
        pieces.append(rest)
    return pieces


def split_message(text: str, limit: int = MAX_BODY_BYTES) -> list[str]:
    """`text` as pieces of at most `limit` UTF-8 bytes, cut where a reader pauses.

    Every piece is within `limit`, a closing fence included: the room for one
    is kept free on every piece, and a reopened fence is at most
    `_MAX_LANGUAGE` bytes longer than a bare one.
    """
    if _size(text) <= limit:
        return [text]

    opener_room = len(_FENCE) + _MAX_LANGUAGE + 1
    # A line no longer than this fits after a reopened fence with room left
    # for the closing one.
    line_budget = max(1, limit - len(_CLOSER) - opener_room)
    chunks: list[str] = []
    lines: list[str] = []
    used = 0
    language: str | None = None
    opener: str | None = None

    def flush() -> None:
        nonlocal lines, used, opener
        piece = "\n".join(lines)
        if language is not None:
            piece += _CLOSER
        chunks.append(piece)
        lines, used, opener = [], 0, None
        if language is not None:
            tag = language if len(language.encode("utf-8")) <= _MAX_LANGUAGE else ""
            opener = f"{_FENCE}{tag}"
            lines, used = [opener], _size(opener)

    for raw_line in text.split("\n"):
        for line in _hard_wrap(raw_line, line_budget, in_code=language is not None):
            stripped = line.strip()
            closes = language is not None and stripped.startswith(_FENCE)
            if closes and opener is not None and lines == [opener]:
                # The block ended exactly at the cut: no empty block reopened.
                lines, used, opener, language = [], 0, None, None
                continue
            grown = used + (1 if lines else 0) + _size(line)
            if lines and grown + len(_CLOSER) > limit:
                flush()
                grown = used + (1 if lines else 0) + _size(line)
            lines.append(line)
            used = grown
            if stripped.startswith(_FENCE):
                language = stripped[len(_FENCE) :].strip() if language is None else None
                opener = None

    if lines:
        chunks.append("\n".join(lines))
    return chunks
