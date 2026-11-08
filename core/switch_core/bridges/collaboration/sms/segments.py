"""Cut a reply into SMS-sized parts and count what sending them costs.

Twilio bills per segment, not per message. A segment holds 160 characters of
the GSM-7 alphabet, or 70 when the text needs anything outside it (one curly
quote or emoji is enough). Once a message needs more than one segment, each
holds 153 GSM-7 characters or 67 UTF-16 units, because the rest carries the
header that stitches them back together. A few GSM-7 characters (`{`, `[`, `|`,
the euro sign, ...) are sent as two.

A reply is therefore planned, not just chunked: it is split into parts of at
most `PART_SEGMENTS` segments each, and the whole reply is held to a budget of
segments. Past the budget the rest is dropped and a one-segment note says so.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

PART_SEGMENTS = 3

#: Characters that cost one unit in the GSM 03.38 default alphabet.
_GSM_BASIC = frozenset(
    "@£$¥èéùìòÇ\nØø\rÅå"
    "Δ_ΦΓΛΩΠΨΣΘΞÆæß"
    "É !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§"
    "¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
#: Characters that cost two units: the escape plus the character.
_GSM_EXTENDED = frozenset("^{}\\[~]|€\f")

_GSM_SINGLE = 160
_GSM_MULTI = 153
_UCS2_SINGLE = 70
_UCS2_MULTI = 67

#: Room kept in each part for the "(12/20) " prefix.
_PREFIX_RESERVE = 8
_MAX_PARTS = 20

TRUNCATION_NOTE = "[Reply cut short. The full text is in Switch Console.]"


def uses_gsm7(text: str) -> bool:
    """Whether every character of `text` is in the GSM-7 alphabet."""
    return all(char in _GSM_BASIC or char in _GSM_EXTENDED for char in text)


def _units(text: str, gsm7: bool) -> int:
    if gsm7:
        return sum(2 if char in _GSM_EXTENDED else 1 for char in text)
    return len(text.encode("utf-16-le")) // 2


def segment_count(text: str) -> int:
    """How many segments Twilio bills to send `text` as one message."""
    if not text:
        return 0
    gsm7 = uses_gsm7(text)
    units = _units(text, gsm7)
    single, multi = (_GSM_SINGLE, _GSM_MULTI) if gsm7 else (_UCS2_SINGLE, _UCS2_MULTI)
    if units <= single:
        return 1
    return math.ceil(units / multi)


def _fits(text: str, reserve: int) -> bool:
    gsm7 = uses_gsm7(text)
    multi = _GSM_MULTI if gsm7 else _UCS2_MULTI
    return _units(text, gsm7) + reserve <= PART_SEGMENTS * multi


_FENCE = re.compile(r"^```[^\n]*\n?", re.MULTILINE)
_HEADING = re.compile(r"^#{1,6}[ \t]+", re.MULTILINE)
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_BOLD = re.compile(r"(\*\*|__)(.+?)\1", re.DOTALL)
_ITALIC = re.compile(r"(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])")
_CODE = re.compile(r"`([^`\n]+)`")
_BLANK_RUNS = re.compile(r"\n{3,}")


def to_plain_text(markdown: str) -> str:
    """Switch Markdown as text a phone shows without stray markers."""
    text = _FENCE.sub("", markdown)
    text = _HEADING.sub("", text)
    text = _LINK.sub(r"\1 (\2)", text)
    text = _CODE.sub(r"\1", text)
    text = _BOLD.sub(r"\2", text)
    text = _ITALIC.sub(r"\2", text)
    return _BLANK_RUNS.sub("\n\n", text).strip()


@dataclass(frozen=True)
class ReplyPlan:
    #: The messages to send, in order.
    parts: list[str]
    #: The reply was longer than its segment budget and was cut.
    truncated: bool


_WORD = re.compile(r"\S+\s*")
_SENTENCE_END = re.compile(r"[.!?]['\")\]]*\s*$|\n\s*$")


def _tokens(text: str) -> list[str]:
    tokens: list[str] = []
    for word in _WORD.findall(text):
        if _fits(word, _PREFIX_RESERVE):
            tokens.append(word)
            continue
        piece = ""
        for char in word:
            if piece and not _fits(piece + char, _PREFIX_RESERVE):
                tokens.append(piece)
                piece = ""
            piece += char
        if piece:
            tokens.append(piece)
    return tokens


def _split(text: str) -> list[str]:
    """Greedy parts, each within `PART_SEGMENTS` segments once numbered. A part
    ends at a sentence boundary when one falls in its second half."""
    parts: list[str] = []
    current: list[str] = []

    def flush(upto: int) -> None:
        nonlocal current
        parts.append("".join(current[:upto]).rstrip())
        current = current[upto:]

    for token in _tokens(text):
        while current and not _fits("".join(current) + token, _PREFIX_RESERVE):
            size = len("".join(current))
            cut = len(current)
            running = 0
            best = 0
            for index, piece in enumerate(current, start=1):
                running += len(piece)
                if running * 2 >= size and _SENTENCE_END.search(piece):
                    best = index
            flush(best or cut)
        current.append(token)
    if current:
        flush(len(current))
    return [part for part in parts if part]


def plan_reply(text: str, *, max_segments: int) -> ReplyPlan:
    """Split `text` into parts that together bill at most `max_segments`.

    A reply that fits goes out as it is when it is one segment's worth or fits
    one part, otherwise as numbered parts "(1/3) ...". One that does not fit is
    cut, and ends with `TRUNCATION_NOTE`, which is part of the budget.
    """
    if max_segments <= PART_SEGMENTS:
        raise ValueError(
            f"max_segments must exceed {PART_SEGMENTS}: a reply is cut into parts "
            f"of up to {PART_SEGMENTS} segments and a cut needs one more for its note"
        )
    text = text.strip()
    if not text:
        return ReplyPlan(parts=[], truncated=False)
    if segment_count(text) <= PART_SEGMENTS:
        return ReplyPlan(parts=[text], truncated=False)

    bodies = _split(text)
    truncated = False
    cost = sum(_worst_cost(body) for body in bodies)
    if cost > max_segments:
        truncated = True
        budget = max_segments - segment_count(TRUNCATION_NOTE)
        kept: list[str] = []
        spent = 0
        for body in bodies:
            part_cost = _worst_cost(body)
            if spent + part_cost > budget:
                break
            kept.append(body)
            spent += part_cost
        bodies = kept
    total = len(bodies)
    parts = [_numbered(body, index, total) for index, body in enumerate(bodies, 1)]
    if truncated:
        parts.append(TRUNCATION_NOTE)
    return ReplyPlan(parts=parts, truncated=truncated)


def _numbered(body: str, index: int, total: int) -> str:
    return f"({index}/{total}) {body}"


def _worst_cost(body: str) -> int:
    """Segments a numbered part costs, with the longest prefix a plan can need."""
    return segment_count(_numbered(body, _MAX_PARTS, _MAX_PARTS))
