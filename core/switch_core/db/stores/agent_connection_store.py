"""Agent connections as rows, so every switch-core process can see them.

The process holding a connection's socket writes its row when the connection
opens or is reattached and when it closes, and rewrites the agent's room claims
and session placements whenever they move. Nothing here is written per
heartbeat. A row is live while it is not closed and the process it names holds
its lease in `switch_core_processes`, so a process that dies without writing
its closings stops counting once its lease goes stale.

Every read names the agent or the tenant as well as relying on the policy, for
the reason `JoinDomainStore` gives: the owner connection the tests (and an
unrestricted deployment) run on is exempt from row-level security.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from sqlalchemy import (
    ColumnElement,
    and_,
    delete,
    exists,
    func,
    literal,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentConnectionRecord,
    AgentConnectionRoom,
    AgentSessionCommandRelay,
    AgentSessionPlacement,
    AgentSessionShare,
    SwitchCoreProcess,
)


@dataclass(frozen=True)
class ConnectionRow:
    """One `agent_connections` row, and whether its holder still holds it."""

    id: str
    agent_id: str
    process_id: str
    incarnation: int
    scope: str
    delivery_filter: str
    spawn_capable: bool
    transport: str
    speaks: int | None
    accepts: int | None
    closed: bool
    # The holding process's lease is held, or the holder is the process that
    # asked. A process never reads its own rows as lost: its lease going stale
    # means it could not reach the database, not that its sockets went.
    held: bool

    @property
    def live(self) -> bool:
        return self.held and not self.closed


@dataclass(frozen=True)
class AgentSlotRows:
    """Everything recorded about one agent's connections."""

    # Every row of the agent's connections, closed ones included.
    connections: dict[str, ConnectionRow]
    # Room -> the connection claiming it, as stored.
    stored_claims: dict[str, str]
    # Session -> (room, the connection that placed it), as stored.
    stored_placements: dict[str, tuple[str, str]]
    # Shared room -> (the session answering for it from its home room, the
    # connection that placed that session), as stored.
    stored_shares: dict[str, tuple[str, str]] = field(default_factory=dict)

    def live_connections(self) -> list[ConnectionRow]:
        return [row for row in self.connections.values() if row.live]

    def claims(self) -> dict[str, str]:
        """The claims that count: those of a live connection."""
        return {
            room_id: connection_id
            for room_id, connection_id in self.stored_claims.items()
            if (row := self.connections.get(connection_id)) is not None and row.live
        }

    def shares(self) -> dict[str, tuple[str, str]]:
        """The shares that count: those of a placement that counts."""
        placements = self.placements()
        return {
            room_id: shared
            for room_id, shared in self.stored_shares.items()
            if placements.get(shared[0], (None, None))[1] == shared[1]
        }

    def placements(self) -> dict[str, tuple[str, str]]:
        """The placements that count: those placed over a connection whose
        process still holds its lease, closed or not. A session keeps its room
        when the connection it arrived on lapses, as it did when this was kept
        in memory, and loses it when that process goes, as a restart did."""
        return {
            session_id: placed
            for session_id, placed in self.stored_placements.items()
            if (row := self.connections.get(placed[1])) is not None and row.held
        }


def _held(process_id: str, lease_ttl: timedelta) -> ColumnElement[bool]:
    return or_(
        AgentConnectionRecord.process_id == process_id,
        exists().where(
            SwitchCoreProcess.id == AgentConnectionRecord.process_id,
            SwitchCoreProcess.stopped_at.is_(None),
            SwitchCoreProcess.beat_at > func.now() - literal(lease_ttl),
        ),
    )


