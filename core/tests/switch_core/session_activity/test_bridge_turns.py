"""What a turn's message is showing, so an unchanged redraw can be skipped.

The key `status_state` builds decides whether a platform is asked to redraw at
all. Anything the rendering says that the key does not count is a line that
waits for some other change to carry it out — which, for a queued turn, may
never come.
"""

from __future__ import annotations

from datetime import UTC, datetime

from switch_core.db.models import AgentSessionActivityItem
from switch_core.session_activity.bridge_turns import status_state, turn_view

AT = datetime(2026, 9, 7, 12, 0, tzinfo=UTC)


def _row(
    item_id: str, kind: str, *, status: str, revision: int
) -> AgentSessionActivityItem:
    return AgentSessionActivityItem(
        agent_id="agent",
        session_id="session",
        turn_id="turn",
        item_id=item_id,
        kind=kind,
        revision=revision,
        status=status,
        title="",
        text="",
        command_id=None,
        room_id="room",
        thread_id=None,
        message_id="$asked",
        occurred_at=AT,
        created_at=AT,
        updated_at=AT,
    )


def _state(*rows: AgentSessionActivityItem) -> str:
    view = turn_view(list(rows))
    assert view is not None
    return status_state(
        view,
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )


def test_a_correction_to_a_queued_message_asks_for_a_redraw() -> None:
    queued = _row("turn", "turn", status="queued", revision=1)
    asked = _row("user-turn", "user-message", status="completed", revision=1)
    corrected = _row("user-turn", "user-message", status="completed", revision=2)

    assert _state(queued, asked) != _state(queued, corrected)


def test_the_same_turn_unchanged_asks_for_nothing() -> None:
    queued = _row("turn", "turn", status="queued", revision=1)
    asked = _row("user-turn", "user-message", status="completed", revision=1)

    assert _state(queued, asked) == _state(queued, asked)
