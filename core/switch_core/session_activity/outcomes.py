"""The outcomes an agent is owed on its stream: answers and expiries.

Joins the two halves an agent stream needs. Live outcomes come pushed from
`SessionActivityListener`, with the row attached. Undelivered ones come from
the table: everything answered or expired that the agent has not acknowledged,
read when a stream opens and whenever the listener says announcements may have
been missed.

An outcome stays owed until the agent acknowledges it
(`POST /agent-sessions/{session}/approvals/{request}/delivered`), so sending
one twice — live, then again on a resync before the acknowledgement lands — is
expected, and the agent de-duplicates by `(session_id, request_id)`.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from switch_core.db.models import ApprovalRequest
from switch_core.session_activity.listener import Change, SessionActivityListener
from switch_core.session_activity.service import SessionActivityService

OUTCOME_KINDS = frozenset({"approval.answered", "approval.expired"})

Outcome = dict[str, Any]


def outcome_of(row: ApprovalRequest | dict[str, Any]) -> Outcome:
    """The frame body for one outcome, from an ORM row or an announced one."""
    if isinstance(row, ApprovalRequest):
        answered_at: datetime | str | None = row.answered_at
        fields = {
            "session_id": row.session_id,
            "request_id": row.request_id,
            "state": row.state,
            "answer": row.answer,
            "answered_by": row.answered_by,
        }
    else:
        answered_at = row.get("answered_at")
        fields = {
            key: row.get(key)
            for key in ("session_id", "request_id", "state", "answer", "answered_by")
        }
    if isinstance(answered_at, datetime):
        answered_at = answered_at.isoformat()
    return {**fields, "answered_at": answered_at}


class ApprovalOutcomes:
    def __init__(
        self, listener: SessionActivityListener, service: SessionActivityService
    ) -> None:
        self._listener = listener
        self._service = service

    def subscribe(
        self,
        tenant_id: str,
        agent_id: str,
        on_outcome: Callable[[Outcome], None],
        on_resync: Callable[[], None],
    ) -> Callable[[], None]:
        """Hear this agent's outcomes as they happen; returns the unsubscribe.

        `on_resync` is called when announcements may have been missed, or an
        outcome was announced without its row; the caller then reads
        `undelivered`.
        """

        async def changed(change: Change) -> None:
            if change.agent_id != agent_id:
                return
            if change.row is None:
                if change.kind == "approval.changed":
                    on_resync()
                return
            if change.kind in OUTCOME_KINDS:
                on_outcome(outcome_of(change.row))

        async def resync() -> None:
            on_resync()

        return self._listener.subscribe(tenant_id, changed, resync)

    async def undelivered(self, agent_id: str) -> list[Outcome]:
        rows = await self._service.undelivered_outcomes(agent_id)
        return [outcome_of(row) for row in rows]