class AgentConnectionStore:
    async def lock_agent(self, session: AsyncSession, agent_id: str) -> None:
        """Hold the agent's room slots still until the transaction ends.

        Every process that moves a claim or a placement, or opens a
        connection, takes this first, so each move is made on what the others
        have committed and none is lost between a read and a write."""
        await session.execute(
            select(func.pg_advisory_xact_lock(func.hashtext("agent-slots:" + agent_id)))
        )

    async def incarnations(self, session: AsyncSession, count: int) -> list[int]:
        result = await session.execute(
            text(
                "SELECT nextval('agent_connection_incarnation') "
                "FROM generate_series(1, :count)"
            ),
            {"count": count},
        )
        return [int(value) for value in result.scalars().all()]

    async def read_agent(
        self,
        session: AsyncSession,
        agent_id: str,
        *,
        process_id: str,
        lease_ttl: timedelta,
    ) -> AgentSlotRows:
        found = await self._read(
            session,
            AgentConnectionRecord.agent_id == agent_id,
            AgentConnectionRoom.agent_id == agent_id,
            AgentSessionPlacement.agent_id == agent_id,
            AgentSessionShare.agent_id == agent_id,
            process_id=process_id,
            lease_ttl=lease_ttl,
        )
        return found.get(
            agent_id,
            AgentSlotRows(connections={}, stored_claims={}, stored_placements={}),
        )

    async def read_tenant(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        process_id: str,
        lease_ttl: timedelta,
    ) -> dict[str, AgentSlotRows]:
        """Every agent of the tenant that has a connection row."""
        return await self._read(
            session,
            AgentConnectionRecord.tenant_id == tenant_id,
            AgentConnectionRoom.tenant_id == tenant_id,
            AgentSessionPlacement.tenant_id == tenant_id,
            AgentSessionShare.tenant_id == tenant_id,
            process_id=process_id,
            lease_ttl=lease_ttl,
        )

    async def _read(
        self,
        session: AsyncSession,
        connections_where: ColumnElement[bool],
        claims_where: ColumnElement[bool],
        placements_where: ColumnElement[bool],
        shares_where: ColumnElement[bool],
        *,
        process_id: str,
        lease_ttl: timedelta,
    ) -> dict[str, AgentSlotRows]:
        rows = await session.execute(
            select(
                AgentConnectionRecord.id,
                AgentConnectionRecord.agent_id,
                AgentConnectionRecord.process_id,
                AgentConnectionRecord.incarnation,
                AgentConnectionRecord.scope,
                AgentConnectionRecord.delivery_filter,
                AgentConnectionRecord.spawn_capable,
                AgentConnectionRecord.transport,
                AgentConnectionRecord.speaks,
                AgentConnectionRecord.accepts,
                AgentConnectionRecord.closed_at.is_not(None),
                _held(process_id, lease_ttl),
            ).where(connections_where)
        )
        by_agent: dict[str, AgentSlotRows] = {}

        def of(agent_id: str) -> AgentSlotRows:
            return by_agent.setdefault(
                agent_id,
                AgentSlotRows(connections={}, stored_claims={}, stored_placements={}),
            )

        for (
            connection_id,
            agent_id,
            holder,
            incarnation,
            scope,
            delivery_filter,
            spawn_capable,
            transport,
            speaks,
            accepts,
            closed,
            held,
        ) in rows.all():
            of(agent_id).connections[connection_id] = ConnectionRow(
                id=connection_id,
                agent_id=agent_id,
                process_id=holder,
                incarnation=incarnation,
                scope=scope,
                delivery_filter=delivery_filter,
                spawn_capable=spawn_capable,
                transport=transport,
                speaks=speaks,
                accepts=accepts,
                closed=bool(closed),
                held=bool(held),
            )
        claims = await session.execute(
            select(
                AgentConnectionRoom.agent_id,
                AgentConnectionRoom.room_id,
                AgentConnectionRoom.connection_id,
            ).where(claims_where)
        )
        for agent_id, room_id, connection_id in claims.all():
            of(agent_id).stored_claims[room_id] = connection_id
        placements = await session.execute(
            select(
                AgentSessionPlacement.agent_id,
                AgentSessionPlacement.session_id,
                AgentSessionPlacement.room_id,
                AgentSessionPlacement.connection_id,
            ).where(placements_where)
        )
        for agent_id, session_id, room_id, connection_id in placements.all():
            of(agent_id).stored_placements[session_id] = (room_id, connection_id)
        shares = await session.execute(
            select(
                AgentSessionShare.agent_id,
                AgentSessionShare.room_id,
                AgentSessionShare.session_id,
                AgentSessionShare.connection_id,
            ).where(shares_where)
        )
        for agent_id, room_id, session_id, connection_id in shares.all():
            of(agent_id).stored_shares[room_id] = (session_id, connection_id)
        return by_agent

    async def record_open(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        connection_id: str,
        agent_id: str,
        process_id: str,
        incarnation: int,
        scope: str,
        delivery_filter: str,
        spawn_capable: bool,
        transport: str,
        speaks: int | None,
        accepts: int | None,
    ) -> bool:
        """The connection opened, or was reattached, on `process_id`. Returns
        whether it was written: an id another agent's connection has is left
        to that agent, whichever process recorded it."""
        values: dict[str, Any] = {
            "agent_id": agent_id,
            "process_id": process_id,
            "incarnation": incarnation,
            "scope": scope,
            "delivery_filter": delivery_filter,
            "spawn_capable": spawn_capable,
            "transport": transport,
            "speaks": speaks,
            "accepts": accepts,
            "attached_at": func.now(),
            "closed_at": None,
            "close_reason": None,
        }
        result = await session.execute(
            insert(AgentConnectionRecord)
            .values(id=connection_id, tenant_id=tenant_id, **values)
            .on_conflict_do_update(
                index_elements=[AgentConnectionRecord.id],
                set_=values,
                where=AgentConnectionRecord.agent_id == agent_id,
            )
            .returning(AgentConnectionRecord.id)
        )
        return result.scalar_one_or_none() is not None

    async def replace_slots(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str,
        claims: dict[str, str],
        placements: dict[str, tuple[str, str]],
        shares: dict[str, tuple[str, str]] | None = None,
    ) -> None:
        """Make these the agent's claims, placements and shares. Called with
        the agent locked (`lock_agent`), from a state read under the same
        lock."""
        await session.execute(
            delete(AgentConnectionRoom).where(AgentConnectionRoom.agent_id == agent_id)
        )
        await session.execute(
            delete(AgentSessionShare).where(AgentSessionShare.agent_id == agent_id)
        )
        await session.execute(
            delete(AgentSessionPlacement).where(
                AgentSessionPlacement.agent_id == agent_id
            )
        )
        if claims:
            await session.execute(
                insert(AgentConnectionRoom),
                [
                    {
                        "tenant_id": tenant_id,
                        "agent_id": agent_id,
                        "room_id": room_id,
                        "connection_id": connection_id,
                    }
                    for room_id, connection_id in claims.items()
                ],
            )
        if placements:
            await session.execute(
                insert(AgentSessionPlacement),
                [
                    {
                        "tenant_id": tenant_id,
                        "agent_id": agent_id,
                        "session_id": session_id,
                        "room_id": room_id,
                        "connection_id": connection_id,
                    }
                    for session_id, (room_id, connection_id) in placements.items()
                ],
            )
        if shares:
            await session.execute(
                insert(AgentSessionShare),
                [
                    {
                        "tenant_id": tenant_id,
                        "agent_id": agent_id,
                        "room_id": room_id,
                        "session_id": session_id,
                        "connection_id": connection_id,
                    }
                    for room_id, (session_id, connection_id) in shares.items()
                ],
            )

    async def record_closed(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        connection_id: str,
        incarnation: int,
        process_id: str,
        reason: str,
    ) -> bool:
        """The connection closed. Written only while the row still names this
        process and this incarnation, so a process closing a connection that
        has since been reattached elsewhere leaves the newer one standing.
        Returns whether the row was this one to close."""
        closed = await session.execute(
            update(AgentConnectionRecord)
            .where(
                AgentConnectionRecord.tenant_id == tenant_id,
                AgentConnectionRecord.id == connection_id,
                AgentConnectionRecord.incarnation == incarnation,
                AgentConnectionRecord.process_id == process_id,
                AgentConnectionRecord.closed_at.is_(None),
            )
            .values(closed_at=func.now(), close_reason=reason)
            .returning(AgentConnectionRecord.id)
        )
        if closed.first() is None:
            return False
        await session.execute(
            delete(AgentConnectionRoom).where(
                AgentConnectionRoom.tenant_id == tenant_id,
                AgentConnectionRoom.connection_id == connection_id,
            )
        )
        return True

    async def add_relay(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str,
        process_id: str,
        frame: dict[str, Any],
    ) -> None:
        session.add(
            AgentSessionCommandRelay(
                tenant_id=tenant_id,
                agent_id=agent_id,
                process_id=process_id,
                frame=frame,
            )
        )
        await session.flush()

    async def take_relays(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        process_id: str,
        agent_id: str | None,
    ) -> list[tuple[str, dict[str, Any]]]:
        """Delete and return the commands waiting for this process, for one
        agent or for every agent of the tenant, oldest first, as (agent id,
        frame)."""
        where = [
            AgentSessionCommandRelay.tenant_id == tenant_id,
            AgentSessionCommandRelay.process_id == process_id,
        ]
        if agent_id is not None:
            where.append(AgentSessionCommandRelay.agent_id == agent_id)
        taken = await session.execute(
            delete(AgentSessionCommandRelay)
            .where(*where)
            .returning(
                AgentSessionCommandRelay.agent_id,
                AgentSessionCommandRelay.frame,
                AgentSessionCommandRelay.created_at,
            )
        )
        rows = sorted(taken.all(), key=lambda row: row[2])
        return [(relay_agent, frame) for relay_agent, frame, _ in rows]

    async def prune(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        closed_before: timedelta,
        relays_before: timedelta,
    ) -> int:
        """Delete connections closed long ago or held by a process whose lease
        is gone, with their claims and placements, and commands nobody took.
        Returns how many connections."""
        gone = await session.execute(
            delete(AgentConnectionRecord)
            .where(
                AgentConnectionRecord.tenant_id == tenant_id,
                or_(
                    AgentConnectionRecord.closed_at
                    < func.now() - literal(closed_before),
                    ~exists().where(
                        SwitchCoreProcess.id == AgentConnectionRecord.process_id
                    ),
                ),
            )
            .returning(AgentConnectionRecord.id)
        )
        await session.execute(
            delete(AgentSessionCommandRelay).where(
                and_(
                    AgentSessionCommandRelay.tenant_id == tenant_id,
                    AgentSessionCommandRelay.created_at
                    < func.now() - literal(relays_before),
                )
            )
        )
        return len(gone.all())
