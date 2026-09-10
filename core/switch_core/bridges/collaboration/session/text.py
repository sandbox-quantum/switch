"""An answer typed in words, read back off a message.

Every card carries the text form of its own question, because a card can fail
to render, a client can refuse to draw buttons, and the contract requires a
bridge to accept an explicit text answer as well as a control. This is the
other end of that: the grammar a person types, and nothing more.

The grammar is deliberately narrow. A message either *is* an answer or it is
not one; a message that merely mentions a handle somewhere in a sentence is
chatter, and treating it as a decision would answer a permission prompt on
someone's behalf because they said the wrong thing in passing.

The forms:

    yes                a bare decision, only ever as a direct reply to one card
    R42 1              a handle and which option, numbered as the card numbers
    R42 yes            the same, with the card named
    R43 1,3            more than one option, where the card allows it
    R43 q1=2; q2=1,3   one part per question, questions numbered as the card is
    R43 q3="staging"   an answer written out, where the question invites one

Nothing here resolves anything. A handle is whatever token was typed, and it
means a request only once it has been looked up within the bridge it was minted
for; a number means an option only against the form that card offered, which is
`form.py`'s job. Both of those can refuse.

Every refusal here is a `None`, never an exception. This runs on the inbound
path of every message on every platform, ahead of the relay to the room, so a
raise is not a rejected answer — it is a message the room never sees.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

Decision = Literal["accept", "decline"]

# What a person types instead of a number. Only ever consulted when the message
# is nothing but this word: "no, that broke the build" is not a decision.
_DECISIONS: dict[str, Decision] = {
    "yes": "accept",
    "y": "accept",
    "ok": "accept",
    "okay": "accept",
    "approve": "accept",
    "approved": "accept",
    "allow": "accept",
    "no": "decline",
    "n": "decline",
    "deny": "decline",
    "denied": "decline",
    "decline": "decline",
    "reject": "decline",
}

# Words above that only answer when the card is named. "ok" is how a channel
# says "got it" far more often than "yes, run it", and a bare acknowledgement
# in a thread must not be what grants a permission.
_ONLY_WITH_A_HANDLE = frozenset({"ok", "okay"})

# A handle is followed by nothing, or by the punctuation a person would put
# after it — "R42: 1" and "R42 - 1" are the same answer as "R42 1". So is a
# bullet in front of the whole thing.
_SEPARATOR_CHARS = ":.-–—,"
_SEPARATOR_TOKENS = re.compile(rf"^(?:[{re.escape(_SEPARATOR_CHARS)}]+(?:\s+|$))*")
_TRAILING = ".!,:;"

# Written answers are quoted so that the words in them are not read as grammar.
# A phone substitutes the curly pair without being asked, so both count: the
# alternative is an answer that is silently not one, typed by someone who did
# exactly what the card told them to.
_QUOTES = {'"': '"', "'": "'", "“": "”", "‘": "’"}

# `q1=…`, and the same written the way a person might. The digits are bounded
# in the pattern rather than after it, because `int` accepts strings long
# enough to be slow to convert and no card asks a hundred questions.
_QUESTION = re.compile(r"^q\s*(\d{1,2})\s*[=:]\s*(.+)$", re.IGNORECASE | re.DOTALL)

# One part per question, however the person separated them: a semicolon, a new
# line, or nothing but the space before the next `qN=`.
_PART_SEPARATOR = re.compile(r"\s*[;\n]+\s*|\s+(?=q\s*\d{1,2}\s*[=:])", re.IGNORECASE)

# Options within one part.
_ITEM_SEPARATOR = re.compile(r"\s*,\s*")

# Bounds, so that the work this does is a function of nothing an author of a
# message chooses. A card renders at most 25 controls and asks a handful of
# questions; a message longer than this is prose that happens to start with a
# handle, and prose is not an answer.
_MAX_MESSAGE = 500
_MAX_PARTS = 25
_MAX_OPTIONS = 25


@dataclass(frozen=True)
class AnswerPart:
    """One question's worth of a typed answer.

    `question` is which question, counted from 1 as the card numbers them, and
    None when the person named none — which is the whole of "R42 1", and only
    answers a card that asks exactly one thing.

    `options` are positions on the card, in the order they were typed and with
    a repeat dropped. `custom_text` is what was written out instead of, or
    alongside, them. At least one of the two is always present.
    """

    question: int | None
    options: tuple[int, ...]
    custom_text: str | None


@dataclass(frozen=True)
class TextAnswer:
    """What a message said, before anything has been resolved.

    `handle` is None when the message named no request, which is the bare form
    and only answers anything as a direct reply. Exactly one of `decision` and
    `parts` is filled: a word standing in for an option, or the positions and
    the words that were typed instead.
    """

    handle: str | None
    decision: Decision | None
    parts: tuple[AnswerPart, ...]


def parse_text_answer(body: str) -> TextAnswer | None:
    """Read a message as an answer, or None if it is not one.

    None is the common case and not a failure: almost everything said in a
    channel is not an answer to a request.
    """
    text = _undecorate(_clean(body))
    if not text or len(text) > _MAX_MESSAGE:
        return None

    head, tail = _split_first(text)
    rest = _undecorate(tail)
    if not rest:
        return _bare(head)
    handle = head.rstrip(_SEPARATOR_CHARS)
    if re.fullmatch(r"[Rr][1-9][0-9]*", handle) is None:
        return None

    # "R42 yes" is the one form that is a word rather than a selection, and it
    # is only ever the whole of what follows the handle.
    decision = _DECISIONS.get(_word(rest)) if not _has_space(rest) else None
    if decision is not None:
        return TextAnswer(handle=handle, decision=decision, parts=())

    parts = _parts(rest)
    return TextAnswer(handle=handle, decision=None, parts=parts) if parts else None


def _clean(body: str) -> str:
    """The message with the decoration a platform or a person put around it.

    Only the wrappers that carry no meaning of their own: emphasis, code marks
    and closing punctuation. Anything else is left to fail the grammar. Code
    marks matter more than they look — a card writes its own example as a code
    span, so this is what makes the instruction on the card copy back verbatim.
    """
    return body.strip().strip("*_`~ ").rstrip(_TRAILING).strip()


def _undecorate(text: str) -> str:
    """The same, with punctuation standing on its own at the front removed."""
    return _SEPARATOR_TOKENS.sub("", text).strip()


def _split_first(text: str) -> tuple[str, str]:
    """The first word, and everything after it."""
    words = text.split(maxsplit=1)
    if not words:
        return "", ""
    return words[0], words[1] if len(words) > 1 else ""


def _bare(token: str) -> TextAnswer | None:
    """A message that is one word, as an answer to the card it replies to.

    A word is worth acting on; a number is not. "yes" said to a permission
    prompt means one thing, and "2" in a channel is far more often a count, a
    version or an hour.
    """
    word = _word(token)
    if word in _ONLY_WITH_A_HANDLE:
        return None
    decision = _DECISIONS.get(word)
    return TextAnswer(handle=None, decision=decision, parts=()) if decision else None


def _parts(rest: str) -> tuple[AnswerPart, ...] | None:
    """Everything after the handle, as one part per question."""
    split = _split(rest, _PART_SEPARATOR)
    if split is None:
        return None
    segments = [segment.strip() for segment in split if segment.strip()]
    if not segments or len(segments) > _MAX_PARTS:
        return None

    parts: list[AnswerPart] = []
    answered: set[int | None] = set()
    for segment in segments:
        part = _part(segment)
        if part is None or part.question in answered:
            # Two answers to one question is not an answer to it. Nothing here
            # is a good enough guess at which of them was meant.
            return None
        answered.add(part.question)
        parts.append(part)

    # Numbering some of the parts and not others is not a form anyone typed on
    # purpose, and reading the unnumbered ones positionally would put an answer
    # against whichever question happened to be next.
    if len(parts) > 1 and None in answered:
        return None
    return tuple(parts)


def _part(segment: str) -> AnswerPart | None:
    match = _QUESTION.match(segment)
    if match is None:
        return _value(None, segment)
    question = int(match.group(1))
    return _value(question, match.group(2).strip()) if question >= 1 else None


def _value(question: int | None, value: str) -> AnswerPart | None:
    """One part's worth of positions and written words."""
    items = _split(value, _ITEM_SEPARATOR)
    if items is None or not items or len(items) > _MAX_OPTIONS:
        return None

    options: list[int] = []
    custom: str | None = None
    for item in items:
        item = item.strip()
        if not item:
            return None
        written = _written(item)
        if written is not None:
            # Two written answers to one question, or an empty pair of quotes.
            # Neither is something to send to a session.
            if custom is not None or not written:
                return None
            custom = written
            continue
        word = _word(item)
        # Bounded before converting rather than after, because `int` refuses
        # things `str` calls numbers and every refusal here is a message the
        # room loses: "①" is a digit but not a decimal, and a string of more
        # than 4300 decimals is neither. A card offers at most 25 options, so
        # nothing longer than two digits is a choice in the first place.
        if not word.isdecimal() or len(word) > 2:
            return None
        index = int(word)
        if index < 1:
            # "0" is not an option on any card.
            return None
        if index not in options:
            options.append(index)
    return AnswerPart(question=question, options=tuple(options), custom_text=custom)


