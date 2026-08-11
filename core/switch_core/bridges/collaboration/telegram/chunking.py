"""Split outbound text to fit Telegram's per-message character limit, without
breaking the markup it carries.

Telegram caps a message at 4,096 characters and rejects anything longer
outright — well under what an agent writes when it answers a real question, and
tighter than Slack or Mattermost. Splitting on line boundaries alone is not
enough here: the body has already been rendered to Telegram's HTML subset, and a
cut through an open tag makes Telegram refuse *both* halves, so a long code
block arrives as unformatted text. Tags open at a cut are therefore closed at
the end of one piece and reopened at the start of the next.
"""

from __future__ import annotations

import re

MAX_MESSAGE = 4096

_TAG_RE = re.compile(r"<(/?)([a-z]+)[^>]*>")


def open_tags(text: str) -> list[tuple[str, str]]:
    """The tags still open at the end of `text`, outermost first.

    Returned as `(name, opening tag)` so each can be both closed here and
    reopened verbatim — an `<a href="…">` has to carry its target across."""
    stack: list[tuple[str, str]] = []
    for match in _TAG_RE.finditer(text):
        closing, name = match.group(1), match.group(2)
        if not closing:
            stack.append((name, match.group(0)))
            continue
        for index in range(len(stack) - 1, -1, -1):
            if stack[index][0] == name:
                del stack[index]
                break
    return stack


def safe_split(text: str, limit: int) -> int:
    """The best place to cut `text` at or before `limit`.

    Never inside a tag — half an `<a href="…">` is unparseable — and on a
    line break when there is one late enough to be worth using."""
    cut = min(limit, len(text))
    last_open = text.rfind("<", 0, cut)
    if last_open > text.rfind(">", 0, cut):
        cut = last_open
    newline = text.rfind("\n", 0, cut)
    if newline > cut // 2:
        cut = newline
    return max(cut, 1)


def chunk_message(body: str) -> list[str]:
    """Break a body into Telegram-sized pieces, keeping the markup valid.

    Agent output routinely runs past the 4096-character cap, and Telegram
    rejects an oversize message outright rather than truncating it. A naive
    split lands inside the formatting — a long code block is the usual
    casualty — and Telegram then refuses each half, so the whole thing
    arrives unformatted. Tags left open at a cut are therefore closed at the
    end of one piece and reopened at the start of the next.
    """
    if len(body) <= MAX_MESSAGE:
        return [body]

    chunks: list[str] = []
    rest = body
    reopen = ""
    while True:
        candidate = reopen + rest
        if len(candidate) <= MAX_MESSAGE:
            chunks.append(candidate)
            return chunks

        cut = safe_split(candidate, MAX_MESSAGE)
        closers = closing_tags(candidate[:cut])
        if cut + len(closers) > MAX_MESSAGE:
            # Closing the open tags would overflow; cut earlier to fit them.
            cut = safe_split(candidate, MAX_MESSAGE - len(closers))
            closers = closing_tags(candidate[:cut])
        if cut <= len(reopen):
            # No progress possible on a tag boundary — cut hard instead, so
            # a pathological body cannot loop forever.
            cut = min(MAX_MESSAGE, len(candidate))
            closers = ""

        head = candidate[:cut]
        chunks.append(head.rstrip("\n") + closers)
        reopen = "".join(tag for _, tag in open_tags(head)) if closers else ""
        rest = candidate[cut:].lstrip("\n")
        if not rest:
            return chunks


def closing_tags(text: str) -> str:
    return "".join(f"</{name}>" for name, _ in reversed(open_tags(text)))
