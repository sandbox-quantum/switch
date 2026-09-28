"""Answering a set of questions, typed or pressed.

An answer to a form can be incomplete, and the contract does not stop it:
`answers: []` is a valid `QuestionsResult`, so a partial form would be accepted
by both ends and by the host, which has no way to ask again for the part it did
not get. So the refusal has to be here, and most of this file is that refusal.
"""

from __future__ import annotations

import json
import random
from typing import Any

from switch_core.bridges.collaboration.session.form import (
    Unanswerable,
    posted_form,
    resolve_pressed_option,
    resolve_text_answer,
)
from switch_core.bridges.collaboration.session.text import parse_text_answer
from switch_core.sessions.contract import (
    ApprovalResult,
    QuestionsResult,
)

from .session_fixtures import QUESTIONS_PATH, _approval_form, _questions_form
from .test_session_questions_cards import _form
from .test_session_text_grammar import _ALPHABET

CARD = "C1:111.0"

# The three-question form as its record: a single choice, as many as apply, and
# a question with nothing to number that is answered in words. The same shapes
# `examples.questions.json` records, and `test_the_record_is_the_card_the
# _fixture_describes` is what keeps the two in step.
FORM = _questions_form(
    ("q-scope", ["all", "one-package"], False, False),
    ("q-checks", ["unit", "types", "lint"], True, False),
    ("q-branch", [], False, True),
)


def _answer(body: str, form: dict[str, Any] | None = None) -> Any:
    """What a typed message comes to against a form. Never a parse of None."""
    parsed = parse_text_answer(body)
    assert parsed is not None, f"{body!r} was not read as an answer at all"
    return resolve_text_answer(FORM if form is None else form, parsed)


def _refusal(body: str, form: dict[str, Any] | None = None) -> str:
    resolved = _answer(body, form)
    assert isinstance(resolved, Unanswerable), f"{body!r} was answered: {resolved}"
    return resolved.reason


# ── A whole answer ───────────────────────────────────────────────────────────


def test_a_form_answered_in_full_is_the_shape_the_contract_records() -> None:
    """Field for field, the `QuestionsResult` in `examples.questions.json`."""
    recorded = json.loads(QUESTIONS_PATH.read_text())["platformFormAnswer"]

    resolved = _answer('R43 q1=1; q2=1,3; q3="work/one-commit-migration"')

    assert isinstance(resolved, QuestionsResult)
    assert resolved.model_dump(by_alias=True) == recorded["body"]["answer"]


def test_the_record_is_the_card_the_fixture_describes() -> None:
    """The form these tests answer is the one the renderer would have written.

    Written out above rather than derived, because a test that builds its
    fixture from the code under test proves only that the code agrees with
    itself. This is what stops the two drifting.
    """
    assert posted_form(_form()) == FORM


def test_the_same_answers_are_one_command_whichever_order_they_were_typed() -> None:
    """Two people can only race if they disagree.

    The same person saying the same thing twice — differently ordered because
    they retyped it — must not become two answers for the session to pick
    between.
    """
    first = _answer('R42 q1=1; q2=1,3; q3="b"')
    again = _answer('R42 q3="b"; q2=3,1; q1=1')

    assert isinstance(first, QuestionsResult)
    assert first == again


def test_options_are_recorded_in_the_order_the_card_offered_them() -> None:
    """Not the order they were typed: "1,3" and "3,1" are the same two checks."""
    resolved = _answer('R43 q1=1; q2=3,1; q3="branch"')

    assert isinstance(resolved, QuestionsResult)
    assert resolved.answers[1].selected_option_ids == ["unit", "lint"]


def test_a_question_can_be_answered_in_words_and_by_choosing() -> None:
    form = _questions_form(("q1", ["a", "b"], False, True))

    resolved = _answer('R43 2,"and the other thing"', form)

    assert isinstance(resolved, QuestionsResult)
    assert resolved.answers[0].selected_option_ids == ["b"]
    assert resolved.answers[0].custom_text == "and the other thing"


