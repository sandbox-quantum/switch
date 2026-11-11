"""Signal outbound text: Switch Markdown to Signal's `text` + `textStyle`.

Signal has no markup in a message; emphasis is a list of style ranges over
the plain text. A range is `start:length:STYLE` in UTF-16 code units, so an
emoji before a styled run shifts the offsets by two, not one.

Because `translate_outbound` (defusing mass mentions, rewriting console
links) runs *after* the render and can insert characters, the ranges are
computed on the final string, in `send_message` / `update_message` — never
here. This module's two halves are pure and independently testable.
"""

from __future__ import annotations

import re

#: The marker this render emits, outermost-first so `**` is never two `*`.
_STYLE_MARKERS = ("**", "~~", "*", "`")

#: Marker → the Signal style name the daemon accepts (probed on 0.14.9:
#: BOLD, ITALIC, STRIKETHROUGH, MONOSPACE; the short forms STRIKE/MONO are
#: rejected).
_STYLE_OF_MARKER = {
    "**": "BOLD",
    "*": "ITALIC",
    "~~": "STRIKETHROUGH",
    "`": "MONOSPACE",
}

_MD_LINK = re.compile(r"\[([^\]]+)\]\((\S+[^)]*)\)")
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)

#: The largest single Signal message the phone shows in full before it folds
#: to "Read more". Measured on the phone (2026-11-06): 450 chars show whole,
#: 550 folds; 20k/60k messages fold too but keep their full text under the
#: fold (a display collapse, not truncation). A 475/500/525 batch is pinned
#: separately: if 525 shows whole, raise this one line. It is the *body*
#: budget; the agent-name prefix on the first chunk rides inside it.
CHUNK_MAX = 450


def render_markdown(markdown: str) -> str:
    """Switch Markdown to Signal text carrying this module's markers.

    Emphasis survives as markers (`**`, `*`, `~~`, `` ` ``); everything a
    phone cannot show as markup is reduced to plain text, and a fenced block
    becomes a MONOSPACE run. The markers are stripped into `textStyle`
    ranges later, on the final string, by `strip_markers`.
    """
    text = markdown
    # A link the phone will not open natively: keep both halves readable.
    text = _MD_LINK.sub(
        lambda m: (
            m.group(1) if m.group(1) == m.group(2) else f"{m.group(1)} ({m.group(2)})"
        ),
        text,
    )
    text = _MD_HEADING.sub("", text)
    lines = text.split("\n")
    in_fence = False
    out: list[str] = []
    for line in lines:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        out.append(f"`{line}`" if in_fence else line)
    return "\n".join(out)


def strip_markers(rendered: str) -> tuple[str, list[str]]:
    """The plain text and its `textStyle` ranges, from a marker-carrying string.

    Ranges are `start:length:STYLE` in UTF-16 code units of the returned
    text, so every character that will be in `message` — the zero-width
    space a defused mention carries, the emoji that are two units each —
    is counted. Markers themselves are not: a range covers what was styled,
    and the mark is the only thing removed.

    Nesting is LIFO, as Markdown's is: the inner style closes before the
    outer one does. A marker with no matching close leaves no range; the
    text keeps what was styled, unstyled.
    """
    plain: list[str] = []
    ranges: list[str] = []
    utf16_pos = 0
    stack: list[tuple[str, int]] = []
    i = 0
    while i < len(rendered):
        marker = next((m for m in _STYLE_MARKERS if rendered.startswith(m, i)), None)
        if marker is None:
            char = rendered[i]
            plain.append(char)
            utf16_pos += len(char.encode("utf-16-le")) // 2
            i += 1
            continue
        style = _STYLE_OF_MARKER[marker]
        top = stack[-1] if stack else None
        if top is not None and top[0] == style:
            start = top[1]
            ranges.append(f"{start}:{utf16_pos - start}:{style}")
            stack.pop()
        else:
            stack.append((style, utf16_pos))
        i += len(marker)
    return "".join(plain), ranges


def _safe_cut(text: str, limit: int) -> int:
    """The best place to split `text` at or before `limit`.

    On a line break when one is late enough to be worth taking (a new chunk
    starting on its own line reads as a continuation, not a word half-eaten),
    and never between the two characters of a `**` or `~~` pair — a split
    there would strand a lone `*` that the next chunk misreads.
    """
    cut = min(limit, len(text))
    newline = text.rfind("\n", 0, cut)
    if newline > cut // 2:
        cut = newline
    if 0 < cut < len(text) and text[cut - 1] == text[cut] and text[cut] in "*~":
        cut -= 1
    return max(cut, 1)


def chunk_markers(rendered: str, limit: int = CHUNK_MAX) -> list[str]:
    """A marker-carrying string into pieces each short enough to show in full.

    Pieces are split on line boundaries at `limit`, no line break late
    enough means the earliest safe cut. No piece is numbered and none is
    annotated: on the phone they read as a reply that continues, and a piece
    that fits never triggers Signal's own fold. A style that opens in one
    piece and would close in the next does not carry across — the pieces are
    marker-carrying, and the caller runs `strip_markers` over each, so an
    emphasis cut by the boundary degrades to plain text rather than leaving a
    stray marker. The first piece keeps whatever sits at the head of `rendered`
    — on the adapter's path that is the agent-name prefix.
    """
    if len(rendered) <= limit:
        return [rendered]
    pieces: list[str] = []
    rest = rendered
    while rest:
        if len(rest) <= limit:
            pieces.append(rest)
            return pieces
        cut = _safe_cut(rest, limit)
        pieces.append(rest[:cut])
        rest = rest[cut:]
        if rest.startswith("\n"):
            # The break is the separator between two messages, not body text.
            rest = rest[1:]
    return pieces
