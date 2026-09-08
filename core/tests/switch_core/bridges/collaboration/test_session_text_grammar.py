"""What counts as an answer typed in words, and what is just talking.

The grammar has to be narrow in one direction and forgiving in the other. Miss
a real answer and someone repeats themselves; read chatter as an answer and a
permission prompt is decided for someone because of what they said in passing.
So most of this file is about what is *not* an answer.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.session.text import parse_text_answer


@pytest.mark.parametrize(
    ("body", "index"),
    [
        ("R42 1", 1),
        ("r42 2", 2),
        ("R42: 1", 1),
        ("R42 - 3", 3),
        ("  R42   1  ", 1),
        ("R42 1.", 1),
        ("*R42 1*", 1),
        ("`R42 1`", 1),
    ],
)
def test_a_handle_and_a_number_is_an_answer(body: str, index: int) -> None:
    answer = parse_text_answer(body)

    assert answer is not None
    assert answer.handle is not None
    assert answer.handle.lower() == "r42"
    assert answer.index == index
    assert answer.decision is None


@pytest.mark.parametrize(
    ("body", "decision"),
    [
        ("yes", "accept"),
        ("Yes!", "accept"),
        ("approve", "accept"),
        ("allow", "accept"),
        ("no", "decline"),
        ("Deny.", "decline"),
        ("reject", "decline"),
    ],
)
def test_a_bare_word_is_a_decision_with_no_request_named(
    body: str, decision: str
) -> None:
    """It answers nothing on its own — the caller decides what it is replying to."""
    answer = parse_text_answer(body)

    assert answer is not None
    assert answer.handle is None
    assert answer.index is None
    assert answer.decision == decision


def test_a_handle_and_a_word_is_the_same_answer() -> None:
    answer = parse_text_answer("R42 deny")

    assert answer is not None
    assert answer.handle == "R42"
    assert answer.decision == "decline"


@pytest.mark.parametrize(
    "body",
    [
        "",
        "   ",
        "no, that broke the build",
        "yes please, R42 1",
        "I think R42 1 is right",
        "R42",
        "R42 maybe",
        "R42 first",
        "1",
        "R42 0",
        "R42 100",
        "R42 -1",
        "R42 1 2",
        "https://example.test/R42/1",
    ],
)
def test_anything_else_is_just_someone_talking(body: str) -> None:
    assert parse_text_answer(body) is None


@pytest.mark.parametrize("body", ["①", "²", "R42 ①", "R42 10²", "R42 ٤"])
def test_something_shaped_like_a_number_does_not_take_the_message_with_it(
    body: str,
) -> None:
    """Refuse it, or don't, but never raise.

    The parser runs on every message a channel sends, so an exception out of it
    is a message the room never sees and nobody can account for. `str.isdigit`
    is true of "①" and "10²", which `int` then refuses — a combination that
    swallowed the message rather than declining to read it as an answer.
    """
    answer = parse_text_answer(body)

    assert answer is None or answer.index == 4


@pytest.mark.parametrize("body", ["ok", "Okay!", "`ok`"])
def test_an_acknowledgement_on_its_own_grants_nothing(body: str) -> None:
    """ "ok" in a channel is "got it" far more often than "yes, run it"."""
    assert parse_text_answer(body) is None


def test_the_same_acknowledgement_answers_the_card_it_names() -> None:
    """Naming the request is what makes the intent unambiguous."""
    answer = parse_text_answer("R42 ok")

    assert answer is not None
    assert answer.handle == "R42"
    assert answer.decision == "accept"


def test_a_number_on_its_own_is_not_an_answer() -> None:
    """Unlike a bare word, it is far more often a count than a choice.

    A bare "yes" in reply to a card is unambiguous enough to act on. A bare "2"
    in a channel is a quantity, a version, a queue depth, an hour.
    """
    assert parse_text_answer("2") is None
