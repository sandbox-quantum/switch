"""Switch Markdown as plain text, in the cheapest characters that say the same.

SMS has no formatting, so the marks come off and a link keeps its address. Code
is set aside first, so nothing inside it is read as a mark.

Every text is also moved towards the GSM-7 alphabet as the last step before it
is sent, code included, because one curly quote costs a message more than twice
its price (see `segments`). Only punctuation that means the same is swapped, here
and not left to Twilio's `SmartEncoded` alone, so what is counted is what is
sent. Emoji and other scripts are left as they are.
"""

from __future__ import annotations

import re

_CODE_BLOCK = re.compile(r"```(?:[^\n`]*\n)?(.*?)```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_LINK = re.compile(r"\[([^\]\n]*)\]\(([^)\s]+)\)")
_AUTOLINK = re.compile(r"<((?:https?|mailto):[^>\s]+)>")
_BARE_URL = re.compile(r"\bhttps?://[^\s<>]+")
_HEADING = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t#]*$", re.MULTILINE)
_BULLET = re.compile(r"^([ \t]*)[*+][ \t]+", re.MULTILINE)
_BOLD_ITALIC = re.compile(r"\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*")
_BOLD = re.compile(r"\*\*(?!\s)(.+?)(?<!\s)\*\*|(?<!\w)__(?!\s)(.+?)(?<!\s)__(?!\w)")
_ITALIC_STAR = re.compile(r"(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])")
_ITALIC_UNDERSCORE = re.compile(r"(?<![\w_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\w_])")
_STRIKE = re.compile(r"~~(?!\s)(.+?)(?<!\s)~~")

# Core puts zero-width spaces in names and mass mentions, to defuse them on
# platforms that act on them. SMS acts on neither, and a single one would move
# the whole message out of GSM-7.
_INVISIBLE = re.compile("[​‌‍⁠﻿­]")
_PLAIN_PUNCTUATION = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "‚": "'",
        "‛": "'",
        "“": '"',
        "”": '"',
        "„": '"',
        "–": "-",
        "—": "-",
        "−": "-",
        "•": "-",
        " ": " ",
        " ": " ",
        " ": " ",
        "…": "...",
    }
)


def to_gsm_friendly(text: str) -> str:
    return _INVISIBLE.sub("", text).translate(_PLAIN_PUNCTUATION)


def to_sms(markdown: str) -> str:
    """Render Switch Markdown as the plain text of an SMS."""
    if not markdown:
        return ""
    stash: list[str] = []

    def keep(rendered: str) -> str:
        stash.append(rendered)
        return f"\x00{len(stash) - 1}\x00"

    def link(match: re.Match[str]) -> str:
        label, href = match.group(1).strip(), match.group(2)
        if not label or label == href:
            return keep(href)
        return f"{label} ({keep(href)})"

    text = _CODE_BLOCK.sub(lambda m: keep(m.group(1).strip("\n")), markdown)
    text = _INLINE_CODE.sub(lambda m: keep(m.group(1)), text)
    text = _LINK.sub(link, text)
    text = _AUTOLINK.sub(lambda m: keep(m.group(1)), text)
    text = _BARE_URL.sub(lambda m: keep(m.group(0)), text)
    text = _HEADING.sub(r"\1", text)
    text = _BULLET.sub(r"\1- ", text)
    text = _BOLD_ITALIC.sub(r"\1", text)
    text = _BOLD.sub(lambda m: m.group(1) or m.group(2), text)
    text = _ITALIC_STAR.sub(r"\1", text)
    text = _ITALIC_UNDERSCORE.sub(r"\1", text)
    text = _STRIKE.sub(r"\1", text)
    for index, kept in enumerate(stash):
        text = text.replace(f"\x00{index}\x00", kept)
    return text
