"""Splitting a long reply into messages Webex will take.

Webex refuses a message whose text is over 7439 bytes (UTF-8, markup
included), so a long reply goes out as several. Each piece is cut at the best
boundary that fits — a blank line, then a line, then a space — and a code
block cut in two is closed at the end of one piece and reopened at the start
of the next, so neither half renders as prose.
"""

from __future__ import annotations

MAX_MESSAGE_BYTES = 7439

# Headroom for the fence a piece may have to close and reopen.
_FENCE_RESERVE = 16

_TRUNCATED = "\n\n_…(cut to fit one Webex message)_"


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def _fit(text: str, budget: int) -> int:
    """The longest prefix of `text`, in characters, that fits in `budget` bytes."""
    if _size(text) <= budget:
        return len(text)
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if _size(text[:mid]) <= budget:
            low = mid
        else:
            high = mid - 1
    return low


def _cut_point(text: str, limit: int) -> int:
    """Where to end a piece of at most `limit` characters of `text`."""
    window = text[:limit]
    for separator in ("\n\n", "\n", " "):
        at = window.rfind(separator)
        # A cut in the first quarter wastes most of the message; take a hard
        # cut instead.
        if at > limit // 4:
            return at + len(separator)
    return limit


def _open_fence(text: str) -> str | None:
    """The fence line of a code block left open at the end of `text`."""
    fence: str | None = None
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```"):
            fence = None if fence is not None else stripped
    return fence


def chunk_markdown(text: str, limit: int = MAX_MESSAGE_BYTES) -> list[str]:
    """`text` as one or more pieces, each within `limit` bytes."""
    if _size(text) <= limit:
        return [text]
    pieces: list[str] = []
    rest = text
    reopen = ""
    while rest:
        rest = reopen + rest
        if _size(rest) <= limit:
            pieces.append(rest)
            break
        cut = _cut_point(rest, _fit(rest, limit - _FENCE_RESERVE))
        piece, rest = rest[:cut].rstrip("\n"), rest[cut:].lstrip("\n")
        fence = _open_fence(piece)
        if fence is not None:
            piece += "\n```"
            reopen = fence + "\n"
        else:
            reopen = ""
        pieces.append(piece)
    return pieces


def clamp_markdown(text: str, limit: int = MAX_MESSAGE_BYTES) -> str:
    """`text` cut to one message, saying so, for a message that is edited in
    place and so cannot be split."""
    if _size(text) <= limit:
        return text
    kept = text[: _fit(text, limit - _size(_TRUNCATED) - _FENCE_RESERVE)]
    if _open_fence(kept) is not None:
        kept += "\n```"
    return kept + _TRUNCATED