def test_one_question_needs_no_number_and_several_do() -> None:
    single = _questions_form(("q1", ["a", "b"], False, False))

    assert isinstance(_answer("R43 2", single), QuestionsResult)
    assert "so an answer has to say which" in _refusal("R43 2")


# ── A partial answer ─────────────────────────────────────────────────────────


def test_a_form_with_a_question_left_out_is_refused_and_says_which() -> None:
    """Neither schema forbids a partial answer, which is the whole problem.

    An answer that leaves a question out is indistinguishable from one that
    skips it deliberately, so nothing downstream can catch it: the host applies
    what it was given and never learns there was more. Refusing here costs the
    person a retype and is the only place it can be refused at all.
    """
    assert _refusal("R43 q1=1") == (
        "q2, q3 went unanswered, and every question needs an answer"
    )
    assert _refusal("R43 q2=1") == (
        "q1, q3 went unanswered, and every question needs an answer"
    )


def test_a_question_the_form_does_not_have_is_refused() -> None:
    assert "there is no q4" in _refusal('R43 q1=1; q2=1; q3="x"; q4=1')


def test_answering_one_question_twice_is_answering_it_at_all() -> None:
    """Refused by the grammar, before anything is looked up."""
    assert parse_text_answer("R43 q1=1; q1=2") is None


# ── An answer that does not fit the question ─────────────────────────────────


def test_two_options_where_the_question_takes_one_is_refused() -> None:
    """Not narrowed to the first. Someone who picked two meant two."""
    assert _refusal('R43 q1=1,2; q2=1; q3="x"') == (
        "q1 takes one option and 2 were given"
    )


def test_an_option_the_question_does_not_have_is_refused() -> None:
    assert _refusal('R43 q1=1; q2=9; q3="x"') == "q2 offers 3 options, not 9"


def test_words_where_the_question_does_not_invite_them_are_refused() -> None:
    assert _refusal('R43 q1="somewhere else"; q2=1; q3="x"') == (
        "q1 does not take a written answer"
    )


def test_a_number_on_a_question_with_nothing_to_number_is_refused() -> None:
    """`options: []` with `allowCustomAnswer` is a legal question and a real one."""
    assert _refusal("R43 q1=1; q2=1; q3=1") == "q3 offers 0 options, not 1"


def test_a_card_that_asks_nothing_cannot_be_answered_either() -> None:
    """Nothing is missing from an answer to no questions, which is the danger.

    Without this the whole-form check passes vacuously — no question went
    unanswered — and an empty `QuestionsResult` goes to the host, which applies
    it as though it were an answer. The card says the same thing at the other
    end: `questions: []` is a card with no way off.
    """
    empty: dict[str, Any] = {"kind": "questions", "questions": []}

    assert _refusal('R43 "anything"', empty) == (
        "that card asks no questions, so there is nothing to answer"
    )
    assert _refusal("R43 1", empty) == (
        "that card asks no questions, so there is nothing to answer"
    )


def test_a_word_answers_a_permission_and_not_a_question() -> None:
    """ "yes" names a decision, and a form has no decisions to name."""
    assert _refusal("R43 yes") == (
        "a word answers a permission request, and that card asks questions"
    )


def test_an_approval_does_not_take_the_form_grammar() -> None:
    """The two records are answered by the same parser and not by each other."""
    approval = _approval_form(("allow-once", "accept"), ("deny", "decline"))

    assert isinstance(_answer("R42 1", approval), ApprovalResult)
    assert "no numbered parts" in _refusal("R42 q1=1", approval)
    assert "not words" in _refusal('R42 "go on then"', approval)
    assert "takes one option and 2" in _refusal("R42 1,2", approval)


# ── A press ──────────────────────────────────────────────────────────────────


