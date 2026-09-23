"""Record what a session's host reports, and check answers to its questions.

The host owns the session. This service keeps only what messaging platforms
render and what must be checked when a person answers: short activity lines
and approval requests. Each call is one short transaction over small rows.

An answer is accepted from anyone who may address the agent — the agent's
addressing policy, judged in the request's room — and only while the request
is open, unexpired, and the answer is one of its options.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    SESSION_ACTIVITY_TYPES,
    Agent,
    ApprovalRequest,
    SessionActivityEvent,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_activity_store import (
    ApprovalRequestStore,
    SessionActivityStore,
)
from switch_core.delivery.addressing import AddressingResolver
from switch_core.sessions.service import SessionError

MAX_SUMMARY_CHARS = 2000
MAX_OPTIONS = 10
# A request nobody answers must not hold a session forever, and one that
# outlives a working day is no longer the question anyone is looking at.
MAX_APPROVAL_LIFETIME = timedelta(hours=24)


@dataclass(frozen=True)
class ApprovalOption:
    id: str
    label: str


class SessionActivityService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory
        self._approvals = ApprovalRequestStore()
        self._activity = SessionActivityStore()
        self._rooms = RoomStore()
        self._addressing = AddressingResolver(
            room_store=self._rooms,
            room_role_store=RoomRoleStore(),
            client_store=ClientStore(),
            agent_store=AgentStore(),
            external_user_store=ExternalUserStore(),
            # Only role mentions consult liveness; a permission check never does.
            live_connection_ids=set,
        )

    # ── Activity ──────────────────────────────────────────────────────────────

    async def report_activity(
        self,
        agent_id: str,
        session_id: str,
        *,
        seq: int,
        type: str,
        summary: str,
        detail: dict[str, Any],
        turn_id: str | None,
        room_id: str | None,
        occurred_at: datetime,
    ) -> bool:
        """Record one activity line. False when this exact line was already recorded."""
        if type not in SESSION_ACTIVITY_TYPES:
            raise SessionError("INVALID_EVENT", f"Unknown activity type: {type}")
        if not summary.strip():
            raise SessionError("INVALID_EVENT", "An activity line needs a summary.")
        if len(summary) > MAX_SUMMARY_CHARS:
            raise SessionError(
                "INVALID_EVENT",
                f"Activity summary is longer than {MAX_SUMMARY_CHARS} characters.",
            )
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            if room_id is not None:
                await self._require_member(db, agent_id, room_id)
            event = SessionActivityEvent(
                agent_id=agent_id,
                session_id=session_id,
                seq=seq,
                room_id=room_id,
                turn_id=turn_id,
                type=type,
                summary=summary,
                detail=detail,
                occurred_at=occurred_at,
            )
            if not await self._activity.insert_if_absent(db, event):
                existing = await self._activity.get(db, agent_id, session_id, seq)
                if existing is None or (
                    existing.type,
                    existing.summary,
                    existing.turn_id,
                    existing.room_id,
                    existing.detail,
                ) != (type, summary, turn_id, room_id, detail):
                    raise SessionError(
                        "ACTIVITY_CONFLICT",
                        f"Activity {seq} of session {session_id} was already "
                        "recorded with different content.",
                    )
                return False
            return True

    async def activity_since(
        self, agent_id: str, session_id: str, after_seq: int, limit: int
    ) -> list[SessionActivityEvent]:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            return await self._activity.since(
                db, agent_id, session_id, after_seq, limit
            )

    async def prune_activity(self, older_than: timedelta) -> int:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            return await self._activity.prune_before(db, datetime.now(UTC) - older_than)

    # ── Approval requests ─────────────────────────────────────────────────────

    async def open_approval(
        self,
        agent_id: str,
        session_id: str,
        *,
        request_id: str,
        question: str,
        options: list[ApprovalOption],
        room_id: str | None,
        thread_id: str | None,
        expires_at: datetime | None,
    ) -> ApprovalRequest:
        """Open a request, or return it unchanged when the host retries the same open."""
        if not question.strip():
            raise SessionError("INVALID_EVENT", "An approval request needs a question.")
        ids = [option.id for option in options]
        if not options or len(options) > MAX_OPTIONS:
            raise SessionError(
                "INVALID_EVENT",
                f"An approval request needs between 1 and {MAX_OPTIONS} options.",
            )
        if len(set(ids)) != len(ids) or not all(
            option.id and option.label for option in options
        ):
            raise SessionError(
                "INVALID_EVENT", "Options need distinct ids and non-empty labels."
            )
        now = datetime.now(UTC)
        if expires_at is not None:
            if expires_at <= now:
                raise SessionError("INVALID_EVENT", "The request has already expired.")
            if expires_at - now > MAX_APPROVAL_LIFETIME:
                raise SessionError(
                    "INVALID_EVENT",
                    "An approval request may stay open for at most 24 hours.",
                )
        offered = [{"id": option.id, "label": option.label} for option in options]
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            if room_id is not None:
                await self._require_member(db, agent_id, room_id)
            created = await self._approvals.insert_if_absent(
                db,
                ApprovalRequest(
                    agent_id=agent_id,
                    session_id=session_id,
                    request_id=request_id,
                    room_id=room_id,
                    thread_id=thread_id,
                    question=question,
                    options=offered,
                    state="open",
                    expires_at=expires_at,
                ),
            )
            row = await self._approvals.get(
                db, agent_id, session_id, request_id, for_update=False
            )
            assert row is not None
            if not created and (
                row.question,
                row.options,
                row.room_id,
                row.thread_id,
                row.expires_at,
            ) != (question, offered, room_id, thread_id, expires_at):
                raise SessionError(
                    "REQUEST_CONFLICT",
                    f"Request {request_id} of session {session_id} was already "
                    "opened with different content.",
                )
            return row

    async def answer_approval(
        self,
        agent_id: str,
        session_id: str,
        request_id: str,
        *,
        answer: str,
        answered_by: str,
    ) -> ApprovalRequest:
        """Record a person's answer. A repeat of the same answer by the same person is a no-op.

        `answered_by` is the answerer's Switch identity (their client's mxid),
        and they must be someone who may address the agent: answering is
        talking to the agent, so it takes the same permission.
        """
        tenant_id = require_tenant_id()
        closed_as: str | None = None
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            row = await self._require_request(db, agent_id, session_id, request_id)
            if row.state == "answered" and (row.answer, row.answered_by) == (
                answer,
                answered_by,
            ):
                return row
            await self._require_may_address(db, row, answered_by)
            if row.state == "open" and _past(row.expires_at):
                # Kept even though the answer is refused: the agent is owed the expiry.
                row.state = "expired"
            if row.state != "open":
                closed_as = row.state
            elif answer not in {option["id"] for option in row.options}:
                raise SessionError(
                    "INVALID_ANSWER",
                    f"{answer!r} is not one of this request's options.",
                )
            else:
                row.state = "answered"
                row.answer = answer
                row.answered_by = answered_by
                row.answered_at = datetime.now(UTC)
        if closed_as is not None:
            raise SessionError(
                "REQUEST_CLOSED", f"Request {request_id} is {closed_as}."
            )
        return row

    async def close_approval(
        self, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest:
        """The host no longer needs an answer. Closing a settled request changes nothing."""
        tenant_id = require_tenant_id()
        async with tenant_session(self._sessions, tenant_id) as db, db.begin():
            row = await self._require_request(db, agent_id, session_id, request_id)
            if row.state == "open":
                row.state = "closed"
            return row

    async def undelivered_outcomes(self, agent_id: str) -> list[ApprovalRequest]:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            return await self._approvals.undelivered(db, agent_id)

    async def mark_delivered(
        self, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._require_request(db, agent_id, session_id, request_id)
            if row.state not in ("answered", "expired"):
                raise SessionError(
                    "REQUEST_OPEN",
                    f"Request {request_id} is {row.state}; there is no outcome to deliver.",
                )
            if row.delivered_at is None:
                row.delivered_at = datetime.now(UTC)
            return row

    async def expire_due(self) -> list[ApprovalRequest]:
        """Expire the bound tenant's overdue requests. Run on a timer."""
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            return await self._approvals.expire_due(db, datetime.now(UTC))

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _require_member(
        self, db: AsyncSession, agent_id: str, room_id: str
    ) -> None:
        found = await self._rooms.get_with_membership(db, room_id, agent_id)
        if found is None:
            raise SessionError("NOT_FOUND", f"Room not found: {room_id}")
        if not found[1]:
            raise SessionError("NOT_AUTHORIZED", "Agent is not a member of this room.")

    async def _require_may_address(
        self, db: AsyncSession, row: ApprovalRequest, sender: str
    ) -> None:
        agent = await db.get(Agent, row.agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", f"Agent not found: {row.agent_id}")
        if row.room_id is not None:
            decision = await self._addressing.permitted(
                db, agent=agent, room_id=row.room_id, sender=sender
            )
            allowed = decision.allowed
        else:
            # Asked outside any room, so no room's policy applies: only the
            # agent's owner may answer.
            principal = await self._addressing.resolve_sender(db, sender)
            allowed = (
                principal is not None
                and agent.owner_id is not None
                and agent.owner_id in principal.user_ids
            )
        if not allowed:
            raise SessionError(
                "NOT_AUTHORIZED",
                "You may not address this agent, so you may not answer it.",
            )

    async def _require_request(
        self, db: AsyncSession, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest:
        row = await self._approvals.get(
            db, agent_id, session_id, request_id, for_update=True
        )
        if row is None:
            raise SessionError("NOT_FOUND", f"Request not found: {request_id}")
        return row


def _past(moment: datetime | None) -> bool:
    return moment is not None and moment <= datetime.now(UTC)
