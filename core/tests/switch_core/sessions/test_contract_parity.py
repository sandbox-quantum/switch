"""The session contract, read from Python, against the agreed examples.

Switch reads this wire format twice: once in TypeScript, for Switch Console and
the agent runtime, and once here, for the collaboration bridges. The two are
separate implementations in separate languages reading the same
`examples.json`, and they only stay in step deliberately — a divergence fails
nowhere on its own, it just renders the wrong thing in a room, or rejects a
message the other end considers valid.

The TypeScript half of these cases lives in
`console/packages/shared/src/session-v1/session-v1.test.ts`; the assertions
here are chosen to match it. Its client-side cases (`SessionChatClient`,
`advanceCursor`, `recordReceipt`) have no Python counterpart yet: the bridges
read a session, they do not yet submit commands to one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from switch_core.sessions.contract import (
    Item,
    event_bytes,
    parse_command,
    parse_host_event,
    parse_server_event,
    parse_snapshot,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"
EXAMPLES: dict[str, Any] = json.loads(EXAMPLES_PATH.read_text())

QUESTIONS_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.questions.json"
)
QUESTIONS: dict[str, Any] = json.loads(QUESTIONS_PATH.read_text())


def item(revision: int, text: str) -> Item:
    return Item.model_validate(
        {
            "itemId": "assistant",
            "turnId": "turn-demo",
            "revision": revision,
            "kind": "assistant-message",
            "status": "in-progress",
            "title": "",
            "text": text,
            "attachments": [],
            "origin": None,
        }
    )


def test_validates_the_agreed_examples() -> None:
    parse_command(EXAMPLES["platformAnswer"])
    parse_host_event(EXAMPLES["hostRequest"])
    parse_snapshot(EXAMPLES["initialSnapshot"])
    for update in EXAMPLES["answerLifecycle"]:
        parse_server_event(update)


def test_rejects_raw_data_reasoning_items_unsafe_counters_and_oversized_events() -> (
    None
):
    with pytest.raises(ValueError):
        parse_host_event(
            {**EXAMPLES["hostRequest"], "raw": {"secret": "must not publish"}}
        )

    with pytest.raises(ValueError):
        parse_server_event(
            {
                "contractVersion": 1,
                "eventId": "event-11",
                "sessionId": "session-demo",
                "sequence": 11,
                "occurredAt": "2026-09-07T12:00:00Z",
                "body": {
                    "type": "item.upsert",
                    "item": {
                        **item(1, "").model_dump(by_alias=True),
                        "kind": "reasoning",
                    },
                },
            }
        )

    with pytest.raises(ValueError):
        parse_server_event(
            {
                "contractVersion": 1,
                "eventId": "event-11",
                "sessionId": "session-demo",
                "sequence": 9007199254740992,
                "occurredAt": "2026-09-07T12:00:00Z",
                "body": {"type": "session.connectivity", "connectivity": "online"},
            }
        )

    with pytest.raises(ValueError, match="PAYLOAD_TOO_LARGE"):
        parse_host_event(
            {
                **EXAMPLES["hostRequest"],
                "body": {
                    "type": "notice",
                    "level": "info",
                    "code": "OUTPUT",
                    "message": "x" * 65536,
                },
            }
        )


def test_the_size_cap_counts_the_bytes_the_host_counted() -> None:
    """No TypeScript counterpart: it is Python's defaults that differ.

    The host counts UTF-8 of `JSON.stringify`. `json.dumps` escapes non-ASCII
    unless told not to, which makes an emoji twelve bytes rather than four, and
    an event the host sent well inside the cap would be refused here.
    """
    assert event_bytes({"a": "😀"}) == len('{"a":"😀"}'.encode())

    within_the_cap = {
        **EXAMPLES["hostRequest"],
        "body": {
            "type": "notice",
            "level": "info",
            "code": "OUTPUT",
            "message": "😀" * 10000,
        },
    }

    assert event_bytes(within_the_cap) < 65536
    parse_host_event(within_the_cap)


# ── The shapes `examples.json` has no case for ───────────────────────────────


def test_validates_the_recorded_questions_and_settles_the_form() -> None:
    """`examples.questions.json`, through the same parsers as its neighbour.

    One-sided, unlike everything above it: `session-v1.test.ts` is lifted from
    the contract's own repository and stays byte-identical, so a case added
    here cannot be added there. That makes this weaker evidence than the rest
    of the file — it says the Python reader accepts these shapes, not that both
    readers agree on them. When the contract repository grows a questions
    example, this fixture is what its counterpart should replace.
    """
    parse_command(QUESTIONS["platformFormAnswer"])
    parse_host_event(QUESTIONS["hostQuestions"])

    parse_snapshot(QUESTIONS["initialSnapshot"])
    settled = next(
        body
        for body in (
            parse_server_event(update).body
            for update in QUESTIONS["formAnswerLifecycle"]
        )
        if body.type == "request.settled"
    )
    assert settled.request_id == "request-form"
    assert settled.result is not None
    assert [answer.question_id for answer in settled.result.answers] == [
        "q-scope",
        "q-checks",
        "q-branch",
    ]


def test_a_question_with_no_options_still_has_to_invite_an_answer() -> None:
    """`options: []` is only a question at all because words are allowed.

    Nothing can be numbered and nothing can be pressed, so a form that also
    refused a written answer would be a card with no way to complete it and no
    way to say so.
    """
    snapshot = parse_snapshot(QUESTIONS["initialSnapshot"])
    written = snapshot.requests[0].content.questions[2]  # type: ignore[union-attr]

    assert written.options == []
    assert written.allow_custom_answer is True


def test_host_publication_claims_are_rejected() -> None:
    payload = json.loads(json.dumps(EXAMPLES["hostRequest"]))
    payload["body"]["request"]["audience"] = {"kind": "room", "roomId": "room-demo"}
    with pytest.raises(ValueError):
        parse_host_event(payload)
