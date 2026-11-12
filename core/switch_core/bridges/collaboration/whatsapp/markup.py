"""WhatsApp's text formatting, both ways, and the cap on one message's text.

WhatsApp formats with single marks: `*bold*`, `_italic_`, `~strike~`, plus
backtick code, `> ` quotes and `- ` lists. It has no headings, tables or
labelled links; the client links a bare URL by itself. So Switch Markdown is
rewritten into those marks, and what WhatsApp has no form for is spelled out
in text rather than dropped: a heading becomes a bold line, a link its label
followed by its address.
"""

from __future__ import annotations

import re

# The Cloud API's limit on a text message body.
MAX_TEXT = 4096

_STASHED = re.compile(r"\x00(\d+)\x00")
_FENCED = re.compile(r"```[^\n`]*\n(.*?)```", re.DOTALL)
_INLINE_CODE = re.compile(r"(`+)(.+?)\1")
_ANY_CODE = re.compile(r"```.*?```|`[^`\n]+`", re.DOTALL)
_LINK = re.compile(r"!?\[([^\]\n]*)\]\(([^)\s]+)\)")
_BARE_URL = re.compile(r"https?://[^\s<>()]+")
_HEADING = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
_BULLET = re.compile(r"^([ \t]*)[*+][ \t]+", re.MULTILINE)
_BOLD_ITALIC = re.compile(r"\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*")
_BOLD = re.compile(r"\*\*(?!\s)(.+?)(?<!\s)\*\*|__(?!\s)(.+?)(?<!\s)__")
_ITALIC_STAR = re.compile(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])")
_ITALIC_UNDERSCORE = re.compile(r"(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])")
_STRIKE = re.compile(r"~~(?!\s)(.+?)(?<!\s)~~")

_WA_BOLD = re.compile(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])")
_WA_STRIKE = re.compile(r"(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])")

# Stand-ins for the marks this module writes, so a later pass cannot read a
# bold it produced as an italic. Taken out of the text first, so none of the
# three can come from it.
_BOLD_MARK = "\x01"
_ITALIC_MARK = "\x02"
_RESERVED = str.maketrans("", "", "\x00\x01\x02")

_FENCE = "```"
_REOPEN = f"{_FENCE}\n"
_CLOSE = f"\n{_FENCE}"
_SEPARATORS = ("\n\n", "\n", " ")


class _Stash:
    """Spans set aside so no later pass can rewrite them, then put back."""

    def __init__(self) -> None:
        self._spans: list[str] = []

    def keep(self, span: str) -> str:
        self._spans.append(span)
        return f"\x00{len(self._spans) - 1}\x00"

    def restore(self, text: str) -> str:
        return _STASHED.sub(lambda match: self._spans[int(match.group(1))], text)


def _bold_heading(match: re.Match[str]) -> str:
    return f"{_BOLD_MARK}{match.group(1).replace(_BOLD_MARK, '')}{_BOLD_MARK}"


def to_whatsapp(markdown: str) -> str:
    """Switch Markdown in WhatsApp's own marks."""
    stash = _Stash()
    text = _FENCED.sub(
        lambda m: stash.keep(f"{_FENCE}\n{m.group(1).rstrip(chr(10))}\n{_FENCE}"),
        markdown.translate(_RESERVED),
    )
    text = _INLINE_CODE.sub(lambda m: stash.keep(m.group(0)), text)
    text = _LINK.sub(lambda m: _link(m.group(1), m.group(2), stash), text)
    text = _BARE_URL.sub(lambda m: stash.keep(m.group(0)), text)
    text = _BULLET.sub(r"\1- ", text)
    text = _BOLD_ITALIC.sub(
        rf"{_BOLD_MARK}{_ITALIC_MARK}\1{_ITALIC_MARK}{_BOLD_MARK}", text
    )
    text = _BOLD.sub(
        lambda m: f"{_BOLD_MARK}{m.group(1) or m.group(2)}{_BOLD_MARK}", text
    )
    text = _ITALIC_STAR.sub(rf"{_ITALIC_MARK}\1{_ITALIC_MARK}", text)
    text = _ITALIC_UNDERSCORE.sub(rf"{_ITALIC_MARK}\1{_ITALIC_MARK}", text)
    text = _HEADING.sub(_bold_heading, text)
    text = _STRIKE.sub(r"~\1~", text)
    text = text.replace(_BOLD_MARK, "*").replace(_ITALIC_MARK, "_")
    return stash.restore(text)


def _link(label: str, address: str, stash: _Stash) -> str:
    kept = stash.keep(address)
    label = label.strip()
    return kept if not label or label == address else f"{label} ({kept})"


def to_switch_markdown(text: str) -> str:
    """WhatsApp's marks in Switch Markdown. Italic and code are already the same."""
    stash = _Stash()
    text = _ANY_CODE.sub(lambda m: stash.keep(m.group(0)), text.translate(_RESERVED))
    text = _BARE_URL.sub(lambda m: stash.keep(m.group(0)), text)
    text = _WA_BOLD.sub(r"**\1**", text)
    text = _WA_STRIKE.sub(r"~~\1~~", text)
    return stash.restore(text)


def chunk_text(text: str, limit: int) -> list[str]:
    """Split `text` into messages of at most `limit` characters.

    Paragraphs are kept whole where they fit, then lines, then words; only a
    single word longer than a message is cut. A code block split across two
    messages is closed at the end of the first and reopened in the second, so
    neither shows the other's code as prose.
    """
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    budget = limit - len(_REOPEN) - len(_CLOSE) if _FENCE in text else limit
    chunks = [chunk.strip("\n").rstrip() for chunk in _split(text, budget, 0)]
    balanced: list[str] = []
    open_fence = False
    for chunk in filter(None, chunks):
        if open_fence:
            chunk = _REOPEN + chunk
        open_fence = chunk.count(_FENCE) % 2 == 1
        balanced.append(chunk + _CLOSE if open_fence else chunk)
    return balanced


def _split(text: str, limit: int, level: int) -> list[str]:
    if len(text) <= limit:
        return [text]
    if level == len(_SEPARATORS):
        return [text[start : start + limit] for start in range(0, len(text), limit)]
    separator = _SEPARATORS[level]
    chunks: list[str] = []
    current = ""
    for part in text.split(separator):
        candidate = f"{current}{separator}{part}" if current else part
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            chunks.append(current)
        pieces = _split(part, limit, level + 1)
        chunks.extend(pieces[:-1])
        current = pieces[-1]
    if current:
        chunks.append(current)
    return chunks
