"""Contract objects read out of the recorded session fixtures.

The fixtures are the `examples*.json` files the TypeScript side tests against.
Only the pieces the renderers and adapters take are built here: a request as a
snapshot holds it, and the items of one turn at their latest revision.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from switch_core.sessions.contract import (
    DecidedBy,
    Item,
    ItemUpsert,
    RequestSettled,
    RequestSubmitting,
    ServerEvent,
    SnapshotRequest,
    TurnUpsert,
    parse_server_event,
    parse_snapshot,
)

REPO_ROOT = Path(__file__).resolve().parents[5]
SESSION_V1 = REPO_ROOT / "console/packages/shared/src/session-v1"
EXAMPLES_PATH = SESSION_V1 / "examples.json"
QUESTIONS_PATH = SESSION_V1 / "examples.questions.json"
ACTIVITY_PATH = SESSION_V1 / "examples.activity.json"

TURN = "turn-activity"


def _recorded(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _stream(recorded: dict[str, Any], keys: tuple[str, ...]) -> list[ServerEvent]:
    events: list[Any] = []
    for key in keys:
        value = recorded[key]
        events.extend(value if isinstance(value, list) else [value])
    events.sort(key=lambda event: event["sequence"])
    return [parse_server_event(event) for event in events]


def recorded_requests(path: Path, *events: str) -> dict[str, SnapshotRequest]:
    """The snapshot's requests, with each named stream's answer settled onto it."""
    recorded = _recorded(path)
    return _settle_requests(recorded, _stream(recorded, events))


def requests_through(
    path: Path, stream: str, through: int
) -> dict[str, SnapshotRequest]:
    """The snapshot's requests with one stream replayed up to a sequence."""
    recorded = _recorded(path)
    events = [
        event for event in _stream(recorded, (stream,)) if event.sequence <= through
    ]
    return _settle_requests(recorded, events)


def _settle_requests(
    recorded: dict[str, Any], events: list[ServerEvent]
) -> dict[str, SnapshotRequest]:
    requests = {
        request.request_id: request
        for request in parse_snapshot(recorded["initialSnapshot"]).requests
    }
    for event in events:
        body = event.body
        if isinstance(body, RequestSubmitting):
            requests[body.request_id] = requests[body.request_id].model_copy(
                update={
                    "state": "submitting",
                    "decided_by": DecidedBy(
                        actor_id=body.actor_id,
                        surface=body.surface,
                        command_id=body.command_id,
                    ),
                }
            )
        elif isinstance(body, RequestSettled):
            request = requests[body.request_id]
            requests[body.request_id] = request.model_copy(
                update={
                    "state": "resolved" if body.outcome == "answered" else "closed",
                    "revision": body.revision,
                    "result": body,
                    "decided_by": (
                        request.decided_by
                        if request.decided_by is not None
                        and request.decided_by.command_id == body.command_id
                        else None
                    ),
                }
            )
    return requests


def open_request(path: Path = EXAMPLES_PATH) -> SnapshotRequest:
    """The first request the recorded snapshot is still waiting on."""
    return next(
        request
        for request in recorded_requests(path).values()
        if request.state in ("open", "submitting")
    )


def recorded_items(turn_id: str = TURN, *streams: str) -> list[Item]:
    """One turn's items from the activity recording, each at its latest revision.

    In the order the recording first mentions them, so an item revised in place
    keeps the position it opened at.
    """
    recorded = _recorded(ACTIVITY_PATH)
    items: dict[str, Item] = {
        item.item_id: item for item in parse_snapshot(recorded["initialSnapshot"]).items
    }
    for event in _stream(recorded, streams or ("turnActivity",)):
        body = event.body
        if isinstance(body, ItemUpsert):
            previous = items.get(body.item.item_id)
            if previous is None or previous.revision < body.item.revision:
                items[body.item.item_id] = body.item
    return [item for item in items.values() if item.turn_id == turn_id]


def recorded_turn(turn_id: str = TURN, *streams: str) -> TurnUpsert | None:
    """The latest state of one turn in the activity recording."""
    recorded = _recorded(ACTIVITY_PATH)
    turn = next(
        (
            one
            for one in parse_snapshot(recorded["initialSnapshot"]).turns
            if one.turn_id == turn_id
        ),
        None,
    )
    for event in _stream(recorded, streams or ("turnActivity",)):
        if isinstance(event.body, TurnUpsert) and event.body.turn_id == turn_id:
            turn = event.body
    return turn


def _approval_form(*options: tuple[str, str]) -> dict[str, Any]:
    """An approval's record: which options, in the order the card drew them."""
    return {
        "kind": "approval",
        "options": [
            {"optionId": option_id, "decision": decision}
            for option_id, decision in options
        ],
    }


def _questions_form(*questions: tuple[str, list[str], bool, bool]) -> dict[str, Any]:
    """A form's record: per question, its options and what it will accept."""
    return {
        "kind": "questions",
        "questions": [
            {
                "questionId": question_id,
                "optionIds": option_ids,
                "multiSelect": multi_select,
                "allowCustomAnswer": allow_custom,
            }
            for question_id, option_ids, multi_select, allow_custom in questions
        ],
    }


def _turn(status: str = "running") -> TurnUpsert:
    """The turn itself, which is what says whether any of this is still moving."""
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": TURN, "status": status, "commandId": None}
    )


def _item(**fields: object) -> Item:
    """One item, spelled out, for the shapes the recording has no case for."""
    return Item.model_validate(
        {
            "itemId": "item-made-up",
            "turnId": TURN,
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Did a thing",
            "text": "",
            "attachments": [],
            "origin": None,
            **fields,
        }
    )


async def _items() -> list[Item]:
    return recorded_items()
