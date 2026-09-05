"""Whether the agent may carry what it knows from one room into another.

Session-per-room used to make this impossible by accident: the session
answering in a team channel had never seen the private DM, so it could not
repeat it. A connection covering both on purpose removes that, and nothing
replaces it unless the agent can see the boundary and something checks it.

Two halves, and they are not the same kind of thing.

`may_carry` is a **rule**: rooms have audiences, and content moves to an equal
or narrower one freely. It is exact, and it is what the agent is told.

`disclosed_span` is a **check**, and a deliberately partial one. It finds text
carried across verbatim, because quoting is what a language model actually does
when it leaks something. It cannot find a paraphrase, and the tests below say so
out loud rather than leaving a reader to assume a guarantee that is not there.
"""

from __future__ import annotations

import pytest

from switch_core.disclosure import (
    MIN_DISCLOSED_WORDS,
    audience_of,
    disclosed_span,
    may_carry,
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


# ── The flow rule ────────────────────────────────────────────────────────────


def test_content_moves_freely_into_an_equal_or_narrower_room() -> None:
    assert may_carry("restricted", "restricted")
    assert may_carry("open", "restricted")
    assert may_carry("open", "private")
    assert may_carry("restricted", "private")


def test_content_does_not_move_into_a_wider_room() -> None:
    assert not may_carry("private", "restricted")
    assert not may_carry("private", "open")
    assert not may_carry("restricted", "open")


def test_nothing_moves_out_to_an_external_room_on_its_own() -> None:
    """The one case where the room being small does not make it safe."""
    assert not may_carry("private", "external")
    assert not may_carry("restricted", "external")
    assert not may_carry("open", "external")


def test_an_external_room_is_not_a_source_anything_flows_out_of_either() -> None:
    """A vendor's mail is not automatically repeatable in a public channel.

    It is outside the boundary in both directions: what they told us was told to
    us, not published.
    """
    assert not may_carry("external", "open")
    assert may_carry("external", "external")


def test_an_unknown_room_is_treated_as_the_widest_thing_it_could_be() -> None:
    """Both directions, because both are unsafe to assume.

    Nothing flows *into* it, since it might be public; nothing flows *out* of
    it into a room that is not equally unknown, since it might be private.
    """
    assert not may_carry("private", "unknown")
    assert not may_carry("restricted", "unknown")
    assert not may_carry("unknown", "open")
    assert not may_carry("unknown", "restricted")


# ── Catching a quote ─────────────────────────────────────────────────────────


def test_a_verbatim_run_from_a_narrower_room_is_found() -> None:
    protected = "I think the Harborview pricing is going to be a problem at renewal."
    outbound = (
        "Worth flagging early: the Harborview pricing is going to be a problem "
        "at renewal, so we should talk before signing."
    )

    assert disclosed_span(outbound, [protected]) is not None


def test_the_span_that_was_disclosed_is_returned_so_a_refusal_can_name_it() -> None:
    """A refusal that says only "blocked" leaves everyone guessing which part."""
    protected = "the deposit is due on February the twentieth this year"
    outbound = f"Reminder — {protected}."

    span = disclosed_span(outbound, [protected])

    assert span is not None
    assert "deposit is due" in span


def test_an_ordinary_shared_phrase_is_not_a_disclosure() -> None:
    """Two people writing about the same thing share words.

    A check that fires on "let me know what you think" is a check somebody
    turns off within a day.
    """
    protected = "Thanks for this — let me know what you think when you get a chance."
    outbound = "Let me know what you think."

    assert disclosed_span(outbound, [protected]) is None


def test_a_paraphrase_is_not_caught_and_that_is_the_documented_limit() -> None:
    """Asserted, not merely admitted.

    The feature is worth having because quoting is what a model does when it
    leaks. Reading it as a guarantee against disclosure is the misunderstanding
    that would make it dangerous, so the boundary is pinned here.
    """
    protected = "I think the Harborview pricing is going to be a problem at renewal."
    outbound = "I have some concerns about what that venue will cost us next year."

    assert disclosed_span(outbound, [protected]) is None


def test_the_match_survives_reformatting() -> None:
    """A model rarely re-emits text byte for byte — it re-wraps it, changes the
    case of the first word, drops a comma."""
    protected = "The minimum headcount commitment is one hundred and eighty guests"
    outbound = (
        "the minimum   headcount commitment\nis one hundred and eighty guests,"
        " which we should watch"
    )

    assert disclosed_span(outbound, [protected]) is not None


def test_it_checks_every_protected_source() -> None:
    outbound = "the second one mentioned a staged rollout over three weeks"

    span = disclosed_span(
        outbound,
        ["something entirely unrelated", "we want a staged rollout over three weeks"],
    )

    assert span is not None


def test_exactly_the_threshold_counts_and_one_word_less_does_not() -> None:
    """Pinned, because the threshold is the whole difference between a useful
    check and one that cries wolf."""
    words = [f"w{i}" for i in range(MIN_DISCLOSED_WORDS)]
    protected = " ".join(words)

    assert disclosed_span(protected, [protected]) is not None
    assert disclosed_span(" ".join(words[:-1]), [protected]) is None


def test_nothing_to_check_against_is_not_a_disclosure() -> None:
    assert disclosed_span("anything at all", []) is None
    assert disclosed_span("anything at all", [""]) is None


def test_an_empty_message_discloses_nothing() -> None:
    assert disclosed_span("", ["something private and quite long indeed"]) is None
