"""What a room may be shown of a session.

The rule this file exists for is a negative: a session nobody associated with a
room publishes nothing, anywhere. A negative is only testable against a single
decision point, so these drive `publication_policy` directly rather than any
renderer, and the renderers are checked here only to the extent of proving that
what the policy hands them cannot contain a transcript.

The transcript tests run off `examples.activity.json` rather than hand-built
items, because the thing being excluded has to be something a real host really
sends. A recording with no assistant text in it would pass this file with the
exclusion deleted.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.session.contract import (
    Item,
    SnapshotRequest,
    TurnUpsert,
    parse_snapshot,
)
from switch_core.bridges.collaboration.session.policy import (
    TRANSCRIPT_KINDS,
    publication_policy,
)
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.bridges.collaboration.session.renderers.slack import render_activity
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.db.models import SessionRoomAssociation

REPO_ROOT = Path(__file__).resolve().parents[5]
ACTIVITY_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.activity.json"
)
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

TURN = "turn-activity"
ROOM = "room-1"


def _association(**fields: Any) -> SessionRoomAssociation:
    return SessionRoomAssociation(
        **{
            "session_id": "s1",
            "room_id": ROOM,
            "thread_id": None,
            "origin_message_id": None,
            "granted_by_actor_id": "user-1",
            "source": "granted",
            **fields,
        }
    )


async def _recorded() -> SessionProjection:
    source = FixtureEventSource.from_examples(ACTIVITY_PATH, events=["turnActivity"])
    return await project(source, source.session_id)


def _item(**fields: Any) -> Item:
    return Item.model_validate(
        {
            "itemId": "item-1",
            "turnId": TURN,
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Ran the tests",
            "text": "1 failed, 41 passed",
            "attachments": [],
            "origin": None,
            "audience": {},
            **fields,
        }
    )


def _from_the_room() -> dict[str, Any]:
    """An origin naming the message in the associated room that steered a turn."""
    return {
        "surface": "slack",
        "actorId": "@someone:test",
        "roomId": ROOM,
        "threadId": None,
        "messageId": "msg-1",
    }


def _request(request_id: str, state: str) -> SnapshotRequest:
    return SnapshotRequest.model_validate(
        {
            "requestId": request_id,
            "turnId": TURN,
            "revision": 1,
            "state": state,
            "content": {
                "kind": "approval",
                "title": "Delete the branch?",
                "detail": "",
                "options": [
                    {"optionId": "yes", "label": "Yes", "decision": "accept"},
                    {"optionId": "no", "label": "No", "decision": "decline"},
                ],
            },
            "audience": {},
            "expiresAt": None,
            "result": None,
            "decidedBy": None,
        }
    )


def _projection(
    *, items: list[Item], requests: list[SnapshotRequest]
) -> SessionProjection:
    """A projection carrying exactly the rows a case is about.

    Built from the recorded snapshot so the session, capabilities and turn are a
    real shape rather than one invented here, with the two lists the policy
    reads swapped for the case's own.
    """
    recorded = parse_snapshot(json.loads(EXAMPLES_PATH.read_text())["initialSnapshot"])
    turn = TurnUpsert.model_validate(
        {
            "type": "turn.upsert",
            "turnId": TURN,
            "status": "running",
            "commandId": None,
        }
    )
    return SessionProjection(
        recorded.model_copy(
            update={"items": items, "requests": requests, "turns": [turn]}
        )
    )


class TestNoAssociationNoPublication:
    """The slice's acceptance, and the only rule here worth breaking a build over."""

    async def test_an_unassociated_session_publishes_nothing(self) -> None:
        projection = await _recorded()
        assert publication_policy(projection, None) is None

    async def test_nothing_about_the_session_changes_that(self) -> None:
        """Not a full turn, not an open request, not anything the host reports.

        The absence of an association is the whole decision. If any of these
        could tip it, "a Console-started session posts nothing" would be a claim
        about which events happened to arrive rather than about authority.
        """
        projection = _projection(
            items=[_item(), _item(itemId="item-2", kind="assistant-message")],
            requests=[_request("req-1", "open")],
        )
        assert publication_policy(projection, None) is None


