"""An answer typed in words, read back off a message.

Every card carries the text form of its own question, because a card can fail
to render, a client can refuse to draw buttons, and the contract requires a
bridge to accept an explicit text answer as well as a control. This is the
other end of that: the grammar a person types, and nothing more.

The grammar is deliberately narrow. A message either *is* an answer or it is
not one; a message that merely mentions a handle somewhere in a sentence is
chatter, and treating it as a decision would answer a permission prompt on
someone's behalf because they said the wrong thing in passing.

Two forms:

    R42 1        a handle and which option, numbered as the card numbers them
    yes          a bare decision, only ever as a direct reply to one card

Nothing here resolves anything. A handle is whatever token was typed, and it
means a request only once it has been looked up within the bridge it was minted
for; a number means an option only against the options that card offered. Both
of those are the caller's job, and both can refuse.
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
# after it — "R42: 1" and "R42 - 1" are the same answer as "R42 1".
_SEPARATOR_CHARS = ":.-–—,"
_SEPARATORS = re.compile(f"^[{re.escape(_SEPARATOR_CHARS)}]+$")
_TRAILING = ".!,:;"


@dataclass(frozen=True)
class TextAnswer:
    """What a message said, before anything has been resolved.

    `handle` is None when the message named no request, which is the bare form
    and only answers anything as a direct reply. Exactly one of `index` and
    `decision` is set: a number is which option, counted from 1 as the card
    numbers them, and a decision is a word standing in for one.
    """

    handle: str | None
    index: int | None
    decision: Decision | None


def parse_text_answer(body: str) -> TextAnswer | None:
    """Read a message as an answer, or None if it is not one.

    None is the common case and not a failure: almost everything said in a
    channel is not an answer to a request.
    """
    tokens = [token for token in _clean(body).split() if not _SEPARATORS.match(token)]
    if not tokens or len(tokens) > 2:
        return None

    if len(tokens) == 1:
        return _bare(tokens[0])

    selection = _selection(tokens[-1])
    if selection is None:
        return None
    index, decision = selection
    handle = tokens[0].rstrip(_SEPARATOR_CHARS)
    return TextAnswer(handle=handle, index=index, decision=decision) if handle else None


def _clean(body: str) -> str:
    """The message with the decoration a platform or a person put around it.

    Only the wrappers that carry no meaning of their own: emphasis, code marks
    and closing punctuation. Anything else is left to fail the grammar.
    """
    return body.strip().strip("*_`~ ").rstrip(_TRAILING).strip()


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
    return TextAnswer(handle=None, index=None, decision=decision) if decision else None


def _selection(token: str) -> tuple[int | None, Decision | None] | None:
    word = _word(token)
    if word.isdecimal():
        # Bounded before converting rather than after, because `int` refuses
        # things `str` calls numbers and every refusal here is a message the
        # room loses: "①" is a digit but not a decimal, and a string of more
        # than 4300 decimals is neither. A card offers at most 25 options, so
        # nothing longer than two digits is a choice in the first place.
        if len(word) > 2:
            return None
        index = int(word)
        # "0" is not an option on any card.
        return (index, None) if index >= 1 else None
    decision = _DECISIONS.get(word)
    return (None, decision) if decision else None


def _word(token: str) -> str:
    return token.rstrip(_TRAILING).lower()
