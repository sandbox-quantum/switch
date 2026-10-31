from __future__ import annotations

from datetime import UTC, datetime

from switch_core.db.models import AgentSessionActivityItem
from switch_core.session_activity.bridge_turns import turn_view

AT = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def _row(**fields: object) -> AgentSessionActivityItem:
    values: dict[str, object] = dict(
        agent_id="agent",
        session_id="session",
        turn_id="turn-1",
        revision=1,
        title="",
        text="",
        command_id=None,
        room_id="room",
        thread_id=None,
        message_id=None,
        detail=None,
        occurred_at=AT,
        created_at=AT,
        updated_at=AT,
    )
    values.update(fields)
    return AgentSessionActivityItem(**values)


def _rows() -> list[AgentSessionActivityItem]:
    return [
        _row(item_id="turn", kind="turn", status="completed"),
        _row(
            item_id="call",
            kind="tool-activity",
            status="completed",
            title="Ran pytest",
            detail="Input: pytest",
        ),
    ]


def test_a_stored_detail_is_drawn_while_its_room_shows_tool_detail() -> None:
    view = turn_view(_rows(), show_tool_detail=True)

    assert view is not None
    assert [item.detail for item in view.items] == ["Input: pytest"]


def test_a_stored_detail_is_left_out_once_its_room_stops_showing_it() -> None:
    view = turn_view(_rows(), show_tool_detail=False)

    assert view is not None
    assert [item.detail for item in view.items] == [None]
