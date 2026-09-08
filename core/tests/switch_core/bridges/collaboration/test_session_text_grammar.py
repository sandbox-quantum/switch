"""What counts as an answer typed in words, and what is just talking.

The grammar has to be narrow in one direction and forgiving in the other. Miss
a real answer and someone repeats themselves; read chatter as an answer and a
permission prompt is decided for someone because of what they said in passing.
So most of this file is about what is *not* an answer.
"""

from __future__ import annotations

import random

import pytest

from switch_core.bridges.collaboration.session.text import (
    AnswerPart,
    TextAnswer,
    parse_text_answer,
)


def _one(body: str) -> AnswerPart:
    """The single part of an answer that has exactly one."""
    answer = parse_text_answer(body)

    assert answer is not None, f"{body!r} was not read as an answer at all"
    assert len(answer.parts) == 1
    return answer.parts[0]


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
    assert answer.parts == (
        AnswerPart(question=None, options=(index,), custom_text=None),
    )
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
    assert answer.parts == ()
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


@pytest.mark.parametrize(
    "body",
    [
        "①",
        "²",
        "R42 ①",
        "R42 10²",
        "R42 ٤",
        "R42 " + "1" * 4400,
        "1" * 4400,
    ],
)
def test_something_shaped_like_a_number_does_not_take_the_message_with_it(
    body: str,
) -> None:
    """Refuse it, or don't, but never raise.

    The parser runs on every message a channel sends, so an exception out of it
    is a message the room never sees and nobody can account for. `int` refuses
    things `str` is happy to call numbers: "①" is a digit but not a decimal,
    and CPython converts at most 4300 decimals. Both swallowed the message
    rather than declining to read it as an answer.
    """
    answer = parse_text_answer(body)

    assert answer is None or answer.parts == (
        AnswerPart(question=None, options=(4,), custom_text=None),
    )


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


# ── More than one thing to answer ────────────────────────────────────────────


def test_several_options_at_once_where_the_card_allows_it() -> None:
    """Whether it is allowed is the record's call, not the grammar's."""
    assert _one("R43 1,3").options == (1, 3)
    assert _one("R43 1, 3").options == (1, 3)


def test_a_repeated_option_is_the_same_option() -> None:
    assert _one("R43 2,2").options == (2,)


@pytest.mark.parametrize(
    "body",
    [
        "R43 q1=2; q2=1,3",
        "R43 q1=2 q2=1,3",
        "R43 q1=2;q2=1,3",
        "R43 Q1: 2; Q2: 1,3",
        "R43 q1=2\nq2=1,3",
    ],
)
def test_a_part_per_question_however_it_was_separated(body: str) -> None:
    """A semicolon, a new line, or just the space before the next `qN=`.

    All five are what someone typing an answer to a form on a phone actually
    produces, and refusing four of them would leave the card's own instruction
    the only phrasing that works.
    """
    answer = parse_text_answer(body)

    assert answer is not None
    assert answer.handle == "R43"
    assert answer.parts == (
        AnswerPart(question=1, options=(2,), custom_text=None),
        AnswerPart(question=2, options=(1, 3), custom_text=None),
    )


def test_the_order_the_parts_were_typed_in_is_kept() -> None:
    """Which question each answer is for is said, not positional.

    Reordering them here would hide a form where the numbering and the order
    disagree, and that is exactly the case that must not resolve.
    """
    answer = parse_text_answer("R43 q2=1; q1=2")

    assert answer is not None
    assert [part.question for part in answer.parts] == [2, 1]


# ── An answer in words ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        'R43 q3="use staging"',
        "R43 q3='use staging'",
        "R43 q3=“use staging”",
        "R43 q3=‘use staging’",
        'R43 q3 = "use staging"',
    ],
)
def test_a_written_answer_is_quoted_however_the_keyboard_quoted_it(body: str) -> None:
    """A phone substitutes the curly pair without being asked.

    Someone doing exactly what the card told them to must not have their answer
    silently read as chatter because of which quote their keyboard produced.
    """
    assert _one(body) == AnswerPart(question=3, options=(), custom_text="use staging")


def test_a_written_answer_can_have_the_grammar_inside_it() -> None:
    """It is quoted so that the words in it stop being grammar."""
    assert _one('R43 q3="one, two; q1=4"').custom_text == "one, two; q1=4"


def test_a_written_answer_can_sit_beside_a_chosen_option() -> None:
    """The contract's `Answer` carries both, so the grammar has to reach both."""
    assert _one('R43 q3=1,"and something else"') == AnswerPart(
        question=3, options=(1,), custom_text="and something else"
    )


def test_one_question_that_is_answered_in_words_needs_no_number() -> None:
    assert _one('R43 "work/one-commit-migration"') == AnswerPart(
        question=None, options=(), custom_text="work/one-commit-migration"
    )


# ── What the wider grammar still refuses ─────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        "R43 q1=1; 2",
        "R43 2; q1=1",
        "R43 q1=1; q1=2",
        "R43 q0=1",
        'R43 q1="unclosed',
        'R43 q1=""',
        "R43 q1=",
        "R43 q1=,",
        "R43 q1=1,,2",
        "R43 q1=1; q2=",
        "R43 q1=one",
        "R43 that's the one; ship it",
        "R43 " + "; ".join(f"q{n}=1" for n in range(1, 30)),
        "R43 1," * 30,
        "R43 " + "x" * 600,
    ],
)
def test_a_form_answer_that_does_not_hold_together_is_not_an_answer(body: str) -> None:
    """Numbering some parts and not others, answering one question twice, an
    unclosed quote, an empty one, more parts than any card asks for, a message
    long enough to be prose. Each of them has a reading someone could argue
    for, and none of them is unambiguous enough to answer a question with.
    """
    assert parse_text_answer(body) is None


# ── The property that matters most ───────────────────────────────────────────


_ALPHABET = "R42q1 =;,:.-\"'“”‘’*_`~\n\t①٤²<>&/\\[]{}()!?#@x"


def test_nothing_made_out_of_the_grammar_can_take_a_message_with_it() -> None:
    """Every message a channel sends goes through this, ahead of the relay.

    So the parse raising is not a rejected answer, it is a message the room
    never sees and nobody can account for. Slice 4's grammar was two tokens and
    one integer and still had three of these; this one has quotes, separators
    and per-question parts, so it gets fuzzed over its own alphabet rather than
    over the examples someone thought to write down.

    The invariants are the ones the resolver relies on, so a parse that comes
    back malformed is caught here rather than as a crash further in.
    """
    generator = random.Random(20260908)

    for _ in range(20000):
        length = generator.randint(0, 48)
        body = "".join(generator.choice(_ALPHABET) for _ in range(length))

        answer = parse_text_answer(body)

        if answer is None:
            continue
        _assert_well_formed(answer, body)


def _assert_well_formed(answer: TextAnswer, body: str) -> None:
    because = f"parsed out of {body!r}"
    # A word or a selection, never both and never neither.
    assert (answer.decision is not None) != bool(answer.parts), because
    # Only the bare form names no request, and the bare form is always a word.
    assert answer.handle is not None or answer.decision is not None, because
    questions = [part.question for part in answer.parts]
    assert len(set(questions)) == len(questions), because
    assert len(questions) == 1 or None not in questions, because
    for part in answer.parts:
        assert part.options or part.custom_text, because
        assert all(1 <= option <= 99 for option in part.options), because
        assert len(set(part.options)) == len(part.options), because
