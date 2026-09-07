"""Whether the agent may carry what it knows from one room into another.

Session-per-room used to make this impossible by accident: the session
answering in a team channel had never seen the private DM, so it could not
repeat it. A connection covering both on purpose removes that, and nothing
replaces it unless the agent can see the boundary and something checks it.

Two halves, and they are not the same kind of thing.

`may_carry` is a **rule**, and a conservative one. Comparing audience *labels*
was the first attempt and it was wrong: two rooms sharing a label are almost
never the same people, so it permitted one person's DM into another's. Without
membership to compare, only two moves are knowable — within a room, and out of
one the whole workspace can already read.

`disclosed_span` is a **check**, and a deliberately partial one. It finds text
carried across verbatim, because quoting is what a language model actually does
when it leaks something. It cannot find a paraphrase, and the tests below say so
out loud rather than leaving a reader to assume a guarantee that is not there.
"""

from __future__ import annotations

import pytest

from switch_core.disclosure import (
    audience_of,
)

# ── Reading a room's audience ────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("channel_type", "expected"),
    [
        ("direct", "private"),
        ("channel_private", "restricted"),
        ("group", "restricted"),
        ("channel_public", "open"),
        ("lobby", "open"),
    ],
)
def test_the_room_type_says_who_can_read_it(channel_type: str, expected: str) -> None:
    assert audience_of(channel_type, bridge_is_external=False) == expected


def test_a_room_on_an_external_bridge_is_external_whatever_its_type() -> None:
    """Orthogonal to the size ordering, not a fourth step in it.

    An email room holds one correspondent — smaller than any channel — and is
    still the one place content must not travel to unasked.
    """
    assert audience_of("direct", bridge_is_external=True) == "external"
    assert audience_of("channel_public", bridge_is_external=True) == "external"


def test_an_uncharacterisable_room_says_unknown_rather_than_guessing() -> None:
    """Guessing `open` or `external` is still a claim about who can read it, and
    a wrong claim in the narrow direction is a disclosure nobody sees."""
    assert audience_of(None, bridge_is_external=False) == "unknown"
    assert audience_of("", bridge_is_external=False) == "unknown"
    assert audience_of("something-new", bridge_is_external=False) == "unknown"
