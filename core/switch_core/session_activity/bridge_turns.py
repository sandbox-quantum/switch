"""A turn's rows as the platform renderers draw them.

The renderers and the adapters' activity methods take the session contract's
`TurnUpsert` and `Item`s, the shapes the old server-side session carried. The
host now reports each step as a row of `session_activity_items`, so a turn is
rebuilt from its rows on every change rather than each platform learning a
second shape.

What the rows do not carry is filled in from the rows' own timestamps: a turn
has no recorded start, so it is measured on the server from the first of its
steps to be recorded to the moment its end was recorded.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from switch_core.db.models import SessionActivityItem
from switch_core.db.stores.session_activity_store import TURN_ITEM_ID
from switch_core.sessions.contract import TURN_ENDED, Item, TurnUpsert

_ITEM_KINDS = frozenset({"user-message", "assistant-message", "tool-activity"})


@dataclass(frozen=True)
class TurnView:
    """One turn, rebuilt from its rows."""

    turn: TurnUpsert
    items: list[Item]
    # The turn's own row: where it was asked, and when it started and ended.
    row: SessionActivityItem
    started_at: datetime

    @property
    def ended(self) -> bool:
        return self.turn.status in TURN_ENDED

    def elapsed_seconds(self, now: datetime) -> float | None:
        """How long the turn has run, or ran; None where nothing measures it.

        A queued turn has not started. An ended turn measures to when its end
        was recorded, and one whose end was recorded before its first step
        (reports arriving out of order) reports no measurement rather than a
        negative one.
        """
        if self.turn.status == "queued":
            return None
        until = self.row.updated_at if self.ended else now
        elapsed = (until - self.started_at).total_seconds()
        if self.ended:
            return elapsed if elapsed >= 0 else None
        return max(0.0, elapsed)


def turn_view(rows: list[SessionActivityItem]) -> TurnView | None:
    """The turn its rows describe, or None until its own row has been reported."""
    row = next((r for r in rows if r.item_id == TURN_ITEM_ID), None)
    if row is None:
        return None
    steps = [r for r in rows if r.kind in _ITEM_KINDS]
    items = [
        Item(
            item_id=step.item_id,
            turn_id=step.turn_id,
            revision=step.revision,
            kind=step.kind,  # type: ignore[arg-type]
            status=step.status,  # type: ignore[arg-type]
            title=step.title,
            text=step.text,
            attachments=[],
            origin=None,
        )
        for step in steps
    ]
    started_at = min((step.created_at for step in steps), default=row.created_at)
    return TurnView(
        turn=TurnUpsert(
            type="turn.upsert",
            turn_id=row.turn_id,
            status=row.status,  # type: ignore[arg-type]
            command_id=row.command_id,
        ),
        items=items,
        row=row,
        started_at=started_at,
    )


def status_state(
    view: TurnView,
    *,
    elapsed_seconds: float | None,
    interrupt_turn_id: str | None,
    session_url: str | None,
    clock_redraws: bool,
) -> str:
    """What the turn's message is showing, so an unchanged redraw can be skipped.

    The turn's state and its tools count. The clock counts only where the
    platform redraws for it. What the agent is saying does not: prose is
    revised on every token, and it goes out with the next change to either,
    and with the edit that ends the turn. The turn a stop control names
    counts, so a queued turn's message stops offering to stop a turn that
    has ended.
    """
    clock = (
        str(int(elapsed_seconds))
        if clock_redraws and elapsed_seconds is not None
        else ""
    )
    tools = ",".join(
        f"{item.item_id}:{item.revision}"
        for item in view.items
        if item.kind == "tool-activity"
    )
    return (
        f"{view.turn.status}:{interrupt_turn_id or ''}:{clock}/{tools}"
        f"\n{session_url or ''}"
    )
