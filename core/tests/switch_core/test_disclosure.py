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


def test_anything_may_be_repeated_in_the_room_it_came_from() -> None:
    """The one case that needs no membership knowledge at all."""
    for audience in ("private", "restricted", "open", "external", "unknown"):
        assert may_carry(audience, audience, same_room=True)


def test_what_the_whole_workspace_can_see_moves_anywhere_inside_it() -> None:
    """Every internal room is a subset of the workspace, so nothing is revealed
    to anyone who could not already go and look."""
    assert may_carry("open", "private", same_room=False)
    assert may_carry("open", "restricted", same_room=False)
    assert may_carry("open", "open", same_room=False)


def test_two_rooms_sharing_a_label_are_not_the_same_people() -> None:
    """The bug this rule was written with, and the most common shape there is.

    An agent in a DM with one person and a DM with another has two `private`
    rooms. Comparing labels says the move is free; it is a disclosure of one
    person's words to somebody else entirely.
    """
    assert not may_carry("private", "private", same_room=False)
    assert not may_carry("restricted", "restricted", same_room=False)
    assert not may_carry("unknown", "unknown", same_room=False)


def test_one_outsider_is_not_another_outsider() -> None:
    """Same bug, sharpest consequence: a vendor's quote forwarded to a rival."""
    assert not may_carry("external", "external", same_room=False)


def test_content_does_not_move_into_a_wider_room() -> None:
    assert not may_carry("private", "restricted", same_room=False)
    assert not may_carry("private", "open", same_room=False)
    assert not may_carry("restricted", "open", same_room=False)


def test_nothing_reaches_an_outsider_on_the_agent_s_own_initiative() -> None:
    assert not may_carry("private", "external", same_room=False)
    assert not may_carry("restricted", "external", same_room=False)
    assert not may_carry("open", "external", same_room=False)


def test_what_an_outsider_said_is_not_thereby_publishable() -> None:
    """Their mail was sent to us, not released."""
    assert not may_carry("external", "open", same_room=False)
    assert not may_carry("external", "restricted", same_room=False)


def test_an_unknown_room_moves_nothing_in_either_direction() -> None:
    """Both assumptions are unsafe, so neither is made.

    `unknown` is also the fallback for any `channel_type` this does not
    recognise, so a new platform must degrade to refusing rather than to
    permitting everything between its rooms.
    """
    assert not may_carry("private", "unknown", same_room=False)
    assert not may_carry("restricted", "unknown", same_room=False)
    assert not may_carry("open", "unknown", same_room=False)
    assert not may_carry("unknown", "open", same_room=False)
    assert not may_carry("unknown", "restricted", same_room=False)


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

    The outbound here is long enough to be checked properly — an earlier version
    of this test used a six-word message, which `disclosed_span` rejects on
    length before comparing anything, so it proved only that six is fewer than
    eight.
    """
    protected = "Thanks for this — let me know what you think when you get a chance."
    outbound = (
        "Let me know what you think, and I will get the contract drafted this week."
    )

    assert disclosed_span(outbound, [protected]) is None


def test_eight_words_of_pure_boilerplate_does_fire_and_that_is_the_cost() -> None:
    """The threshold is a trade, not a solved problem.

    English has eight-word runs that two people produce independently, and this
    is one. Recorded as an accepted false positive rather than left for someone
    to discover and conclude the check is broken: the answer when it bites is a
    stopword-density guard on the matched span, not a longer threshold, which
    would let real quotes through.
    """
    span = disclosed_span(
        "Let me know if you have any questions before Friday",
        ["Thanks — let me know if you have any questions, and I will follow up."],
    )

    assert span is not None


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
    """The quote may come from any room the agent has read, not just the first."""
    outbound = "they asked for a staged rollout over three weeks starting in March"

    span = disclosed_span(
        outbound,
        [
            "something entirely unrelated",
            "we want a staged rollout over three weeks starting in March",
        ],
    )

    assert span is not None


def test_exactly_the_threshold_counts_and_one_word_less_does_not() -> None:
    """Pinned, because the threshold is the whole difference between a useful
    check and one that cries wolf."""
    words = [f"w{i}" for i in range(MIN_DISCLOSED_WORDS)]
    protected = " ".join(words)

    assert disclosed_span(protected, [protected]) is not None
    assert disclosed_span(" ".join(words[:-1]), [protected]) is None


def test_a_typographic_apostrophe_does_not_break_the_run() -> None:
    """The likeliest way a verbatim quote escapes.

    A person's mail client writes `don’t`; a model writes `don't`. Splitting on
    the wrong one turns the word into two tokens and breaks the run in the
    middle of an otherwise exact quote.
    """
    protected = "we don\u2019t want to sign before the audit closes"
    outbound = "they said we don't want to sign before the audit closes"

    assert disclosed_span(outbound, [protected]) is not None


def test_accented_text_is_compared_rather_than_discarded() -> None:
    """An ASCII-only word class silently reduced this to a handful of fragments,
    so an exact quote read as clean."""
    protected = "le café ferme à dix-huit heures précises chaque jour ouvré"

    assert disclosed_span(protected, [protected]) is not None


def test_a_script_written_without_spaces_is_a_known_blind_spot() -> None:
    """Asserted, like the paraphrase limit, rather than left to be discovered.

    The check counts words. Where a clause is written without separators it
    tokenises as one or two words and never reaches the threshold, so an exact
    copy reads as clean. Anyone relying on this for such a language needs to
    know that before they rely on it.
    """
    protected = "\u5f0a\u793e\u306e\u4fa1\u683c\u306f\u6765\u5e74\u5ea6\u304b\u3089\u4e0a\u304c\u308a\u307e\u3059"

    assert disclosed_span(protected, [protected]) is None


def test_a_non_positive_threshold_is_refused_rather_than_answered() -> None:
    """It would report every message as clean — the least safe answer there is,
    returned silently, for an input that can only be a mistake."""
    with pytest.raises(ValueError):
        disclosed_span("anything", ["anything"], min_words=0)


def test_nothing_to_check_against_is_not_a_disclosure() -> None:
    assert disclosed_span("anything at all", []) is None
    assert disclosed_span("anything at all", [""]) is None


def test_an_empty_message_discloses_nothing() -> None:
    assert disclosed_span("", ["something private and quite long indeed"]) is None