def test_a_press_on_a_single_question_form_answers_that_question() -> None:
    """The record says which result kind to build, so a press has to consult it."""
    form = _questions_form(("q-target", ["staging", "production"], False, False))

    resolved = resolve_pressed_option(form, "staging")

    assert isinstance(resolved, QuestionsResult)
    assert resolved.answers[0].question_id == "q-target"
    assert resolved.answers[0].selected_option_ids == ["staging"]
    assert resolved.answers[0].custom_text is None


def test_a_press_for_an_option_the_record_never_had_answers_nothing() -> None:
    """A control carries its own id, and the record is what says it was ours."""
    approval = _approval_form(("allow-once", "accept"))

    assert isinstance(resolve_pressed_option(approval, "something-else"), Unanswerable)


def test_a_press_on_a_question_asking_for_several_answers_nothing() -> None:
    """Checked here and not only where the card is drawn.

    The renderer offers no buttons on a multi-select question, so today the two
    agree. They are separate rules though, and this is the one that decides
    what gets sent: taking the press would submit one option as if it were the
    whole answer to a question asking for as many as apply.
    """
    form = _questions_form(("q-checks", ["unit", "types"], True, False))

    resolved = resolve_pressed_option(form, "unit")

    assert isinstance(resolved, Unanswerable)
    assert resolved.reason == (
        "a press is one option and that question takes as many as apply"
    )


# ── The property that matters most ───────────────────────────────────────────


_FORMS: list[dict[str, Any]] = [
    FORM,
    _approval_form(("allow-once", "accept"), ("deny", "decline")),
    _questions_form(("q1", ["a"], False, False)),
    _questions_form(("q1", [], False, True)),
    {"kind": "approval", "options": []},
    {"kind": "questions", "questions": []},
    {"kind": "questions", "questions": [{}]},
    {"kind": "approval", "options": "nonsense"},
    {"kind": "questions", "questions": [1, 2]},
    {"kind": "approval"},
    {"kind": "questions", "questions": [{"questionId": 7}]},
    {"kind": "something-else"},
    {},
]


def test_a_record_that_is_not_the_shape_this_layer_writes_is_refused_whole() -> None:
    """Not filtered down to the entries that do parse.

    Dropping the entries that are not records would shift every position after
    them, and a position is what an answer is made of: `q2=1` would land on a
    different question from the one the reader counted. Refusing the record is
    the only reading of it that cannot answer the wrong question.

    Unreachable from `posted_form` and from the backfill, both of which write
    lists of records. It is here because this runs ahead of the relay on every
    message, where the cost of `.get` on a string is not a refused answer but a
    message the room never sees.
    """
    for form in (
        {"kind": "approval", "options": "nonsense"},
        {"kind": "questions", "questions": [1, 2]},
        {"kind": "approval"},
    ):
        assert "is not a" in _refusal("R43 1", form)
        pressed = resolve_pressed_option(form, "unit")
        assert isinstance(pressed, Unanswerable)
        assert "is not a" in pressed.reason


def test_nothing_the_grammar_produces_can_take_a_message_with_it() -> None:
    """The other half of the parser's fuzz, over the same messages.

    Resolution runs on the same inbound path, ahead of the relay, so it has the
    same rule: a raise here is not a refused answer but a message the room
    never sees. Fuzzing the parse alone would miss it, because the crash would
    be one call further on and only against a record of the wrong shape.
    """
    generator = random.Random(20260908)

    for _ in range(4000):
        length = generator.randint(0, 48)
        body = "".join(generator.choice(_ALPHABET) for _ in range(length))
        parsed = parse_text_answer(body)
        if parsed is None:
            continue
        for form in _FORMS:
            resolved = resolve_text_answer(form, parsed)
            assert isinstance(
                resolved, ApprovalResult | QuestionsResult | Unanswerable
            ), f"{body!r} against {form}"


def test_a_press_against_any_record_refuses_rather_than_raises() -> None:
    for form in _FORMS:
        for option_id in ("all", "allow-once", "", "a", "unit"):
            resolved = resolve_pressed_option(form, option_id)
            assert isinstance(
                resolved, ApprovalResult | QuestionsResult | Unanswerable
            ), f"{option_id!r} against {form}"
