"""Split a long Markdown body into messages a receiver can take, cleanly.

A cut is made on a paragraph break where one is late enough to be worth using,
then on a line break, then on a space. A fenced code block open at a cut is
closed at the end of that piece and reopened, with its language, at the start
of the next, so each piece renders as code instead of leaving a stray fence.
"""

from __future__ import annotations

import re

_FENCE = re.compile(r"^ {0,3}(`{3,})(.*)$")

# A language tag longer than this is not one; reopening with it would only
# spend the budget of every following piece.
_MAX_INFO = 32


def _open_fence(text: str) -> tuple[str, str] | None:
    """The fence still open at the end of `text`, as (backticks, info string)."""
    state: tuple[str, str] | None = None
    for line in text.split("\n"):
        found = _FENCE.match(line)
        if found is None:
            continue
        ticks, info = found.group(1), found.group(2).strip()
        if state is None:
            state = (ticks, info)
        elif len(ticks) >= len(state[0]) and not info:
            state = None
    return state


def _cut(text: str, budget: int) -> int:
    window = text[:budget]
    for separator in ("\n\n", "\n", " "):
        at = window.rfind(separator)
        if at > budget // 2:
            return at
    return budget


def _plain(text: str, limit: int) -> list[str]:
    pieces: list[str] = []
    while len(text) > limit:
        cut = _cut(text, limit)
        pieces.append(text[:cut].rstrip("\n"))
        text = text[cut:].removeprefix(" ").lstrip("\n")
    if text:
        pieces.append(text)
    return pieces


def split_markdown(body: str, limit: int) -> list[str]:
    """`body` as pieces of at most `limit` characters, fences kept balanced.

    Where `limit` leaves no room for a fence's closer and reopener beside any
    text, the rest is split as plain text instead: whole and unformatted beats
    a split that never advances.
    """
    if limit < 1:
        raise ValueError("limit must be at least 1")
    if len(body) <= limit:
        return [body]
    pieces: list[str] = []
    reopen = ""
    rest = body
    while True:
        candidate = reopen + rest
        if len(candidate) <= limit:
            pieces.append(candidate)
            return pieces
        cut = _cut(candidate, max(limit - 4, 1))
        fence = _open_fence(candidate[:cut])
        if fence is not None and len(fence[0]) + 1 > 4:
            cut = _cut(candidate, max(limit - len(fence[0]) - 1, 1))
            fence = _open_fence(candidate[:cut])
        closer = 0 if fence is None else len(fence[0]) + 1
        if cut <= len(reopen) or cut + closer > limit:
            return pieces + _plain(rest, limit)
        head = candidate[:cut]
        # The separator the cut was made on belongs to neither piece.
        tail = candidate[cut:].removeprefix(" ")
        if fence is None:
            pieces.append(head.rstrip("\n"))
            reopen = ""
            rest = tail.lstrip("\n")
        else:
            ticks, info = fence
            pieces.append(f"{head.rstrip(chr(10))}\n{ticks}")
            reopen = f"{ticks}{info[:_MAX_INFO]}\n"
            rest = tail.removeprefix("\n")
        if not rest:
            return pieces
