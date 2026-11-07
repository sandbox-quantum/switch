"""Split an outbound body to fit Zulip's per-message limit.

Zulip refuses a message longer than 10,000 characters outright, and an agent
answering a real question routinely writes more than that. Line boundaries get
most of the way there, but a cut that lands inside a fenced code block makes the
second half render as prose — the fence was opened in the first message and
never closed — so the fence is closed at the end of one piece and reopened at
the start of the next, exactly as Telegram's splitter does for its HTML subset.
"""

from __future__ import annotations

import re

MAX_MESSAGE = 10_000

_FENCE = re.compile(r"^\s*```(?P<info>[^\n]*)$")


def fence_opener(text: str) -> str:
    """The fence still open at the end of `text`, as its opening line.

    Returns `""` when every fence is closed. The language is kept: reopening a
    `python` block as a bare fence renders it as plain code.
    """
    opener = ""
    for line in text.splitlines():
        match = _FENCE.match(line)
        if not match:
            continue
        opener = "" if opener else line.strip()
    return opener


def safe_split(text: str, limit: int) -> int:
    """The best place to cut `text` at or before `limit`.

    A line break, when there is one late enough to be worth the shorter piece;
    a word boundary after that; the limit itself only for a run with no
    whitespace in it at all.
    """
    cut = min(limit, len(text))
    newline = text.rfind("\n", 0, cut)
    if newline > cut // 2:
        return max(newline, 1)
    space = text.rfind(" ", 0, cut)
    if space > cut // 2:
        return max(space, 1)
    return max(cut, 1)


def chunk_message(body: str, limit: int = MAX_MESSAGE) -> list[str]:
    """Break `body` into pieces Zulip will accept, keeping code blocks intact."""
    if len(body) <= limit:
        return [body]

    chunks: list[str] = []
    rest = body
    reopen = ""
    while rest:
        candidate = f"{reopen}\n{rest}" if reopen else rest
        if len(candidate) <= limit:
            chunks.append(candidate)
            return chunks

        cut = safe_split(candidate, limit)
        head = candidate[:cut]
        opener = fence_opener(head)
        closer = "\n```" if opener else ""
        if len(head) + len(closer) > limit:
            # Closing the fence would overflow; cut earlier so it fits.
            cut = safe_split(candidate, limit - len(closer))
            head = candidate[:cut]
            opener = fence_opener(head)
            closer = "\n```" if opener else ""

        chunks.append(head.rstrip("\n") + closer)
        rest = candidate[cut:].lstrip("\n")
        reopen = opener
    return chunks
