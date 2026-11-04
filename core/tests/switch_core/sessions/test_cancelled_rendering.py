from datetime import UTC, datetime, timedelta

from switch_core.bridges.collaboration.session.renderers import MARKDOWN, turn_state
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
    render_activity_stream,
)
from switch_core.db.models import AgentSessionActivityItem
from switch_core.session_activity.bridge_turns import turn_view
from switch_core.sessions.contract import TurnUpsert

TURN = "12345678-aaaa-4444-8888-111111111111"
COMMAND = "!cancel @helper 12345678"


def test_queued_cards_show_full_id_and_copyable_short_command():
    turn = TurnUpsert(
        type="turn.upsert", turn_id=TURN, command_id=TURN, status="queued"
    )
    text = turn_status(
        [],
        turn,
        escape=lambda text: text,
        limit=2000,
        markup=MARKDOWN,
        tool_detail=True,
        cancel_command=COMMAND,
    )
    assert f"`{TURN}`" in text
    assert f"`{COMMAND}`" in text
    for rendered in [
        render_activity_plan([], turn, cancel_command=COMMAND),
        render_activity_stream([], turn, cancel_command=COMMAND),
    ]:
        details = rendered.blocks[0]["tasks"][0]["details"]["elements"][0]["elements"][
            0
        ]["text"]
        assert TURN in details
        assert COMMAND in details


def test_cancelled_cards_have_no_clock_or_cancel_hint():
    turn = TurnUpsert(
        type="turn.upsert", turn_id=TURN, command_id=TURN, status="cancelled"
    )
    assert (
        turn_state([], turn, tool_detail=True, elapsed_seconds=120)
        == "Cancelled before the agent started."
    )
    text = turn_status(
        [],
        turn,
        escape=lambda text: text,
        limit=2000,
        markup=MARKDOWN,
        tool_detail=True,
        cancel_command=COMMAND,
    )
    assert "Cancelled before the agent started." in text
    assert "!cancel" not in text
    now = datetime.now(UTC)
    view = turn_view(
        [
            AgentSessionActivityItem(
                agent_id="agent",
                session_id="session",
                turn_id=TURN,
                command_id=TURN,
                item_id="turn",
                kind="turn",
                revision=2,
                status="cancelled",
                title="Turn",
                text="",
                occurred_at=now,
                created_at=now - timedelta(minutes=2),
                updated_at=now,
            )
        ]
    )
    assert view is not None and view.ended
    assert view.elapsed_seconds(now) is None
