"""What a session's host reports: turn steps and approval requests.

Stateless, like every store here: the caller owns the session and the
transaction, and the bound tenant scopes every read through row-level security.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    ColumnElement,
    and_,
    delete,
    exists,
    func,
    literal,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert

from switch_core.db.models import (
    Agent,
    AgentConnectionRecord,
    AgentSession,
    AgentSessionActivityItem,
    AgentSessionPlacement,
    ApprovalRequest,
    Room,
    SwitchCoreProcess,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

TURN_ITEM_ID = "turn"
# The ends a turn can be run again from: it failed, or it was stopped.
RETRYABLE_TURN_STATUSES = frozenset({"error", "interrupted"})


class ApprovalRequestStore:
    async def insert_if_absent(
        self, session: AsyncSession, request: ApprovalRequest
    ) -> bool:
        """Insert `request` unless its key exists. True when this call made it."""
        values = {
            column.key: getattr(request, column.key)
            for column in ApprovalRequest.__table__.columns
            if getattr(request, column.key) is not None
        }
        result = await session.execute(
            insert(ApprovalRequest)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(ApprovalRequest.request_id)
        )
        return result.scalar_one_or_none() is not None

    async def get(
        self,
        session: AsyncSession,
        agent_id: str,
        session_id: str,
        request_id: str,
        *,
        for_update: bool,
    ) -> ApprovalRequest | None:
        query = select(ApprovalRequest).where(
            ApprovalRequest.agent_id == agent_id,
            ApprovalRequest.session_id == session_id,
            ApprovalRequest.request_id == request_id,
        )
        if for_update:
            query = query.with_for_update()
        return (await session.execute(query)).scalar_one_or_none()

    async def undelivered(
        self, session: AsyncSession, agent_id: str
    ) -> list[ApprovalRequest]:
        """Outcomes the agent is owed: answers and expiries not yet handed over."""
        result = await session.execute(
            select(ApprovalRequest)
            .where(
                ApprovalRequest.agent_id == agent_id,
                ApprovalRequest.state.in_(("answered", "expired")),
                ApprovalRequest.delivered_at.is_(None),
            )
            .order_by(ApprovalRequest.updated_at)
        )
        return list(result.scalars())

    async def open_for_owner(
        self, session: AsyncSession, owner_id: str
    ) -> list[ApprovalRequest]:
        """Open requests of every agent `owner_id` owns, oldest first."""
        result = await session.execute(
            select(ApprovalRequest)
            .join(Agent, Agent.id == ApprovalRequest.agent_id)
            .where(Agent.owner_id == owner_id, ApprovalRequest.state == "open")
            .order_by(ApprovalRequest.created_at)
        )
        return list(result.scalars())

    async def for_room(
        self, session: AsyncSession, room_id: str, since: datetime
    ) -> list[ApprovalRequest]:
        """Open requests in `room_id` plus closed ones changed since `since`; oldest first."""
        result = await session.execute(
            select(ApprovalRequest)
            .where(
                ApprovalRequest.room_id == room_id,
                or_(
                    ApprovalRequest.state == "open", ApprovalRequest.updated_at >= since
                ),
            )
            .order_by(ApprovalRequest.created_at)
        )
        return list(result.scalars())

    async def expire_due(
        self, session: AsyncSession, now: datetime
    ) -> list[ApprovalRequest]:
        """Close every open request whose deadline has passed, returning them."""
        result = await session.execute(
            update(ApprovalRequest)
            .where(
                ApprovalRequest.state == "open",
                ApprovalRequest.expires_at.is_not(None),
                ApprovalRequest.expires_at <= now,
            )
            .values(state="expired")
            .returning(ApprovalRequest)
        )
        return list(result.scalars())


class AgentSessionActivityStore:
    async def status_for_update(
        self,
        session: AsyncSession,
        agent_id: str,
        session_id: str,
        turn_id: str,
        item_id: str,
    ) -> str | None:
        """The row's stored status, locked until the transaction ends, or None."""
        status: str | None = await session.scalar(
            select(AgentSessionActivityItem.status)
            .where(
                AgentSessionActivityItem.agent_id == agent_id,
                AgentSessionActivityItem.session_id == session_id,
                AgentSessionActivityItem.turn_id == turn_id,
                AgentSessionActivityItem.item_id == item_id,
            )
            .with_for_update()
        )
        return status

    async def end_orphaned_turns(
        self,
        session: AsyncSession,
        *,
        offline_quiet: timedelta,
        session_quiet: timedelta,
        lease_ttl: timedelta,
        heartbeat_ttl: timedelta,
        text: str,
    ) -> list[tuple[str, str, str]]:
        """End, as interrupted, the turns still queued or running that their
        session can no longer finish, keyed on the session rather than the
        agent:

        - its session is live when it is placed (`AgentSessionPlacement`) over
          a connection whose process holds its lease, or when a heartbeat for
          the turn's room is fresh. A live session's turn is never ended;
        - otherwise the turn is ended once nothing in it has moved for
          `offline_quiet` if the agent has no live connection and no fresh
          heartbeat at all, or for the longer `session_quiet` if the agent is
          still connected (its controller, or another session, is up while
          this session went quiet).

        The revision moves on, so the change is announced like a host's, and a
        host that was in fact still working overrides it with its next report.
        Returns (agent, session, turn) of each."""
        other = AgentSessionActivityItem.__table__.alias("other")
        turn = AgentSessionActivityItem

        def quiet(for_: timedelta) -> ColumnElement[bool]:
            return ~exists().where(
                other.c.tenant_id == turn.tenant_id,
                other.c.agent_id == turn.agent_id,
                other.c.session_id == turn.session_id,
                other.c.turn_id == turn.turn_id,
                other.c.updated_at > func.now() - literal(for_),
            )

        def held(process_id: Any) -> ColumnElement[bool]:
            return exists().where(
                SwitchCoreProcess.id == process_id,
                SwitchCoreProcess.stopped_at.is_(None),
                SwitchCoreProcess.beat_at > func.now() - literal(lease_ttl),
            )

        placed = exists().where(
            AgentSessionPlacement.agent_id == turn.agent_id,
            AgentSessionPlacement.session_id == turn.session_id,
            AgentConnectionRecord.id == AgentSessionPlacement.connection_id,
            held(AgentConnectionRecord.process_id),
        )
        beating_here = exists().where(
            AgentSession.agent_id == turn.agent_id,
            AgentSession.room_id == turn.room_id,
            AgentSession.lifecycle == "heartbeat",
            AgentSession.last_seen_at > func.now() - literal(heartbeat_ttl),
        )
        connected = exists().where(
            AgentConnectionRecord.agent_id == turn.agent_id,
            AgentConnectionRecord.closed_at.is_(None),
            held(AgentConnectionRecord.process_id),
        )
        beating = exists().where(
            AgentSession.agent_id == turn.agent_id,
            AgentSession.lifecycle == "heartbeat",
            AgentSession.last_seen_at > func.now() - literal(heartbeat_ttl),
        )
        result = await session.execute(
            update(turn)
            .where(
                turn.item_id == TURN_ITEM_ID,
                turn.status.in_(("queued", "running")),
                ~placed,
                ~beating_here,
                or_(
                    and_(quiet(offline_quiet), ~connected, ~beating),
                    quiet(session_quiet),
                ),
            )
            .values(
                status="interrupted",
                text=text,
                revision=turn.revision + 1,
                updated_at=func.now(),
            )
            .returning(turn.agent_id, turn.session_id, turn.turn_id)
        )
        return [
            (agent_id, session_id, turn_id)
            for agent_id, session_id, turn_id in result.all()
        ]

    async def upsert(
        self, session: AsyncSession, item: AgentSessionActivityItem
    ) -> bool:
        """Record `item` unless a revision at least as new is stored.

        True when this call inserted the row or moved it forward. An equal or
        older revision changes nothing, and so announces nothing.
        """
        values = {
            column.key: getattr(item, column.key)
            for column in AgentSessionActivityItem.__table__.columns
            if column.key not in ("created_at", "updated_at")
            and not (column.key == "tenant_id" and item.tenant_id is None)
        }
        statement = insert(AgentSessionActivityItem).values(**values)
        moved = {
            key: statement.excluded[key]
            for key in (
                "kind",
                "revision",
                "status",
                "title",
                "text",
                "command_id",
                "room_id",
                "thread_id",
                "message_id",
                "occurred_at",
            )
        }
        result = await session.execute(
            statement.on_conflict_do_update(
                index_elements=[
                    AgentSessionActivityItem.tenant_id,
                    AgentSessionActivityItem.agent_id,
                    AgentSessionActivityItem.session_id,
                    AgentSessionActivityItem.turn_id,
                    AgentSessionActivityItem.item_id,
                ],
                set_={**moved, "updated_at": func.now()},
                where=AgentSessionActivityItem.revision < statement.excluded.revision,
            ).returning(AgentSessionActivityItem.item_id)
        )
        return result.scalar_one_or_none() is not None

    async def turn(
        self, session: AsyncSession, agent_id: str, session_id: str, turn_id: str
    ) -> list[AgentSessionActivityItem]:
        """Every step of one turn, in the order each was first reported."""
        result = await session.execute(
            select(AgentSessionActivityItem)
            .where(
                AgentSessionActivityItem.agent_id == agent_id,
                AgentSessionActivityItem.session_id == session_id,
                AgentSessionActivityItem.turn_id == turn_id,
            )
            .order_by(
                AgentSessionActivityItem.created_at, AgentSessionActivityItem.item_id
            )
        )
        return list(result.scalars())

    async def turns_of_session(
        self, session: AsyncSession, agent_id: str, session_id: str
    ) -> list[AgentSessionActivityItem]:
        """The turn rows of one session, oldest first."""
        result = await session.execute(
            select(AgentSessionActivityItem)
            .where(
                AgentSessionActivityItem.agent_id == agent_id,
                AgentSessionActivityItem.session_id == session_id,
                AgentSessionActivityItem.item_id == TURN_ITEM_ID,
            )
            .order_by(AgentSessionActivityItem.created_at)
        )
        return list(result.scalars())

    async def turn_for_message(
        self, session: AsyncSession, agent_id: str, room_id: str, message_id: str
    ) -> AgentSessionActivityItem | None:
        """The agent's latest turn started by `message_id` in `room_id`, if it took one."""
        result = await session.execute(
            select(AgentSessionActivityItem)
            .where(
                AgentSessionActivityItem.agent_id == agent_id,
                AgentSessionActivityItem.room_id == room_id,
                AgentSessionActivityItem.message_id == message_id,
                AgentSessionActivityItem.item_id == TURN_ITEM_ID,
            )
            .order_by(AgentSessionActivityItem.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def newest_running_turn(
        self, session: AsyncSession, agent_id: str
    ) -> AgentSessionActivityItem | None:
        """The agent's most recently reported running turn row; queued turns wait behind it."""
        result = await session.execute(
            select(AgentSessionActivityItem)
            .where(
                AgentSessionActivityItem.agent_id == agent_id,
                AgentSessionActivityItem.item_id == TURN_ITEM_ID,
                AgentSessionActivityItem.status == "running",
            )
            .order_by(AgentSessionActivityItem.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def for_room(
        self, session: AsyncSession, room_id: str, since: datetime
    ) -> list[AgentSessionActivityItem]:
        """Steps placed in `room_id` changed since `since`, in first-reported order."""
        result = await session.execute(
            select(AgentSessionActivityItem)
            .where(
                AgentSessionActivityItem.room_id == room_id,
                AgentSessionActivityItem.updated_at >= since,
            )
            .order_by(
                AgentSessionActivityItem.created_at, AgentSessionActivityItem.item_id
            )
        )
        return list(result.scalars())

    async def scrub_hidden_tool_text(
        self,
        session: AsyncSession,
        *,
        room_id: str | None,
        agent_id: str | None,
    ) -> None:
        """Empty the stored input and output of tool calls that tool details
        no longer show: the room's setting when it has one, else its agent's.

        Run when a setting is turned off or cleared, for the room or the agent
        that changed. A row written while the setting was on still holds its
        text, and readers show a row as stored.
        """
        room_flag = (
            select(Room.metadata_["tool_details"].as_boolean())
            .where(Room.id == AgentSessionActivityItem.room_id)
            .scalar_subquery()
        )
        agent_flag = (
            select(Agent.tool_details)
            .where(Agent.id == AgentSessionActivityItem.agent_id)
            .scalar_subquery()
        )
        hidden = or_(
            room_flag.is_(False),
            and_(room_flag.is_(None), func.coalesce(agent_flag, False).is_(False)),
        )
        scope = [
            AgentSessionActivityItem.kind == "tool-activity",
            AgentSessionActivityItem.text != "",
            hidden,
        ]
        if room_id is not None:
            scope.append(AgentSessionActivityItem.room_id == room_id)
        if agent_id is not None:
            scope.append(AgentSessionActivityItem.agent_id == agent_id)
        await session.execute(
            update(AgentSessionActivityItem).where(*scope).values(text="")
        )

    async def prune_before(self, session: AsyncSession, cutoff: datetime) -> int:
        result = await session.execute(
            delete(AgentSessionActivityItem).where(
                AgentSessionActivityItem.updated_at < cutoff
            )
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
