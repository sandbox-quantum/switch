"""What a card offered, and what an answer to it comes to.

A pressed button hands back the id of the control it is. A typed answer hands
back numbers: "1" is the first thing on the card the person is looking at, and
nothing else in Switch holds what that was. So the row for a posted card keeps
the form it rendered, in render order, and both ways of answering resolve
against that rather than against whatever the request has since become.

The record is discriminated by `kind`, and `kind` is read rather than inferred
from which other key happens to be present. The two ends of a request are not
the same shape — an approval takes one option and a questions form takes an
answer per question — so a card whose record does not say which it is cannot be
answered at all, and saying so is better than guessing from a list of options
that both kinds could plausibly have.

Writing the record and reading it back live together here for the same reason:
they are one agreement about a JSON shape, and a disagreement between them
would put an answer against the wrong question with nothing to report it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .contract import (
    Answer,
    ApprovalContent,
    ApprovalResult,
    QuestionsContent,
    QuestionsResult,
    RequestResult,
    SnapshotRequest,
)
from .text import AnswerPart, TextAnswer


@dataclass(frozen=True)
class Unanswerable:
    """Why an answer does not fit the card it was given to.

    A refusal rather than a failure: it is logged and the message carries on to
    the room. `reason` finishes the sentence "…, because", so it is written to
    be read by whoever is looking at the log rather than by whoever typed.
    """

    reason: str


def posted_form(request: SnapshotRequest) -> dict[str, Any]:
    """What the card for `request` offers, in the order it offers it."""
    content = request.content
    if isinstance(content, ApprovalContent):
        return {
            "kind": "approval",
            "options": [
                {"optionId": option.option_id, "decision": option.decision}
                for option in content.options
            ],
        }
    if isinstance(content, QuestionsContent):
        return {
            "kind": "questions",
            "questions": [
                {
                    "questionId": question.question_id,
                    "optionIds": [option.option_id for option in question.options],
                    "multiSelect": question.multi_select,
                    "allowCustomAnswer": question.allow_custom_answer,
                }
                for question in content.questions
            ],
        }
    raise ValueError(f"Request {request.request_id} is a {content.kind}, not a form.")


def takes_a_bare_decision(form: dict[str, Any]) -> bool:
    """Whether "yes" on its own could ever answer this card.

    Only an approval has a decision for a word to name. Asked before the work
    of deciding whether a message is the first reply to the card, because that
    work is a call to the platform and a questions card refuses regardless.
    """
    return form.get("kind") == "approval"


def resolve_pressed_option(
    form: dict[str, Any], option_id: str
) -> RequestResult | Unanswerable:
    """The answer a pressed control stands for, checked against the record.

    A control carries its own id and the bridge wrote it, but the result it
    belongs in is the record's to say: the same press means one thing on an
    approval and another on a form that asks one question.
    """
    kind = form.get("kind")
    if kind == "approval":
        if option_id not in {option.get("optionId") for option in _options(form)}:
            return Unanswerable(
                f"{option_id!r} is not one of the options that card offered"
            )
        return ApprovalResult(kind="approval", option_id=option_id)
    if kind == "questions":
        questions = _questions(form)
        if len(questions) != 1:
            # Nothing renders a control on a longer form, so a press against
            # one is a card from before this rule or a payload that was not
            # ours. Either way there is no question to attach the answer to.
            return Unanswerable(
                f"a press answers one question and that card asks {len(questions)}"
            )
        question = questions[0]
        question_id = question.get("questionId")
        if not isinstance(question_id, str):
            return Unanswerable("the record for that card names no question")
        if option_id not in (question.get("optionIds") or []):
            return Unanswerable(
                f"{option_id!r} is not one of the options that question offered"
            )
        return QuestionsResult(
            kind="questions",
            answers=[
                Answer(
                    question_id=question_id,
                    selected_option_ids=[option_id],
                    custom_text=None,
                )
            ],
        )
    return _unknown(kind)


def resolve_text_answer(
    form: dict[str, Any], answer: TextAnswer
) -> RequestResult | Unanswerable:
    """The answer a typed message comes to, against the form that was posted."""
    kind = form.get("kind")
    if kind == "approval":
        return _approval_answer(form, answer)
    if kind == "questions":
        return _questions_answer(form, answer)
    return _unknown(kind)


def _approval_answer(
    form: dict[str, Any], answer: TextAnswer
) -> RequestResult | Unanswerable:
    """One of the options, by position or by the word that names its decision.

    A word is the one option whose decision it names, and only when there is
    exactly one: `acceptForSession` and `cancel` are reachable by number alone,
    because "yes" must never quietly grant a permission for the rest of a
    session.
    """
    options = _options(form)
    if answer.decision is not None:
        matching = [
            option for option in options if option.get("decision") == answer.decision
        ]
        if len(matching) != 1:
            return Unanswerable(
                f"{len(matching)} of the options on that card mean "
                f"{answer.decision!r}, so the word names none of them"
            )
        return _picked(matching[0])

    if len(answer.parts) != 1:
        return Unanswerable(
            f"an approval takes one answer and {len(answer.parts)} were given"
        )
    part = answer.parts[0]
    if part.question is not None:
        return Unanswerable("an approval asks one thing, so it has no numbered parts")
    if part.custom_text is not None:
        return Unanswerable("an approval takes one of its options, not words")
    if len(part.options) != 1:
        return Unanswerable(
            f"an approval takes one option and {len(part.options)} were given"
        )
    index = part.options[0]
    if index > len(options):
        return Unanswerable(f"that card offered {len(options)} options, not {index}")
    return _picked(options[index - 1])


def _picked(option: dict[str, Any]) -> ApprovalResult | Unanswerable:
    option_id = option.get("optionId")
    if not isinstance(option_id, str):
        return Unanswerable("the record for that option names no option")
    return ApprovalResult(kind="approval", option_id=option_id)


def _questions_answer(
    form: dict[str, Any], answer: TextAnswer
) -> RequestResult | Unanswerable:
    """An answer per question, and only when there is one for every question.

    A partial form is refused rather than sent. Neither end of the contract
    forbids one, and that is the problem: an answer that leaves a question out
    is indistinguishable from one that skips it deliberately, and the host has
    no way to ask again for the part it did not get.
    """
    questions = _questions(form)
    if answer.decision is not None:
        return Unanswerable(
            "a word answers a permission request, and that card asks questions"
        )

    given = _by_question(questions, answer.parts)
    if isinstance(given, Unanswerable):
        return given
    missing = [
        f"q{position}"
        for position in range(1, len(questions) + 1)
        if position not in given
    ]
    if missing:
        return Unanswerable(
            f"{', '.join(missing)} went unanswered, and every question needs an answer"
        )

    answers: list[Answer] = []
    for position, question in enumerate(questions, start=1):
        resolved = _one_answer(position, question, given[position])
        if isinstance(resolved, Unanswerable):
            return resolved
        answers.append(resolved)
    return QuestionsResult(kind="questions", answers=answers)


def _by_question(
    questions: list[dict[str, Any]], parts: tuple[AnswerPart, ...]
) -> dict[int, AnswerPart] | Unanswerable:
    """The typed parts, against the questions they name.

    A part naming no question is only an answer to a card that asks exactly
    one, which is what makes "R43 1" work on a single question and refuse on a
    form where it would land against whichever question came first.
    """
    given: dict[int, AnswerPart] = {}
    for part in parts:
        position = part.question
        if position is None:
            if len(questions) != 1:
                return Unanswerable(
                    f"that card asks {len(questions)} questions, so an answer has "
                    "to say which, like `q1=1`"
                )
            position = 1
        if position > len(questions):
            return Unanswerable(
                f"that card asks {len(questions)} questions, so there is no q{position}"
            )
        given[position] = part
    return given


def _one_answer(
    position: int, question: dict[str, Any], part: AnswerPart
) -> Answer | Unanswerable:
    # Read with defaults rather than by key: this runs on the inbound path of
    # every message, so a record written before a key existed has to come back
    # as a refusal and not as a `KeyError` that loses the message.
    question_id = question.get("questionId")
    if not isinstance(question_id, str):
        return Unanswerable(f"the record for q{position} names no question")
    option_ids = list(question.get("optionIds") or [])
    if len(part.options) > 1 and not question.get("multiSelect"):
        return Unanswerable(
            f"q{position} takes one option and {len(part.options)} were given"
        )
    if part.custom_text is not None and not question.get("allowCustomAnswer"):
        return Unanswerable(f"q{position} does not take a written answer")
    for index in part.options:
        if index > len(option_ids):
            return Unanswerable(
                f"q{position} offers {len(option_ids)} options, not {index}"
            )
    # In the card's order rather than the order they were typed, so that
    # picking the same two options is one answer and one command whichever way
    # round the person said them.
    picked = set(part.options)
    selected = [
        option_id
        for index, option_id in enumerate(option_ids, start=1)
        if index in picked
    ]
    if not selected and part.custom_text is None:
        return Unanswerable(f"q{position} was named and then not answered")
    return Answer(
        question_id=question_id,
        selected_option_ids=selected,
        custom_text=part.custom_text,
    )


def _options(form: dict[str, Any]) -> list[dict[str, Any]]:
    return list(form.get("options") or [])


def _questions(form: dict[str, Any]) -> list[dict[str, Any]]:
    return list(form.get("questions") or [])


def _unknown(kind: object) -> Unanswerable:
    return Unanswerable(f"the record calls that card a {kind!r}, which answers nothing")
