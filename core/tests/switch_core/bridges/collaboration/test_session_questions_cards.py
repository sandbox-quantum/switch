"""A set of questions, from the recorded fixture to a Slack card.

`test_session_slack_requests.py` is the same journey for an approval. What
differs here is that a form is mostly not pressable: a card can offer controls
only where a single press finishes the answer, so everything else has to be
answerable in words, and the card has to say how in words the parser accepts.

The fixtures are `examples.questions.json`, beside `examples.json` because that
file is agreed wire evidence between the two implementations and stays as it
was recorded. This one has the shapes it has no case for.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.session.contract import (
    Question,
    QuestionOption,
    SnapshotRequest,
)
from switch_core.bridges.collaboration.session.form import (
    Unanswerable,
    posted_form,
    resolve_text_answer,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_questions,
    render_questions_text,
    render_request,
)
from switch_core.bridges.collaboration.session.text import parse_text_answer
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)

REPO_ROOT = Path(__file__).resolve().parents[5]
QUESTIONS_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.questions.json"
)

FORM = RequestReference(token="opaque-token", handle="R43")
ONE = RequestReference(token="opaque-token", handle="R44")


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _requests(*events: str) -> dict[str, SnapshotRequest]:
    source = FixtureEventSource.from_examples(QUESTIONS_PATH, events=events)
    projection = _run(project(source, "session-questions"))
    return {
        request.request_id: request
        for request in projection.snapshot.requests
        if request.audience.kind == "room"
    }


def _form() -> SnapshotRequest:
    """The three-question form: single-select, multi-select, and words."""
    return _requests()["request-form"]


def _one_question() -> SnapshotRequest:
    """The shape a single press can finish."""
    return _requests()["request-one"]


def _sections(blocks: list[dict[str, Any]]) -> list[str]:
    return [block["text"]["text"] for block in blocks if block["type"] == "section"]


def _footer(blocks: list[dict[str, Any]]) -> str:
    context = next(block for block in blocks if block["type"] == "context")
    return str(context["elements"][0]["text"])


def _actions(blocks: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next((block for block in blocks if block["type"] == "actions"), None)


# ── What the card shows ──────────────────────────────────────────────────────


def test_every_question_is_numbered_and_so_are_its_own_options() -> None:
    """Two numberings, and an answer is made of both.

    The questions count from 1 across the form and the options count from 1
    within each question, which is what makes `q2=1,3` mean anything. Getting
    either of them out of step with the record would answer a different
    question from the one the reader is looking at.
    """
    blocks = render_questions(_form(), FORM).blocks
    sections = _sections(blocks)

    assert sections[0] == "*Questions*\nBefore I start the migration"
    assert sections[1].startswith("*1. How much should I migrate?*")
    assert "1. All 14 call sites" in sections[1]
    assert "2. The first package only" in sections[1]
    assert sections[2].startswith("*2. Which checks should run before I push?*")
    assert "1. Unit tests" in sections[2]
    assert "3. Lint" in sections[2]
    assert sections[3].startswith("*3. What should the branch be called?*")


def test_an_option_description_is_shown_beside_the_option_it_describes() -> None:
    """It is the difference between the two choices, so it is not decoration."""
    sections = _sections(render_questions(_form(), FORM).blocks)

    assert "All 14 call sites — One commit, nothing left half migrated." in sections[1]


def test_the_form_that_cannot_be_pressed_offers_nothing_to_press() -> None:
    """Several questions, so no single press could ever finish the answer.

    Half-pressed controls with nothing holding the draft would submit whichever
    part was pressed last as if it were the whole form.
    """
    assert _actions(render_questions(_form(), FORM).blocks) is None


def test_one_question_with_one_choice_is_pressable() -> None:
    """The one shape where a press is a complete answer, so it gets buttons."""
    actions = _actions(render_questions(_one_question(), ONE).blocks)

    assert actions is not None
    assert [element["action_id"] for element in actions["elements"]] == [
        "switch:request-answer:staging",
        "switch:request-answer:production",
    ]
    assert {element["value"] for element in actions["elements"]} == {"opaque-token"}


def test_a_multi_select_question_is_not_pressable_even_on_its_own() -> None:
    """One press is one option, and the question is asking for as many as apply."""
    request = _amend(_one_question(), multi_select=True)

    assert _actions(render_questions(request, ONE).blocks) is None


def test_the_card_carries_nothing_that_names_the_session() -> None:
    """Same rule as the approval card: the token is the only handle Slack gets."""
    rendered = json.dumps(render_questions(_form(), FORM).blocks)

    assert "session-questions" not in rendered
    assert "epoch-questions" not in rendered


# ── What the card tells you to type ──────────────────────────────────────────


@pytest.mark.parametrize("named", ["form", "one"])
def test_the_example_on_the_card_parses_and_answers_that_card(named: str) -> None:
    """The instruction, the grammar and the record are one claim.

    Whatever the footer offers to copy has to come back through the parser as
    an answer, and that answer has to resolve against the form the same card
    was drawn from. This is the test the approval card did not have, and it is
    exactly what the missing one would have caught: an example that reads
    perfectly well and parses as nothing.
    """
    request, reference = (_form(), FORM) if named == "form" else (_one_question(), ONE)

    footer = _footer(render_questions(request, reference).blocks)
    example = re.search(r"`([^`]+)`", footer)

    assert example is not None, f"the card offers no example to copy: {footer}"
    answer = parse_text_answer(example.group(1))
    assert answer is not None, f"the card's own instruction does not parse: {footer}"

    resolved = resolve_text_answer(posted_form(request), answer)
    assert not isinstance(resolved, Unanswerable), resolved


def test_the_example_says_which_question_only_when_there_is_more_than_one() -> None:
    """A form of one question takes a bare number, and saying `q1=` would be noise."""
    assert "Reply with `R44 1`, or press a button." == _footer(
        render_questions(_one_question(), ONE).blocks
    )
    assert _footer(render_questions(_form(), FORM).blocks) == (
        'Reply with `R43 q1=1; q2=1,2; q3="your answer"` — '
        "every question needs an answer."
    )


def test_a_question_with_nothing_to_number_is_shown_as_words_to_write() -> None:
    """There is no option 1 on it, so an example offering one would be a lie."""
    request = _amend(_one_question(), options=[])

    assert 'Reply with `R44 "your answer"`.' == _footer(
        render_questions(request, ONE).blocks
    )


# ── The text fallback ────────────────────────────────────────────────────────


def test_the_text_form_carries_the_whole_question_and_the_card_agrees() -> None:
    message = render_questions(_form(), FORM)

    assert message.text == render_questions_text(_form(), FORM)
    assert message.text.startswith("> Request R43: Before I start the migration")
    assert "*2. Which checks should run before I push?*" in message.text
    assert "3. Lint" in message.text


def test_an_option_the_card_had_no_room_for_is_still_in_the_text() -> None:
    """Slack rejects a section over 3000 characters and drops the whole post.

    So a long list is cut on the card and said to be cut, and the message text
    — which has room — keeps every option. The numbering does not shift either
    way, because a number is what an answer is made of.
    """
    crowded = _amend(
        _one_question(),
        options=[
            QuestionOption(option_id=f"o{index}", label="L" * 140, description=None)
            for index in range(1, 26)
        ],
    )

    section = _sections(render_questions(crowded, ONE).blocks)[1]
    text = render_questions_text(crowded, ONE)

    assert len(section) <= 3000
    assert "_…and 7 more, numbered 19 up. Answer by number._" in section
    assert "18. " + "L" * 140 in section
    assert "19. " + "L" * 140 not in section
    assert "19. " + "L" * 140 in text
    assert "25. " + "L" * 140 in text


def test_more_questions_than_a_card_can_show_is_refused_rather_than_posted() -> None:
    """Unlike an option, a question that is not shown cannot be worked around.

    Every question has to be answered for the answer to be sent at all, so a
    form with one missing is a card nobody can complete. Fail where the number
    can still be named.
    """
    crowded = _amend_questions(
        _form(),
        [
            Question(
                question_id=f"q{index}",
                title="Which?",
                prompt="",
                options=[QuestionOption(option_id="a", label="A", description=None)],
                multi_select=False,
                allow_custom_answer=False,
            )
            for index in range(21)
        ],
    )

    with pytest.raises(ValueError, match="21 questions"):
        render_questions(crowded, FORM)


# ── Once it has been answered ────────────────────────────────────────────────


def test_a_settled_form_says_what_was_answered_and_by_whom() -> None:
    request = _requests("formAnswerLifecycle")["request-form"]

    footer = _footer(render_questions(request, FORM).blocks)

    assert request.state == "resolved"
    assert "How much should I migrate?: All 14 call sites" in footer
    assert "Which checks should run before I push?: Unit tests, Lint" in footer
    assert "What should the branch be called?: “work/one-commit-migration”" in footer
    assert "answered by actor-demo from Slack" in footer


def test_a_settled_form_stops_asking() -> None:
    """A card still showing its questions is a card inviting a lost answer."""
    request = _requests("formAnswerLifecycle")["request-form"]

    blocks = render_questions(request, FORM).blocks

    assert _actions(blocks) is None
    assert len(_sections(blocks)) == 1


# ── Which renderer a request gets ────────────────────────────────────────────


def test_a_request_is_drawn_by_the_kind_of_thing_it_asks() -> None:
    """One entry point, because the card that gets edited is not told apart by
    its caller: a request opens as one kind and stays that kind, and the
    refresh path only has the request."""
    assert (
        render_request(_form(), FORM).blocks == render_questions(_form(), FORM).blocks
    )


# ── Escaping ─────────────────────────────────────────────────────────────────


def test_nothing_a_question_carries_can_forge_slack_markup() -> None:
    """A question's title, prompt, labels and descriptions are all agent text."""
    forgery = "<!channel> & <https://example.test|click>"
    request = _amend(
        _one_question(),
        title=forgery,
        prompt=forgery,
        options=[
            QuestionOption(option_id="a", label=forgery, description=forgery),
        ],
    )

    message = render_questions(request, ONE)
    parsed = json.dumps(_sections(message.blocks) + [_footer(message.blocks)])

    assert "<!channel>" not in parsed
    assert "&lt;!channel&gt;" in parsed
    assert "<!channel>" not in message.text
    # A button's label is `plain_text`, which Slack does not parse, so escaping
    # one would show the reader the entity instead of the character.
    actions = _actions(message.blocks)
    assert actions is not None
    assert actions["elements"][0]["text"]["text"].startswith("<!channel>")


# ── Fixture surgery ──────────────────────────────────────────────────────────


def _amend(request: SnapshotRequest, **fields: Any) -> SnapshotRequest:
    """The same request with one question changed. Only for single-question ones."""
    question = request.content.questions[0]  # type: ignore[union-attr]
    return _amend_questions(request, [question.model_copy(update=fields)])


def _amend_questions(
    request: SnapshotRequest, questions: list[Question]
) -> SnapshotRequest:
    content = request.content.model_copy(update={"questions": questions})
    return request.model_copy(update={"content": content})
