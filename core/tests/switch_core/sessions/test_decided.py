"""Whether a settled request is one a person actually answered.

`decided` is what decides that a permission card has served its purpose and
can be taken off the platform, so it is the one place a wrong answer costs
something irreversible: a card removed on a request nobody answered is a
question deleted while it was still being asked. Everything here is about the
ways a settled request can look answered without one having been given.

Which way the answer went is deliberately not asked. A refusal ends the card's
usefulness exactly as a grant does, and the decision itself lives in the
session, in Console and in the row that outlives the card. Cancelling is the
one option that is not an answer to the question, and it keeps its card.
"""

from __future__ import annotations

import pytest

from switch_core.sessions.contract import SnapshotRequest, decided

OPTIONS = [
    {"optionId": "once", "label": "Allow once", "decision": "accept"},
    {"optionId": "session", "label": "Allow", "decision": "acceptForSession"},
    {"optionId": "no", "label": "Deny", "decision": "decline"},
    {"optionId": "stop", "label": "Cancel", "decision": "cancel"},
]


def _request(
    *,
    state: str,
    outcome: str | None,
    result: dict | None,
    content: dict | None = None,
) -> SnapshotRequest:
    return SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 2,
            "state": state,
            "expiresAt": None,
            "content": content
            or {
                "kind": "approval",
                "title": "Run project tests",
                "detail": "pnpm test",
                "options": OPTIONS,
            },
            "result": (
                None
                if outcome is None
                else {
                    "type": "request.settled",
                    "requestId": "req-1",
                    "revision": 2,
                    "outcome": outcome,
                    "commandId": "cmd-1",
                    "result": result,
                }
            ),
            "decidedBy": None,
        }
    )


def _answered(option_id: str) -> SnapshotRequest:
    return _request(
        state="resolved",
        outcome="answered",
        result={"kind": "approval", "optionId": option_id},
    )


@pytest.mark.parametrize("option_id", ["once", "session", "no"])
def test_a_yes_and_a_no_both_answer_the_card(option_id: str) -> None:
    """Yes for this turn, yes for the session, and no. Each is somebody
    answering the question the card asked, and the card has no further use
    after any of them — the decision itself is kept elsewhere."""
    assert decided(_answered(option_id)) is True


def test_cancelling_the_operation_is_not_answering_the_card() -> None:
    """The fourth option is not a fourth answer. `cancel` stops what was being
    asked about rather than permitting or refusing it, and its card is the
    only thing in the channel that says where the run was halted. Widening the
    rule to cover it is a product decision, not a reading of this one."""
    assert decided(_answered("stop")) is False


def test_an_option_the_request_never_offered_decides_nothing() -> None:
    """A host naming an option that is not on the card is a host saying
    something we cannot read. The safe reading of an unreadable answer is that
    nothing was decided — so the card stays and can be read by hand."""
    assert decided(_answered("invented")) is False


@pytest.mark.parametrize("outcome", ["cancelled", "expired", "interrupted"])
def test_a_request_that_ended_without_an_answer_is_not_decided(outcome: str) -> None:
    assert decided(_request(state="closed", outcome=outcome, result=None)) is False


def test_a_provider_error_is_not_a_decision() -> None:
    """The one outcome that could plausibly carry a stale result alongside a
    failure, and the failure is what it settled as."""
    assert (
        decided(
            _request(
                state="closed",
                outcome="provider-error",
                result={"kind": "approval", "optionId": "once"},
            )
        )
        is False
    )


def test_an_answer_the_host_never_described_is_not_a_decision() -> None:
    """Answered, with nothing said about what the answer was. The settled card
    already has to print "the host did not say which option was chosen"; it
    must not be deleted on the strength of it."""
    assert decided(_request(state="resolved", outcome="answered", result=None)) is False


@pytest.mark.parametrize("state", ["open", "submitting"])
def test_a_request_still_in_flight_is_not_decided(state: str) -> None:
    """`submitting` carries a chosen option before the host has confirmed it.
    Taking the card away then would delete a question still being asked, on
    the strength of a press rather than a confirmed answer."""
    assert (
        decided(
            _request(
                state=state,
                outcome="answered",
                result={"kind": "approval", "optionId": "once"},
            )
        )
        is False
    )


def test_a_questions_answer_to_an_approval_decides_nothing() -> None:
    """The two result shapes are discriminated on the wire but nothing makes
    the pairing match its content, and an answer of the wrong kind says
    nothing about the approval it arrived against."""
    assert (
        decided(
            _request(
                state="resolved",
                outcome="answered",
                result={"kind": "questions", "answers": []},
            )
        )
        is False
    )


def test_a_question_is_not_an_approval_however_it_settles() -> None:
    """Only a permission card is taken back. A form that has been filled in is
    finished, and its card is the only record of the answers."""
    assert (
        decided(
            _request(
                state="resolved",
                outcome="answered",
                result={"kind": "questions", "answers": []},
                content={
                    "kind": "questions",
                    "title": "Which suite?",
                    "questions": [],
                },
            )
        )
        is False
    )
