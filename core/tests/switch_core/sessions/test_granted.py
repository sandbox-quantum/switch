"""Whether a settled request is one the person said yes to.

`granted` is what decides that an approval card has served its purpose and can
be taken off the platform, so it is the one place a wrong answer costs
something irreversible: a card removed on a refusal is a refusal nobody can
read afterwards. Everything here is about the ways a settled request can look
finished without being a yes.
"""

from __future__ import annotations

import pytest

from switch_core.sessions.contract import SnapshotRequest, granted

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


@pytest.mark.parametrize("option_id", ["once", "session"])
def test_both_ways_of_saying_yes_are_a_grant(option_id: str) -> None:
    """One turn's permission and the session's are the same answer to the
    question the card asked, and the card has no further use after either."""
    assert granted(_answered(option_id)) is True


@pytest.mark.parametrize("option_id", ["no", "stop"])
def test_the_answers_that_are_not_yes_are_not_grants(option_id: str) -> None:
    """`outcome` is "answered" for a refusal too, so the outcome alone would
    remove the record of every decline ever made."""
    assert granted(_answered(option_id)) is False


def test_an_option_the_request_never_offered_decides_nothing() -> None:
    """A host naming an option that is not on the card is a host saying
    something we cannot read. The safe reading of an unreadable answer is that
    consent was not established — so the card stays and can be read by hand."""
    assert granted(_answered("invented")) is False


@pytest.mark.parametrize("outcome", ["cancelled", "expired", "interrupted"])
def test_a_request_that_ended_without_an_answer_is_not_a_grant(outcome: str) -> None:
    assert granted(_request(state="closed", outcome=outcome, result=None)) is False


def test_a_provider_error_is_not_a_grant() -> None:
    """The one outcome that could plausibly carry a stale result alongside a
    failure, and the failure is what it settled as."""
    assert (
        granted(
            _request(
                state="closed",
                outcome="provider-error",
                result={"kind": "approval", "optionId": "once"},
            )
        )
        is False
    )


def test_an_answer_the_host_never_described_is_not_a_grant() -> None:
    """Answered, with nothing said about what the answer was. The settled card
    already has to print "the host did not say which option was chosen"; it
    must not be deleted on the strength of it."""
    assert granted(_request(state="resolved", outcome="answered", result=None)) is False


@pytest.mark.parametrize("state", ["open", "submitting"])
def test_a_request_still_in_flight_is_not_a_grant(state: str) -> None:
    """`submitting` carries a chosen option before the host has confirmed it.
    Taking the card away then would delete a question still being asked, on
    the strength of a press rather than a decision."""
    assert (
        granted(
            _request(
                state=state,
                outcome="answered",
                result={"kind": "approval", "optionId": "once"},
            )
        )
        is False
    )


def test_a_questions_answer_to_an_approval_is_not_a_grant() -> None:
    """The two result shapes are discriminated on the wire but nothing makes
    the pairing match its content, and an answer of the wrong kind says
    nothing about the approval it arrived against."""
    assert (
        granted(
            _request(
                state="resolved",
                outcome="answered",
                result={"kind": "questions", "answers": []},
            )
        )
        is False
    )


def test_a_question_is_not_an_approval_however_it_settles() -> None:
    """Only an approval can be granted. A form that has been filled in is
    finished, not consented to, and its card is the record of the answers."""
    assert (
        granted(
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
