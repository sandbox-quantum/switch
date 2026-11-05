"""Switch Markdown to IRC's formatting codes and back, and lines cut to fit.

IRC formats with control characters that toggle a style on and off:
`\\x02` bold, `\\x1d` italic, `\\x1e` strikethrough, `\\x11` monospace,
`\\x1f` underline, and `\\x03` colours. A style runs to the end of the line,
so a long line cut in two closes what is open at the cut and opens it again
on the next one; otherwise a reader sees half a sentence in bold.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

BOLD = "\x02"
ITALIC = "\x1d"
STRIKE = "\x1e"
MONO = "\x11"
UNDERLINE = "\x1f"
COLOUR = "\x03"
HEX_COLOUR = "\x04"
REVERSE = "\x16"
RESET = "\x0f"

_STYLES = (BOLD, ITALIC, STRIKE, MONO, UNDERLINE)

# Control characters an agent's text must not carry onto the wire: they would
# restyle or garble the line, or (CR, LF, NUL) end it early.
_CONTROL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")

_FENCE = re.compile(r"^\s*(```|~~~)")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_CODE_SPAN = re.compile(r"(`+)(.+?)\1")
_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_AUTOLINK = re.compile(r"<((?:https?|mailto|switchdash):[^>\s]+)>")
_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_ITALIC_STAR = re.compile(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])")
_ITALIC_UNDER = re.compile(r"(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])")
_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")
_ESCAPED = re.compile(r"\\([\\`*_{}\[\]()#+\-.!~|>])")

_IRC_COLOUR = re.compile(
    r"\x03(\d{1,2}(,\d{1,2})?)?|\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?"
)


@dataclass(frozen=True)
class RenderedLine:
    """One line of a message, in IRC formatting.

    `code` lines came from a fenced block: they keep their indentation and
    are cut only where a line alone is too long, never re-flowed as prose.
    """

    text: str
    code: bool = False


def _clean(text: str) -> str:
    return _CONTROL.sub("", text.replace("\t", "    "))


def _inline(text: str) -> str:
    """One line of prose: Markdown spans to IRC codes, code spans untouched."""
    out: list[str] = []
    position = 0
    for match in _CODE_SPAN.finditer(text):
        out.append(_spans(text[position : match.start()]))
        out.append(f"{MONO}{match.group(2).strip()}{MONO}")
        position = match.end()
    out.append(_spans(text[position:]))
    return "".join(out)


def _link(label: str, url: str) -> str:
    return url if label.strip() in ("", url) else f"{label} ({url})"


def _spans(text: str) -> str:
    text = _IMAGE.sub(lambda m: _link(m.group(1), m.group(2)), text)
    text = _LINK.sub(lambda m: _link(m.group(1), m.group(2)), text)
    text = _AUTOLINK.sub(r"\1", text)
    text = _BOLD.sub(lambda m: f"{BOLD}{m.group(2)}{BOLD}", text)
    text = _STRIKE.sub(lambda m: f"{STRIKE}{m.group(1)}{STRIKE}", text)
    text = _ITALIC_STAR.sub(lambda m: f"{ITALIC}{m.group(1)}{ITALIC}", text)
    text = _ITALIC_UNDER.sub(lambda m: f"{ITALIC}{m.group(1)}{ITALIC}", text)
    return _ESCAPED.sub(r"\1", text)


def to_irc(markdown: str) -> list[RenderedLine]:
    """Switch Markdown as IRC lines, before any cutting to length.

    Blank lines are dropped (IRC cannot send an empty message, and a lone
    space reads as noise); a heading becomes a bold line; a fenced block loses
    its fences and keeps its lines as they are.
    """
    lines: list[RenderedLine] = []
    in_code = False
    for raw in markdown.replace("\r\n", "\n").split("\n"):
        if _FENCE.match(raw):
            in_code = not in_code
            continue
        if in_code:
            text = _clean(raw).rstrip()
            if text:
                lines.append(RenderedLine(text, code=True))
            continue
        text = _clean(raw).rstrip()
        if not text.strip():
            continue
        heading = _HEADING.match(text)
        if heading:
            lines.append(RenderedLine(f"{BOLD}{_spans(heading.group(1))}{BOLD}"))
            continue
        lines.append(RenderedLine(_inline(text)))
    return lines


def from_irc(text: str) -> str:
    """A line from IRC as Switch Markdown: bold, italic, strikethrough and
    monospace kept, colours and the rest dropped."""
    text = _IRC_COLOUR.sub("", text)
    out: list[str] = []
    open_styles: list[str] = []
    marks = {BOLD: "**", ITALIC: "*", STRIKE: "~~", MONO: "`"}
    for char in text:
        if char in marks:
            if char in open_styles:
                open_styles.remove(char)
            else:
                open_styles.append(char)
            out.append(marks[char])
        elif char == RESET:
            out.extend(marks[style] for style in reversed(open_styles))
            open_styles.clear()
        elif char in (UNDERLINE, REVERSE) or ord(char) < 32 and char != "\t":
            continue
        else:
            out.append(char)
    out.extend(marks[style] for style in reversed(open_styles))
    return "".join(out).strip()


def _open_after(text: str) -> list[str]:
    """The styles still on at the end of `text`, in the order they opened."""
    open_styles: list[str] = []
    for char in text:
        if char in _STYLES:
            if char in open_styles:
                open_styles.remove(char)
            else:
                open_styles.append(char)
        elif char == RESET:
            open_styles.clear()
    return open_styles


def _fit(text: str, budget: int) -> int:
    """How many characters of `text` fit in `budget` bytes of UTF-8, never
    cutting a character in half."""
    used = 0
    for index, char in enumerate(text):
        used += len(char.encode())
        if used > budget:
            return index
    return len(text)


def wrap(lines: list[RenderedLine], budget: int) -> list[str]:
    """Every line within `budget` bytes, styles carried across each cut.

    Prose is cut at the last space that fits; a word longer than a whole line
    is cut where it must. A code line is cut only when it alone is too long,
    and its indentation is kept.
    """
    if budget < 16:
        raise ValueError("A line budget under 16 bytes cannot carry a message")
    out: list[str] = []
    for line in lines:
        rest = line.text
        carried = ""
        while rest:
            text = carried + rest
            if len(text.encode()) <= budget:
                out.append(text)
                break
            # Room for the codes that close what is open at the cut.
            room = budget - len(_STYLES)
            cut = _fit(text, room)
            if not line.code:
                space = text.rfind(" ", len(carried) + 1, cut + 1)
                if space > len(carried):
                    cut = space
            if cut <= len(carried):
                cut = len(carried) + max(1, _fit(rest, room - len(carried.encode())))
            head = text[:cut]
            open_styles = _open_after(head)
            out.append(head + "".join(reversed(open_styles)))
            carried = "".join(open_styles)
            rest = text[cut:] if line.code else text[cut:].lstrip(" ")
    return out
