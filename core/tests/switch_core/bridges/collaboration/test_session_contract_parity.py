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

from switch_core.bridges.collaboration.session.contract import (
    Item,
    ServerEvent,
    Snapshot,
    parse_command,
    parse_host_event,
    parse_server_event,
    parse_snapshot,
)
from switch_core.bridges.collaboration.session.projection import SessionProjection

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"
EXAMPLES: dict[str, Any] = json.loads(EXAMPLES_PATH.read_text())


def initial() -> Snapshot:
    return parse_snapshot(EXAMPLES["initialSnapshot"])


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
            "audience": {"kind": "session-members"},
        }
    )


def event(sequence: int, body: Any) -> ServerEvent:
    return parse_server_event(
        {
            "contractVersion": 1,
            "eventId": f"event-{sequence}",
            "sessionId": "session-demo",
            "sequence": sequence,
            "occurredAt": "2026-09-07T12:00:00Z",
            "body": body if isinstance(body, dict) else body.model_dump(by_alias=True),
        }
    )


def item_upsert(value: Item) -> dict[str, Any]:
    return {"type": "item.upsert", "item": value.model_dump(by_alias=True)}


def test_validates_the_agreed_examples_and_settles_after_submitting() -> None:
    parse_command(EXAMPLES["platformAnswer"])
    parse_host_event(EXAMPLES["hostRequest"])

    projection = SessionProjection(initial())
    for update in EXAMPLES["answerLifecycle"]:
        projection.apply(parse_server_event(update))

    snapshot = projection.snapshot
    assert snapshot.requests[0].state == "resolved"
    assert snapshot.requests[0].decided_by is not None
    assert snapshot.requests[0].decided_by.surface == "mattermost"
    assert snapshot.session.pending_request_ids == []
    assert snapshot.command_statuses[0].status == "applied"


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


def test_replaces_text_ignores_replay_and_accepts_filtered_sequence_gaps() -> None:
    projection = SessionProjection(initial())
    projection.apply(event(12, item_upsert(item(1, "Hello"))))
    projection.apply(event(16, item_upsert(item(2, "Hello world"))))
    projection.apply(event(16, item_upsert(item(2, "Hello world"))))
    projection.apply(event(18, item_upsert(item(1, "Hello"))))

    assert len(projection.snapshot.items) == 1
    assert projection.snapshot.items[0].text == "Hello world"
    assert projection.through_sequence == 18


def test_rejects_conflicting_revisions_and_cross_session_replay() -> None:
    projection = SessionProjection(initial())
    projection.apply(event(11, item_upsert(item(1, "Hello"))))

    with pytest.raises(ValueError, match="Conflicting"):
        projection.apply(event(12, item_upsert(item(1, "Different"))))

    with pytest.raises(ValueError):
        projection.apply(
            parse_server_event(
                {
                    "contractVersion": 1,
                    "eventId": "event-12",
                    "sessionId": "another",
                    "sequence": 12,
                    "occurredAt": "2026-09-07T12:00:00Z",
                    "body": {
                        "type": "session.connectivity",
                        "connectivity": "offline",
                    },
                }
            )
        )

    assert projection.through_sequence == 11


def test_keeps_execution_state_on_connection_loss_and_closes_interruptions() -> None:
    projection = SessionProjection(initial())
    projection.apply(
        event(11, {"type": "session.connectivity", "connectivity": "offline"})
    )
    projection.apply(
        event(
            12,
            {
                "type": "request.settled",
                "requestId": "request-demo",
                "revision": 2,
                "outcome": "interrupted",
                "commandId": None,
                "result": None,
            },
        )
    )

    assert projection.snapshot.session.status == "running"
    assert projection.snapshot.requests[0].state == "closed"
    assert projection.snapshot.requests[0].decided_by is None
