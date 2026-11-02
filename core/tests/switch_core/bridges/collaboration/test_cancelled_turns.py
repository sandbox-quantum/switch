"""A queued turn's message says how to cancel it, and a cancelled turn reads
as over without claiming it ran."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_QUEUED_NOTE,
    TURN_STATE,
    cancel_note,
    turn_state,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
    render_activity_stream,
)
from switch_core.session_activity.bridge_turns import TurnView
from switch_core.sessions.contract import TURN_ENDED, TurnUpsert

CANCEL = "!cancel @worker 378893ee"


def _turn(status: str) -> TurnUpsert:
    return TurnUpsert(
        type="turn.upsert",
        turn_id="378893ee-5a16-5c9b-a6a0-b288ed58745b",
        status=status,  # type: ignore[arg-type]
        command_id=None,
    )


def _control(blocks: list[dict]) -> dict:
    return blocks[-1]


def test_slack_says_how_to_cancel_in_the_queued_controls_sentence() -> None:
    """A stream cannot take a block back, so the line rides in the block that is
    replaced as the turn starts rather than in one of its own."""
    plan = render_activity_plan(
        [], _turn("queued"), interrupt_turn_id="running", cancel_command=CANCEL
    )
    stream = render_activity_stream(
        [], _turn("queued"), interrupt_turn_id="running", cancel_command=CANCEL
    )

    for blocks in (plan.blocks, stream.blocks):
        assert _control(blocks)["text"]["text"] == (
            f"{INTERRUPT_QUEUED_NOTE} {cancel_note(CANCEL)}"
        )


def test_slack_keeps_its_queued_sentence_where_nothing_can_be_cancelled() -> None:
    plan = render_activity_plan([], _turn("queued"), interrupt_turn_id="running")

    assert _control(plan.blocks)["text"]["text"] == INTERRUPT_QUEUED_NOTE


def test_a_cancelled_turn_is_over_and_says_it_never_started() -> None:
    assert "cancelled" in TURN_ENDED
    assert turn_state([], _turn("cancelled"), tool_detail=True) == (
        "Cancelled before the agent started."
    )
    assert TURN_STATE["cancelled"] == "Cancelled before the agent started."


def test_a_cancelled_turn_shows_no_running_time() -> None:
    """Its message was queued, not worked on, so it has no time to report."""
    queued_at = datetime.now(UTC) - timedelta(minutes=3)
    row = SimpleNamespace(updated_at=datetime.now(UTC), created_at=queued_at)
    view = TurnView(
        turn=_turn("cancelled"),
        items=[],
        row=row,  # type: ignore[arg-type]
        started_at=queued_at,
    )

    assert view.ended
    assert view.elapsed_seconds(datetime.now(UTC)) is None