class TestTranscriptIsNeverPublished:
    async def test_the_recorded_turn_publishes_only_what_it_did(self) -> None:
        projection = await _recorded()
        plan = publication_policy(projection, _association())

        assert plan is not None
        published = [item for turn in plan.disclosures for item in turn.items]
        assert published
        assert {item.kind for item in published} == {"tool-activity"}

    async def test_the_recording_really_does_carry_transcript(self) -> None:
        """Guards the test above: it proves nothing against a turn that said nothing."""
        projection = await _recorded()
        kinds = {item.kind for item in projection.turn_activity(TURN)}
        assert kinds & TRANSCRIPT_KINDS

    async def test_what_slack_would_draw_holds_no_assistant_text(self) -> None:
        """The renderer draws messages and the disclosure in one call, so the
        exclusion has to happen before it, not inside it."""
        projection = await _recorded()
        plan = publication_policy(projection, _association())
        assert plan is not None

        said = [
            item.text
            for item in projection.turn_activity(TURN)
            if item.kind in TRANSCRIPT_KINDS and item.text
        ]
        assert said

        drawn = json.dumps(
            [render_activity(list(turn.items)).blocks for turn in plan.disclosures]
        )
        for text in said:
            assert text not in drawn


class TestRequests:
    async def test_an_answerable_request_is_a_card(self) -> None:
        projection = _projection(
            items=[],
            requests=[_request("req-1", "open"), _request("req-2", "submitting")],
        )
        plan = publication_policy(projection, _association())

        assert plan is not None
        assert [x.request_id for x in plan.cards] == ["req-1", "req-2"]
        assert plan.outcomes == ()

    async def test_a_settled_request_is_an_outcome(self) -> None:
        """Posted, not withheld: a decision the room could have taken and did
        not is still something the room is told about."""
        projection = _projection(
            items=[],
            requests=[_request("req-1", "resolved"), _request("req-2", "closed")],
        )
        plan = publication_policy(projection, _association())

        assert plan is not None
        assert plan.cards == ()
        assert [x.request_id for x in plan.outcomes] == ["req-1", "req-2"]

    async def test_every_open_request_is_published(self) -> None:
        """Withholding one only means nobody in the room can answer it."""
        projection = _projection(
            items=[], requests=[_request(f"req-{n}", "open") for n in range(5)]
        )
        plan = publication_policy(projection, _association())

        assert plan is not None
        assert len(plan.cards) == 5


class TestARoomSteeredTurn:
    """A turn a room asked for, where every item carries that room's origin.

    There is no rule against echoing here, and these are why. Being caused by a
    room is not the same as having been said by it: the message is transcript
    and goes nowhere, and the work it caused is exactly what the room asked to
    see. Suppressing on origin instead would empty the disclosure and, because
    an empty disclosure is dropped, lose the turn.
    """

    async def test_the_room_that_asked_still_sees_what_the_agent_did(self) -> None:
        projection = _projection(
            items=[_item(itemId="what-it-did", origin=_from_the_room())], requests=[]
        )
        plan = publication_policy(projection, _association())

        assert plan is not None
        assert [x.item_id for turn in plan.disclosures for x in turn.items] == [
            "what-it-did"
        ]

    async def test_the_message_that_steered_it_is_not_quoted_back(self) -> None:
        projection = _projection(
            items=[
                _item(
                    itemId="what-was-asked",
                    kind="user-message",
                    origin=_from_the_room(),
                )
            ],
            requests=[],
        )
        plan = publication_policy(projection, _association())

        assert plan is not None
        assert plan.disclosures == ()


class TestWhereItGoes:
    async def test_the_plan_names_the_associated_room(self) -> None:
        projection = _projection(items=[_item()], requests=[])
        plan = publication_policy(projection, _association(room_id="room-9"))

        assert plan is not None
        assert plan.room_id == "room-9"

    async def test_a_turn_threads_under_the_message_that_asked_for_it(self) -> None:
        projection = _projection(items=[_item()], requests=[])
        plan = publication_policy(
            projection, _association(origin_message_id="msg-root")
        )

        assert plan is not None
        assert plan.thread_root_id == "msg-root"

    async def test_an_explicit_thread_wins_over_the_origin(self) -> None:
        projection = _projection(items=[_item()], requests=[])
        plan = publication_policy(
            projection,
            _association(thread_id="thread-1", origin_message_id="msg-root"),
        )

        assert plan is not None
        assert plan.thread_root_id == "thread-1"

    async def test_a_turn_with_nothing_to_disclose_gets_no_disclosure(self) -> None:
        projection = _projection(items=[_item(kind="assistant-message")], requests=[])
        plan = publication_policy(projection, _association())

        assert plan is not None
        assert plan.disclosures == ()


@pytest.mark.parametrize("kind", sorted(TRANSCRIPT_KINDS))
async def test_no_kind_the_host_calls_speech_is_ever_published(kind: str) -> None:
    projection = _projection(items=[_item(kind=kind)], requests=[])
    plan = publication_policy(projection, _association())

    assert plan is not None
    assert plan.disclosures == ()
