"""Turning a Switch message body into safe IRC wire lines, and back.

Pure functions, tested without a socket. Two directions:

- Outbound: Switch Markdown -> a small set of mIRC control codes, then split
  into lines that fit the protocol's line limit with the sender's name at
  the start of each one.
- Inbound: a raw IRC line's text -> plain text, with every control character
  (CR, LF, and every mIRC formatting code) removed. CR/LF are stripped here
  for the same reason they are never written outbound unescaped: a value
  that reaches a raw command builder with a newline in it can forge a second
  command.
"""

from __future__ import annotations

import re

from switch_core.bridges.collaboration.irc.protocol import (
    MAX_LINE_BYTES,
)

# mIRC colour codes: \x03 optionally followed by "NN" or "NN,MM" (one or two
# digits each). \x04 hex colour: optionally "RRGGBB" or "RRGGBB,RRGGBB".
_COLOR_CODE = re.compile(r"\x03(\d{1,2}(,\d{1,2})?)?")
_HEX_COLOR_CODE = re.compile(r"\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?")
# Every other C0 control character, including bare bold/italic/underline/
# reverse/strike/monospace/reset codes and CR/LF themselves.
_OTHER_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

_BOLD = "\x02"
_RESET = "\x0f"

_MD_BOLD = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_MD_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_MD_HEADING = re.compile(r"^#{1,6}\s*", re.MULTILINE)


def strip_formatting(text: str) -> str:
    """Neutralise inbound IRC control codes, including CR/LF.

    Run on every inbound line before it becomes `InboundMessage.content`, so
    a user cannot forge bold/colour markup Switch did not write, and cannot
    smuggle a literal CR or LF into stored text.
    """
    text = _COLOR_CODE.sub("", text)
    text = _HEX_COLOR_CODE.sub("", text)
    return _OTHER_CONTROL.sub("", text)


def render_markup(content: str) -> str:
    """Switch Markdown -> plain text with mIRC bold, for the handful of
    constructs chat bodies actually use.

    IRC has no native link or heading syntax, so a link keeps its text and
    shows its URL after, in parentheses, and a heading keeps its words and
    drops the `#`s. Deliberately not a full Markdown renderer: IRC is plain
    text, and a bullet list or a code fence already reads fine as the
    characters typed.
    """
    content = _MD_HEADING.sub("", content)
    content = _MD_LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", content)
    content = _MD_BOLD.sub(
        lambda m: f"{_BOLD}{m.group(1) or m.group(2)}{_BOLD}", content
    )
    return content


def _byte_len(text: str) -> int:
    return len(text.encode("utf-8"))


def _split_by_bytes(word: str, max_bytes: int) -> list[str]:
    """Cut `word` into pieces of at most `max_bytes`, only between whole
    characters, so a multi-byte UTF-8 codepoint is never split in half."""
    if max_bytes <= 0:
        max_bytes = 1
    pieces: list[str] = []
    current = ""
    current_bytes = 0
    for ch in word:
        ch_bytes = _byte_len(ch)
        if current and current_bytes + ch_bytes > max_bytes:
            pieces.append(current)
            current = ""
            current_bytes = 0
        current += ch
        current_bytes += ch_bytes
    if current:
        pieces.append(current)
    return pieces


def _wrap_paragraph(paragraph: str, budget: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in paragraph.split(" "):
        candidate = f"{current} {word}" if current else word
        if _byte_len(candidate) <= budget:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if _byte_len(word) <= budget:
            current = word
        else:
            *whole, current = _split_by_bytes(word, budget)
            lines.extend(whole)
    if current:
        lines.append(current)
    return lines or [""]


def split_to_lines(
    text: str, *, prefix: str, max_bytes: int = MAX_LINE_BYTES
) -> list[str]:
    """Split `text` into complete wire lines, each already carrying `prefix`
    at the start and each at most `max_bytes` once the command framing and
    the server's own prefix (`RESERVED_FOR_SERVER_PREFIX`) are counted too.

    Splits on existing line breaks first — a paragraph stays one IRC line
    where it fits — then word-wraps anything longer, falling back to a hard
    byte-boundary cut for a single "word" that alone exceeds the budget.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    budget = max_bytes - _byte_len(prefix)
    lines: list[str] = []
    for paragraph in normalized.split("\n"):
        if not paragraph:
            continue
        lines.extend(_wrap_paragraph(paragraph, budget))
    if not lines:
        lines = [""]
    return [f"{prefix}{line}" for line in lines]
