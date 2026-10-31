"""How much a text costs on SMS, and cutting a reply to what may be spent.

Twilio bills per segment. A text in the GSM-7 alphabet fits 160 characters in
one segment and one character outside that alphabet moves the whole text to
UCS-2, which fits 70. A longer text is split by the carrier, and each part loses
room to a header. The per-part sizes here are the smaller ones Twilio gives for
toll-free numbers, 152 and 66: a character is never split across two parts, so
counting a little short of the usual 153 and 67 keeps the count an upper bound.
"""

from __future__ import annotations

import math
import re

_GSM_BASIC = frozenset(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
_GSM_EXTENDED = frozenset("^{}\\[~]|€\f")

_SINGLE_GSM = 160
_SINGLE_UCS2 = 70
_PART_GSM = 152
_PART_UCS2 = 66

# Twilio refuses a longer body: 1,600 GSM-7 characters, or 700 in UCS-2. These
# are the largest whole numbers of parts under each.
_MESSAGE_GSM = 1600 // _PART_GSM * _PART_GSM
_MESSAGE_UCS2 = 700 // _PART_UCS2 * _PART_UCS2

CUT_NOTICE = "\n...(cut short. See the rest in Switch Console)"

_SENTENCE_END = re.compile(r"[.!?][ \n]")


def is_gsm(text: str) -> bool:
    return all(c in _GSM_BASIC or c in _GSM_EXTENDED for c in text)


def _units(char: str, gsm: bool) -> int:
    if gsm:
        return 2 if char in _GSM_EXTENDED else 1
    return 2 if ord(char) > 0xFFFF else 1


def _length(text: str, gsm: bool) -> int:
    return sum(_units(c, gsm) for c in text)


def count_segments(text: str) -> int:
    """The segments Twilio would bill for `text` sent as one message."""
    gsm = is_gsm(text)
    length = _length(text, gsm)
    if length <= (_SINGLE_GSM if gsm else _SINGLE_UCS2):
        return 1
    return math.ceil(length / (_PART_GSM if gsm else _PART_UCS2))


def _index_at(text: str, length: int, gsm: bool) -> int:
    """How many characters of `text` fit in `length` units."""
    used = 0
    for index, char in enumerate(text):
        used += _units(char, gsm)
        if used > length:
            return index
    return len(text)


def _cut_point(text: str, limit: int) -> int:
    """The best place to end a piece at or before `limit` characters: a
    paragraph, then a sentence, then a line, then a word, as long as that
    leaves the piece at least half full. Mid-word only when there is none."""
    head = text[:limit]
    floor = limit // 2
    at = head.rfind("\n\n")
    if at > floor:
        return at
    sentences = [m.end() - 1 for m in _SENTENCE_END.finditer(head)]
    if sentences and sentences[-1] > floor:
        return sentences[-1]
    for separator in ("\n", " "):
        at = head.rfind(separator)
        if at > floor:
            return at
    return limit


def _split(text: str, gsm: bool) -> list[str]:
    """`text` as messages short enough for Twilio to accept."""
    limit = _MESSAGE_GSM if gsm else _MESSAGE_UCS2
    pieces: list[str] = []
    rest = text
    while _length(rest, gsm) > limit:
        cut = _cut_point(rest, _index_at(rest, limit, gsm))
        pieces.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        pieces.append(rest)
    return pieces


def fit_reply(text: str, max_segments: int) -> list[str]:
    """`text` as messages costing at most `max_segments` segments in all.

    A text over the limit is cut at the best break before it and ends with
    `CUT_NOTICE`, which counts towards the limit. With no room for the notice,
    as with a limit of one on a text that nearly fills it, the text gives way
    to the notice.
    """
    gsm = is_gsm(text)
    pieces = _split(text, gsm)
    if sum(count_segments(p) for p in pieces) <= max_segments:
        return pieces
    part = _PART_GSM if gsm else _PART_UCS2
    budget = max_segments * part
    while budget > 0:
        room = budget - _length(CUT_NOTICE, gsm)
        keep = _index_at(text, room, gsm) if room > 0 else 0
        head = text[: _cut_point(text, keep)].rstrip() if keep else ""
        pieces = _split(f"{head}{CUT_NOTICE}".lstrip(), gsm)
        if sum(count_segments(p) for p in pieces) <= max_segments:
            return pieces
        budget -= part
    return [CUT_NOTICE.lstrip()]
