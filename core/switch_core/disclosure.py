"""What a room's audience is — who can read what is said in it.

Two questions, deliberately narrow: how wide is this room's readership, and is
this bridge outside the organisation. The answer becomes an `audience` on every
event, and from there the standing instruction an agent reads.

**Labelling only.** The *flow rule* — whether content known in one audience may
be repeated in another — and the verbatim-quote check that went with it are
parked on `feat/us4-disclosure-enforcement`. They had no callers, and keeping
them here made this file read as a working disclosure system when it is a
working labelling system. Nothing enforces discretion today; the agent is told
the rule and obeys it or does not.

Before reviving them, read `multi-surface-status.md` §1a: first real use showed
the rule refusing the primary workflow, because it reasons about the audience
of the *room* and not of the *content*.
"""

from __future__ import annotations

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