def _split(text: str, separator: re.Pattern[str]) -> list[str] | None:
    """Split on `separator`, except where it falls inside a written answer.

    Every character the grammar separates on is also a character someone writes
    with: a comma picks two options and also punctuates, a semicolon divides two
    parts and also joins two clauses. So a quoted answer is opaque from the
    quote that opens it to the one that closes it, and what is inside it is
    words rather than grammar.

    An unclosed quote is not an answer. It is far more likely to be an
    apostrophe in a sentence that happens to start with a handle.
    """
    segments: list[str] = []
    current: list[str] = []
    closer = ""
    index = 0
    while index < len(text):
        char = text[index]
        if closer:
            if char == closer:
                closer = ""
            current.append(char)
            index += 1
            continue
        if char in _QUOTES:
            closer = _QUOTES[char]
            current.append(char)
            index += 1
            continue
        found = separator.match(text, index)
        if found is not None and found.end() > index:
            segments.append("".join(current))
            current = []
            index = found.end()
            continue
        current.append(char)
        index += 1
    if closer:
        return None
    segments.append("".join(current))
    return segments


def _written(item: str) -> str | None:
    """The words inside a quoted answer, or None if this is not one."""
    if len(item) >= 2 and item[0] in _QUOTES and item[-1] == _QUOTES[item[0]]:
        return item[1:-1].strip()
    return None


def _has_space(text: str) -> bool:
    return any(char.isspace() for char in text)


def _word(token: str) -> str:
    return token.rstrip(_TRAILING).lower()
