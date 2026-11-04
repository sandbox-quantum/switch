"""Splitting a long message into parts a receiving app can show whole."""

from __future__ import annotations

import re

FENCE = "```"
_REOPEN = FENCE + "\n"
_CLOSE = "\n" + FENCE
_SENTENCE_END = re.compile(r"[.!?][)\"']?\s")


def split_text(text: str, limit: int) -> list[str]:
    if limit <= 0 or len(text) <= limit:
        return [text]
    parts: list[str] = []
    rest = text
    reopen = False
    while True:
        prefix = _REOPEN if reopen else ""
        if len(prefix) + len(rest) <= limit:
            parts.append(prefix + rest)
            return parts
        budget = limit - len(prefix) - len(_CLOSE)
        cut = _cut_point(rest, budget)
        piece, rest = rest[:cut].rstrip(), rest[cut:].lstrip("\n")
        reopen = _ends_inside_fence(piece, reopen)
        parts.append(prefix + piece + (_CLOSE if reopen else ""))


def _cut_point(text: str, budget: int) -> int:
    window = text[:budget]
    floor = budget // 2
    for marker in ("\n\n", "\n"):
        at = window.rfind(marker)
        if at >= floor:
            return at + len(marker)
    ends = [m.end() for m in _SENTENCE_END.finditer(window)]
    if ends and ends[-1] >= floor:
        return ends[-1]
    at = window.rfind(" ")
    if at >= floor:
        return at + 1
    return budget


def _ends_inside_fence(piece: str, already_open: bool) -> bool:
    fences = sum(1 for line in piece.splitlines() if line.lstrip().startswith(FENCE))
    return already_open ^ (fences % 2 == 1)
