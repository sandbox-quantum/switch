"""How a turn's card says what became of a message sent while it ran.

A message from whoever started the turn, or from the agent's owner, can be
steered into the running turn; anyone else's waits for a turn of its own. The
card says which, in the one state line every platform draws (`turn_state`), so
a reader can tell a message the agent took in from one it has not read yet.
"""

from __future__ import annotations

from datetime import UTC, datetime

from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    QUEUED_BEHIND,
    TURN_STATE,
    steered_note,
    turn_state,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    turn_status,
    turn_summary,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_text,
)
from switch_core.db.models import AgentSessionActivityItem
from switch_core.session_activity.bridge_turns import status_state, turn_view
from switch_core.sessions.contract import Item

from .session_fixtures import TURN, _item, _turn


def _identity(text: str) -> str:
    return text


def _message(item_id: str, delivery: str | None) -> Item:
    return _item(
        itemId=item_id,
        kind="user-message",
        title="",
        text="In blue, please",
        delivery=delivery,
    )


def test_a_turn_says_how_many_messages_were_steered_into_it() -> None:
    one = [_message("user-1", None), _message("user-2", "steered")]
    two = [*one, _message("user-3", "steered")]

    assert turn_state(one, _turn("running"), tool_detail=True) == (
        "Working… 1 message steered into this turn."
    )
    assert turn_state(two, _turn("completed"), tool_detail=True) == (
        "Turn complete. 2 messages steered into this turn."
    )


def test_a_turn_nobody_steered_reads_as_it_always_has() -> None:
    items = [_message("user-1", None)]

    assert steered_note(items) is None
    for status, state in TURN_STATE.items():
        assert turn_state(items, _turn(status), tool_detail=True) == state


def test_a_queued_turn_says_it_waits_behind_the_running_one_only_when_it_does() -> None:
    """A turn is reported queued for a moment before it starts even with
    nothing ahead of it; only a message the host queued behind another turn
    says so."""
    behind = [_message("user-1", "queued")]
    starting = [_message("user-1", None)]

    assert turn_state(behind, _turn("queued"), tool_detail=True) == QUEUED_BEHIND
    assert (
        turn_state(starting, _turn("queued"), tool_detail=True)
        == (TURN_STATE["queued"])
    )
    # Once it runs, it is an ordinary turn.
    assert turn_state(behind, _turn("running"), tool_detail=True) == "Working…"


def test_every_platform_draws_the_same_line() -> None:
    items = [_message("user-1", None), _message("user-2", "steered")]
    note = "1 message steered into this turn."

    status = turn_status(
        items,
        _turn("running"),
        escape=_identity,
        limit=10_000,
        markup=MARKDOWN,
        tool_detail=True,
    )
    summary = turn_summary(items, _turn("running"), escape=_identity, limit=10_000)
    slack = render_activity_text(items, _turn("running"))

    assert note in status
    assert note in summary
    assert note in slack
    # A person's message is still not shown back as though the agent said it.
    assert "In blue, please" not in summary
    assert "In blue, please" not in slack


def _row(item_id: str, kind: str, status: str, delivery: str | None = None):
    at = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
    return AgentSessionActivityItem(
        tenant_id="tenant",
        agent_id="agent",
        session_id="session",
        turn_id=TURN,
        item_id=item_id,
        kind=kind,
        revision=1,
        status=status,
        title="",
        text="",
        command_id=None,
        room_id=None,
        thread_id=None,
        message_id=None,
        delivery=delivery,
        occurred_at=at,
        created_at=at,
        updated_at=at,
    )


def test_a_stored_row_keeps_its_delivery_and_a_steered_message_redraws_the_card() -> (
    None
):
    before = turn_view(
        [_row("turn", "turn", "running"), _row("user-1", "user-message", "completed")]
    )
    after = turn_view(
        [
            _row("turn", "turn", "running"),
            _row("user-1", "user-message", "completed"),
            _row("user-2", "user-message", "completed", "steered"),
        ]
    )
    assert before is not None and after is not None
    assert [item.delivery for item in after.items] == [None, "steered"]

    def drawn(view: object) -> str:
        return status_state(
            view,  # type: ignore[arg-type]
            elapsed_seconds=None,
            interrupt_turn_id=None,
            clock_redraws=False,
            closed_by_platform=False,
        )

    assert drawn(before) != drawn(after)
    # A card with no marked message is keyed as it was before marks existed.
    assert drawn(before) == "running::/"
