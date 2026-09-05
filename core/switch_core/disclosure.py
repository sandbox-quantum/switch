"""Whether an agent may carry what it knows from one room into another.

Session-per-room used to answer this by accident. The session answering in a
team channel had never seen the private DM, so it could not repeat it — not a
designed protection, but a real one. A connection covering several rooms
dissolves it deliberately, and this module is what replaces it.

Two halves, and they are not the same kind of thing.

**The rule** (`audience_of`, `may_carry`) is exact. Rooms have audiences,
content moves to an equal or narrower one, and moving it wider or outside needs
a human to say so in the turn. This is what the agent is told, and it is what an
enforcement point evaluates.

**The check** (`disclosed_span`) is partial on purpose. It finds text carried
across *verbatim*, because quoting is what a language model actually does when
it leaks something. It cannot find a paraphrase, and nothing here pretends
otherwise — the test suite asserts the limit rather than describing it, so that
nobody reads this as a guarantee against disclosure. What it gives is: the
boundary is visible, a crossing is auditable, and the most likely form of
crossing is caught before it is relayed.

Deliberately pure — no database, no I/O — like `addressing.py`, so it is
trivially testable and can be called from the receive path, the bridge relay and
the gateway alike.

**This rule exists twice, in two languages.** The client derives the same
audience from `channel_type` in
`console/packages/switch-agent-runtime/src/surface.ts`, because the label has to
reach the model's context and the server is not in that path. Where the two
disagree, an agent is told one thing and judged by another. Change one and
change the other.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Literal

Audience = Literal["private", "restricted", "open", "external", "unknown"]

#: How long a shared run of words has to be before it counts as a quote.
#:
#: The threshold is the whole difference between a useful check and one that
#: fires on "let me know what you think" and gets turned off within a day. Eight
#: words is long enough that two people writing independently about the same
#: subject do not collide, and short enough to catch a sentence lifted whole.
MIN_DISCLOSED_WORDS = 8

_BY_CHANNEL_TYPE: dict[str, Audience] = {
    "direct": "private",
    "channel_private": "restricted",
    "group": "restricted",
    "channel_public": "open",
    "lobby": "open",
}


#: Bridge types whose correspondent is outside the organisation.
#:
#: One place names them, because "is this room outside the boundary?" is asked
#: by the flow rule, by the instructions an agent is given, and eventually by
#: the egress check — and three answers that can disagree is worse than none.
EXTERNAL_BRIDGE_TYPES = frozenset({"email"})


def bridge_is_external(bridge_type: str | None) -> bool:
    """Whether a bridge of this type carries someone outside the organisation.

    A Slack workspace or a Teams tenant is the organisation talking to itself.
    An email correspondent is not, whoever they are — which is why an email room
    holding one vendor is `external` while a public channel holding two hundred
    colleagues is not.
    """
    return bridge_type in EXTERNAL_BRIDGE_TYPES


def audience_of(channel_type: str | None, *, bridge_is_external: bool) -> Audience:
    """Who can read a room, from what the room is.

    `bridge_is_external` is a separate argument rather than another channel type
    because it is a separate question: an email room holds one correspondent —
    smaller than any channel — and is still outside the trust boundary.
    """
    if bridge_is_external:
        return "external"
    if not channel_type:
        return "unknown"
    return _BY_CHANNEL_TYPE.get(channel_type, "unknown")


def may_carry(source: Audience, target: Audience, *, same_room: bool) -> bool:
    """Whether content known in `source` may be repeated in `target`.

    **The audience label is a size, and the question is about people.** An
    earlier version of this compared the two labels and allowed a move whenever
    the target was no larger — which permits a DM with one person into a DM with
    a different person, and one vendor's mail into another vendor's, because
    both pairs share a label. Two rooms with the same audience are almost never
    the same audience.

    Soundly, content may move from A to B when everyone who can read B could
    already read A. Without room membership to compare, exactly two cases are
    knowable:

    - **The same room.** Trivially true, and this is what `same_room` is for —
      the caller knows the room ids, and this module deliberately does not.
    - **Out of an `open` room into anywhere else inside the organisation.**
      `open` means the whole workspace, and every internal room is a subset of
      it, so nothing is revealed to anyone who could not already look.

    Everything else — including same-label rooms, and anything touching
    `external` or `unknown` — is a decision for a person, not a default. That is
    a conservative answer rather than a precise one, and deliberately: the
    precise model is membership-set inclusion, and until Switch compares
    membership here, refusing costs a question while permitting costs a
    disclosure.
    """
    if same_room:
        return True
    if source == "open" and target in ("private", "restricted", "open"):
        return True
    return False


#: Typographic apostrophes folded to the ASCII one.
#:
#: The single likeliest way a verbatim quote escapes this check. A person's mail
#: client writes `don’t` and a model writes `don't`; split on the wrong one,
#: `don’t` becomes two tokens and the run breaks in the middle.
_APOSTROPHES = str.maketrans(
    {"\u2019": "'", "\u2018": "'", "\u201b": "'", "\uff07": "'"}
)


def _words(text: str) -> list[str]:
    """The text as comparable words.

    Normalised, lowercased and stripped of punctuation, so a re-wrapped,
    re-capitalised, comma-shifted restatement still matches. A model rarely
    re-emits text byte for byte; it re-emits the words.

    NFKC first, so an accented word and its decomposed form are one word rather
    than two different ones, and a Unicode word class rather than ``[a-z0-9]``
    so accented and non-Latin text survives tokenising at all instead of
    vanishing.

    **A limit worth stating**: this counts words, so it is weak for scripts
    written without spaces between them, where a whole clause tokenises as one
    word and rarely reaches the threshold. Like paraphrase, that is a bound on
    what the check can see rather than a bug, and the suite asserts it.
    """
    normalised = unicodedata.normalize("NFKC", text).translate(_APOSTROPHES)
    return re.findall(r"[\w']+", normalised.lower(), re.UNICODE)


def disclosed_span(
    outbound: str,
    protected: Iterable[str],
    *,
    min_words: int = MIN_DISCLOSED_WORDS,
) -> str | None:
    """The first run of `min_words` the outbound message shares with protected
    material, or None.

    Returned rather than reported as a bare boolean so a refusal can name the
    part that caused it — "blocked" on its own leaves everyone guessing which
    sentence to rewrite.

    Compares word shingles rather than searching for substrings: one pass over
    the protected material and one over the message, instead of a quadratic
    scan per pair.
    """
    if min_words <= 0:
        raise ValueError(
            f"min_words must be positive, got {min_words}; a non-positive "
            "threshold would report every message as clean"
        )

    out_words = _words(outbound)
    if len(out_words) < min_words:
        return None

    shingles: set[tuple[str, ...]] = set()
    for source in protected:
        source_words = _words(source)
        for i in range(len(source_words) - min_words + 1):
            shingles.add(tuple(source_words[i : i + min_words]))
    if not shingles:
        return None

    for i in range(len(out_words) - min_words + 1):
        window = tuple(out_words[i : i + min_words])
        if window in shingles:
            return " ".join(window)
    return None
