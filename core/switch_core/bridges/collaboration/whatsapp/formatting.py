"""Switch Markdown to WhatsApp's markup, and back.

WhatsApp has its own small markup, close to Markdown and different in the
places that matter: `*bold*` with one star, `_italic_`, `~strike~` with one
tilde, and code fenced with backticks as in Markdown. It has no links, headings
or tables; a bare http(s) URL is linked by the client, and nothing else is.

Code is set aside first in both directions, so nothing between backticks is
read as markup.
"""

from __future__ import annotations

import re
from collections.abc import Callable

_MD_CODE_BLOCK_RE = re.compile(r"```(?:[^\n`]*\n)?(.*?)```", re.DOTALL)
_WA_CODE_BLOCK_RE = re.compile(r"```(.*?)```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_HEADING_RE = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t#]*$", re.MULTILINE)
_STAR_BULLET_RE = re.compile(r"^([ \t]*)\*[ \t]+", re.MULTILINE)
_MD_BOLD_ITALIC_RE = re.compile(r"\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*")
_MD_AUTOLINK_RE = re.compile(r"<((?:https?|mailto):[^>\s]+)>")
_MD_BOLD_RE = re.compile(r"\*\*(?!\s)(.+?)(?<!\s)\*\*|__(?!\s)(.+?)(?<!\s)__")
_MD_ITALIC_STAR_RE = re.compile(r"(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])")
_MD_STRIKE_RE = re.compile(r"~~(?!\s)(.+?)(?<!\s)~~")
_MD_LINK_RE = re.compile(r"\[([^\]\n]*)\]\(([^)\s]+)\)")

_WA_BOLD_RE = re.compile(r"(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])")
_WA_STRIKE_RE = re.compile(r"(?<![\w~])~(?![\s~])([^~\n]+?)(?<!\s)~(?![\w~])")

# Stand-in for a star that is markup, so a later pass reading single stars as
# italics cannot take it for one.
_BOLD_MARK = "\x01"


def _stashing() -> tuple[list[str], Callable[[str], str]]:
    stash: list[str] = []

    def keep(rendered: str) -> str:
        stash.append(rendered)
        return f"\x00{len(stash) - 1}\x00"

    return stash, keep


def _restore(text: str, stash: list[str]) -> str:
    for index, rendered in enumerate(stash):
        text = text.replace(f"\x00{index}\x00", rendered)
    return text


def to_whatsapp(markdown: str) -> str:
    """Render Switch Markdown in WhatsApp's markup.

    A link becomes its label with the address after it in brackets, because
    WhatsApp shows the address or nothing: a label alone would hide where it
    goes, and a reader can still tap the bare URL.
    """
    if not markdown:
        return ""
    stash, keep = _stashing()
    text = _MD_CODE_BLOCK_RE.sub(
        lambda m: keep(f"```{m.group(1).strip(chr(10))}```"), markdown
    )
    text = _INLINE_CODE_RE.sub(lambda m: keep(f"`{m.group(1)}`"), text)

    def link(match: re.Match[str]) -> str:
        label, href = match.group(1).strip(), match.group(2)
        if not label or label == href:
            return keep(href)
        return f"{label} ({keep(href)})"

    text = _MD_LINK_RE.sub(link, text)
    text = _MD_AUTOLINK_RE.sub(lambda m: keep(m.group(1)), text)
    text = _HEADING_RE.sub(lambda m: f"{_BOLD_MARK}{m.group(1)}{_BOLD_MARK}", text)
    text = _STAR_BULLET_RE.sub(r"\1- ", text)
    text = _MD_BOLD_ITALIC_RE.sub(
        lambda m: f"{_BOLD_MARK}_{m.group(1)}_{_BOLD_MARK}", text
    )
    text = _MD_BOLD_RE.sub(
        lambda m: f"{_BOLD_MARK}{m.group(1) or m.group(2)}{_BOLD_MARK}", text
    )
    text = _MD_ITALIC_STAR_RE.sub(r"_\1_", text)
    text = _MD_STRIKE_RE.sub(r"~\1~", text)
    text = text.replace(_BOLD_MARK, "*")
    return _restore(text, stash)


def _markdown_code(code: str) -> str:
    """WhatsApp's monospace run as Markdown: a fenced block when it spans
    lines, where three backticks on one line would open a fence named after
    the first line, and an inline span otherwise."""
    code = code.strip("\n")
    if "\n" in code or "`" in code:
        return f"```\n{code}\n```"
    return f"`{code}`"


def to_markdown(whatsapp: str) -> str:
    """Read WhatsApp's markup as Switch Markdown.

    `_italic_` and code are already spelled the same way in both, so only bold
    and strikethrough change.
    """
    if not whatsapp:
        return ""
    stash, keep = _stashing()
    text = _WA_CODE_BLOCK_RE.sub(lambda m: keep(_markdown_code(m.group(1))), whatsapp)
    text = _INLINE_CODE_RE.sub(lambda m: keep(m.group(0)), text)
    text = _WA_BOLD_RE.sub(r"**\1**", text)
    text = _WA_STRIKE_RE.sub(r"~~\1~~", text)
    return _restore(text, stash)
