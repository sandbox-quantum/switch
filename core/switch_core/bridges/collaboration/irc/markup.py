"""Switch Markdown to IRC text and back, and text cut into IRC lines.

IRC has no markup of its own, only control codes most clients draw: bold,
italics and strike-through. Outbound, the Markdown marks that have one become
it, a link keeps its address in the text (clients linkify bare URLs), and a
fenced code block loses its fences and keeps its lines exactly. Inbound, every
control code is dropped: Switch has nothing to show colours with.
"""

from __future__ import annotations

import re

from switch_core.bridges.collaboration.session.renderers import Markup

BOLD = "\x02"
ITALIC = "\x1d"
STRIKE = "\x1e"

# Colours carry their numbers with them (`\x03` 4,12 or `\x04` as hex), and
# the rest are single codes: bold, reset, monospace, reverse, italics,
# strike-through and underline.
_FORMATTING = re.compile(
    r"\x03(?:\d{1,2}(?:,\d{1,2})?)?"
    r"|\x04(?:[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?)?"
    r"|[\x02\x0f\x11\x16\x1d\x1e\x1f]"
)

# Never sent: NUL and CR end a line early on some servers, and a CTCP
# delimiter at the start of a message makes it a client command.
_UNSENDABLE = re.compile(r"[\x00\x01\r]")

_FENCE = re.compile(r"^\s*```")
_CODE_BLOCK = re.compile(r"^[ \t]*```.*?^[ \t]*```[ \t]*$", re.DOTALL | re.MULTILINE)
_INLINE_CODE = re.compile(r"`[^`\n]+`")
_HEADING = re.compile(r"^ {0,3}#{1,6}[ \t]+(.*)$", re.MULTILINE)
# `[` is left out of the label and `(` out of the target, so a run of
# unmatched brackets cannot make the engine retry the whole tail from every
# position (the same reasoning as Telegram's pattern).
_LINK = re.compile(r"\[([^\[\]\n]*)\]\(([^()\s]*)\)")
# A `*` beside a `/`, or one that opens onto a space or a dot, is part of a
# glob or a path (`src/**/*.py`, `*.md`), not emphasis: an emphasised run
# starts with a word character, a quote or a bracket.
_BOLD = re.compile(
    r"(?<![*/])\*\*(?=[\w\"'(\[])([^\n]*?[^\s*/])\*\*(?![*/])|__([^\n]+?)__"
)
_STRIKE = re.compile(r"~~([^\n]+?)~~")
_ITALIC = re.compile(
    r"(?<![*\w/.])\*(?=[\w\"'(\[])([^*\n]*?[\w\"')\].!?])\*(?![*\w/])"
    r"|(?<![\w_])_([^_\n]+?)_(?![\w_])"
)


class _IrcMarkup(Markup):
    """The neutral renderer's emphasis as IRC's bold code. Its code spans stay
    in backticks, which read as code to anyone on IRC and keep a handle
    exactly as it has to be typed back."""

    def bold(self, text: str) -> str:
        return f"{BOLD}{text}{BOLD}"


IRC_MARKUP = _IrcMarkup()


def from_irc(text: str) -> str:
    return _FORMATTING.sub("", text)


def to_irc(markdown: str) -> str:
    """Render prose marks as IRC codes. Code, in blocks or inline, is left as
    written; `lines` takes the fences off a block."""
    out: list[str] = []
    position = 0
    for block in _CODE_BLOCK.finditer(markdown):
        out.append(_prose(markdown[position : block.start()]))
        out.append(block.group(0))
        position = block.end()
    out.append(_prose(markdown[position:]))
    return "".join(out)


def _prose(text: str) -> str:
    kept: list[str] = []

    def keep(match: re.Match[str]) -> str:
        kept.append(match.group(0))
        return f"\x00{len(kept) - 1}\x00"

    text = _INLINE_CODE.sub(keep, text)
    text = _HEADING.sub(lambda m: f"{BOLD}{m.group(1)}{BOLD}", text)
    text = _BOLD.sub(lambda m: f"{BOLD}{m.group(1) or m.group(2)}{BOLD}", text)
    text = _STRIKE.sub(lambda m: f"{STRIKE}{m.group(1)}{STRIKE}", text)
    text = _ITALIC.sub(lambda m: f"{ITALIC}{m.group(1) or m.group(2)}{ITALIC}", text)
    text = _LINK.sub(_link, text)
    for index, original in enumerate(kept):
        text = text.replace(f"\x00{index}\x00", original)
    return text


def _link(match: re.Match[str]) -> str:
    label, target = match.group(1).strip(), match.group(2)
    if not label or label == target:
        return target
    return f"{label} ({target})"


def lines(text: str, *, prefix: str, budget: int) -> list[str]:
    """`text` as the lines of IRC messages, each `prefix` and at most `budget`
    bytes of UTF-8 in all.

    A line of prose too long for one message is wrapped at a space. A line of
    a fenced code block is never re-flowed: it keeps its indentation and is
    cut only where it alone is longer than a message. Fences and blank lines
    are dropped, since IRC cannot send an empty message.
    """
    room = budget - len(prefix.encode())
    if room <= 0:
        raise ValueError("an IRC line prefix longer than the line itself")
    out: list[str] = []
    in_code = False
    for line in _UNSENDABLE.sub("", text).split("\n"):
        if _FENCE.match(line):
            in_code = not in_code
            continue
        if not line.strip():
            continue
        pieces = _cut(line, room) if in_code else _wrap(line.strip(), room)
        out.extend(prefix + piece for piece in pieces)
    return out


def _fit(text: str, room: int) -> str:
    """The longest start of `text` within `room` bytes, ending on a whole
    character, and never nothing."""
    return text.encode()[:room].decode(errors="ignore") or text[0]


def _cut(text: str, room: int) -> list[str]:
    pieces: list[str] = []
    while len(text.encode()) > room:
        head = _fit(text, room)
        pieces.append(head)
        text = text[len(head) :]
    return [*pieces, text] if text else pieces


def _wrap(text: str, room: int) -> list[str]:
    pieces: list[str] = []
    while len(text.encode()) > room:
        head = _fit(text, room)
        space = head.rfind(" ")
        if space > 0:
            head = head[:space]
        pieces.append(head.rstrip())
        text = text[len(head) :].lstrip()
    return [*pieces, text] if text else pieces
