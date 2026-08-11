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

import logging
import re

logger = logging.getLogger(__name__)

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
        # A cut this early means the markup itself is the problem — a single
        # tag longer than a whole message, or more nesting than one can carry.
        # Either way no split preserves it, and forcing one yields a piece with
        # a byte or two of text in it.
        if cut <= len(reopen) or cut < MAX_MESSAGE // 4:
            # Cutting hard here would sever a tag mid-character and put a bare
            # `<` on the wire, which Telegram rejects — and the plain-text retry
            # cannot recognise the fragment as a tag either, so the text is
            # mangled too. Drop the markup for the remainder instead:
            # unformatted and whole beats formatted and broken.
            logger.warning(
                "A Telegram message's markup cannot be split to fit (%d chars "
                "of open tags, best cut at %d); sending the rest unformatted",
                len(reopen),
                cut,
            )
            return chunks + _plain_chunks(strip_tags(rest))

        head = candidate[:cut]
        chunks.append(head.removesuffix("\n") + closers)
        reopen = "".join(tag for _, tag in open_tags(head)) if closers else ""
        # Only the single newline the cut was made on is consumed — it is the
        # separator between the two messages. Stripping the whole run would
        # swallow blank lines that are part of the body.
        rest = candidate[cut:].removeprefix("\n")
        if not rest:
            return chunks


_ANCHOR_RE = re.compile(r'<a href="([^"]*)">(.*?)</a>', re.DOTALL)


def strip_tags(text: str) -> str:
    """The text with the markup removed, for a body whose markup cannot be kept.

    A link becomes `label (target)` rather than just `label`: the target is the
    part a reader cannot recover, and dropping it silently would lose the very
    thing that made the message too long to format. Entities stay escaped —
    these pieces are still sent with HTML parse mode, they simply have no tags.
    """
    return _TAG_RE.sub("", _ANCHOR_RE.sub(r"\2 (\1)", text))


def _plain_chunks(text: str) -> list[str]:
    """Split unmarked text on the cleanest line break under the cap."""
    chunks: list[str] = []
    rest = text
    while len(rest) > MAX_MESSAGE:
        cut = safe_split(rest, MAX_MESSAGE)
        chunks.append(rest[:cut].removesuffix("\n"))
        rest = rest[cut:].removeprefix("\n")
    if rest:
        chunks.append(rest)
    return chunks


def closing_tags(text: str) -> str:
    return "".join(f"</{name}>" for name, _ in reversed(open_tags(text)))
