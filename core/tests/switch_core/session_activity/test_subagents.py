"""Subagent metadata keeps tool compatibility across storage and both read surfaces."""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from switch_core.bridges.agent.api.activity_routes import ActivityReport
from switch_core.db.models import AgentSessionActivityItem
from switch_core.gateway.chats import ActivityItemView
from switch_core.session_activity.bridge_turns import turn_view
from switch_core.sessions.contract import Item, Subagent
from switch_core.sessions.errors import SessionError

from .conftest import AGENT
from .test_routes import _activity
from .test_service import SESSION, _step


@pytest.mark.parametrize("child_id", ["child-demo", None])
def test_report_preserves_child_identity_or_explicitly_unknown(child_id):
    report = ActivityReport.model_validate(_activity(subagent={"child_id": child_id}))
    assert report.subagent is not None
    assert report.subagent.child_id == child_id


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"child_id": ""},
        {"child_id": "x" * 201},
        {"child_id": 1},
        {"child_id": None, "payload": "hidden"},
    ],
)
def test_report_refuses_malformed_subagent_metadata(metadata):
    with pytest.raises(ValidationError):
        ActivityReport.model_validate(_activity(subagent=metadata))


@pytest.mark.parametrize(
    "kind", ["turn", "user-message", "assistant-message", "notice"]
)
def test_report_refuses_subagent_metadata_on_other_kinds(kind):
    with pytest.raises(ValidationError, match="Only tool activity"):
        ActivityReport.model_validate(_activity(kind=kind, subagent={"child_id": None}))


def _row(**changes):
    return AgentSessionActivityItem(
        agent_id=AGENT,
        session_id=SESSION,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
        **{key: value for key, value in _step(**changes).items() if key != "usage"},
    )


@pytest.mark.parametrize("child_id", ["child-demo", None])
def test_both_read_surfaces_keep_camel_case_subagent_metadata(child_id):
    step = _row(subagent={"child_id": child_id})
    turn = _row(item_id="turn", kind="turn", status="running")
    # The reserved turn id is shared with the host's persisted turn row.
    from_row = turn_view([turn, step])
    assert from_row is not None
    assert from_row.items[0].model_dump(by_alias=True)["subagent"] == {
        "childId": child_id
    }
    assert ActivityItemView.of(step).model_dump(by_alias=True)["subagent"] == {
        "childId": child_id
    }


def test_legacy_tool_has_no_new_wire_field():
    row = _row()
    assert "subagent" not in ActivityItemView.of(row).model_dump(by_alias=True)
    item = Item(
        item_id="tool-demo",
        turn_id="turn-demo",
        revision=1,
        kind="tool-activity",
        status="completed",
        title="Read file",
        text="done",
        attachments=[],
        origin=None,
    )
    assert "subagent" not in item.model_dump(by_alias=True)


async def test_metadata_is_upserted_atomically_with_its_revision(service):
    assert await service.report_item(
        AGENT, SESSION, **_step(subagent=Subagent(child_id=None))
    )
    assert await service.report_item(
        AGENT, SESSION, **_step(revision=2, subagent=Subagent(child_id="child-demo"))
    )
    assert not await service.report_item(
        AGENT, SESSION, **_step(revision=1, subagent=Subagent(child_id="stale"))
    )
    [row] = await service.turn_items(AGENT, SESSION, "turn-1")
    assert row.subagent == {"child_id": "child-demo"}
    assert await service.report_item(AGENT, SESSION, **_step(revision=3))
    [row] = await service.turn_items(AGENT, SESSION, "turn-1")
    assert row.subagent is None


async def test_service_rejects_metadata_on_non_tool_before_writing(service):
    with pytest.raises(SessionError, match="Only tool activity"):
        await service.report_item(
            AGENT,
            SESSION,
            **_step(kind="assistant-message", subagent=Subagent(child_id=None)),
        )
    assert await service.turn_items(AGENT, SESSION, "turn-1") == []


@pytest.mark.parametrize("kind", ["user-message", "assistant-message"])
def test_session_item_rejects_non_tool_subagents(kind):
    with pytest.raises(ValidationError, match="Only tool activity"):
        Item(
            item_id="item-demo",
            turn_id="turn-demo",
            revision=1,
            kind=kind,
            status="in-progress",
            title="Read file",
            text="",
            attachments=[],
            origin=None,
            subagent=Subagent(child_id=None),
        )


async def test_service_rejects_oversized_child_id_before_writing(service):
    with pytest.raises(SessionError, match="at most 200"):
        await service.report_item(
            AGENT, SESSION, **_step(subagent=Subagent(child_id="x" * 201))
        )
    assert await service.turn_items(AGENT, SESSION, "turn-1") == []


def test_session_item_rejects_explicit_null_subagent_metadata():
    payload = {
        "itemId": "item-demo",
        "turnId": "turn-demo",
        "revision": 1,
        "kind": "tool-activity",
        "status": "in-progress",
        "title": "Inspect module",
        "text": "",
        "attachments": [],
        "origin": None,
    }
    assert Item.model_validate(payload).subagent is None
    assert Item.model_validate(
        {**payload, "subagent": {"childId": None}}
    ).subagent == Subagent(child_id=None)
    with pytest.raises(ValidationError, match="must be omitted or an object"):
        Item.model_validate({**payload, "subagent": None})
