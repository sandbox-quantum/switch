"""Per-room roles and their assumption leases.

A `RoomRole` is a named, room-scoped instruction bundle (see models). A
`RoleLease` records the current holder of a role, and is *live* while that
holder is — either because it renewed within `LEASE_TTL`, or because the SDK
session it names is still running (see `_live`). Liveness is computed at read
time, so a lease whose holder is gone is logically free and no background
reaper is needed.

The store is stateless: every method takes the `AsyncSession` as its first
argument and never commits (the caller owns the transaction), mirroring
`AgentSessionStore`.
"""

from collections.abc import Collection
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, false, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from switch_core.db.models import RoleLease, RoomRole


class RoomRoleStore:
    """CRUD for room roles plus lease acquire/renew/release."""

    # How long a self-renewing holder's heartbeat stays good for. It renews
    # every 2s, so 6s gives 3x headroom (tolerates two fully-missed renews): a
    # crashed or departed holder frees the seat within ~6s, while a healthy one
    # stays put across renews. A holder identified by its SDK session does not
    # renew and is not judged by this window — see `_live`.
    LEASE_TTL = timedelta(seconds=6)

    # ── Role definitions ──────────────────────────────────────────────────

    async def list_roles(self, session: AsyncSession, room_id: str) -> list[RoomRole]:
        result = await session.execute(
            select(RoomRole).where(RoomRole.room_id == room_id).order_by(RoomRole.name)
        )
        return list(result.scalars().all())

    async def get_role(
        self, session: AsyncSession, room_id: str, name: str
    ) -> RoomRole | None:
        result = await session.execute(
            select(RoomRole)
            .where(RoomRole.room_id == room_id)
            .where(RoomRole.name == name)
        )
        return result.scalar_one_or_none()

    async def define_role(
        self,
        session: AsyncSession,
        room_id: str,
        name: str,
        instructions: str,
        exclusive: bool,
    ) -> RoomRole:
        """Create a role.

        Raises ValueError if the name is empty, contains whitespace, or already
        exists in the room. Whitespace is rejected because roles are addressed
        with `@<name>` tokens (in messages and `send_targeted_message`); a name
        with a space could never be matched as a single mention token.
        """
        if not name or any(ch.isspace() for ch in name):
            raise ValueError("Role name must be non-empty and contain no whitespace")
        existing = await self.get_role(session, room_id, name)
        if existing is not None:
            raise ValueError(f"Role '{name}' already exists in this room")
        role = RoomRole(
            room_id=room_id,
            name=name,
            instructions=instructions,
            exclusive=exclusive,
        )
        session.add(role)
        await session.flush()
        return role

    async def edit_role(
        self,
        session: AsyncSession,
        room_id: str,
        name: str,
        instructions: str | None,
        exclusive: bool | None,
    ) -> RoomRole:
        """Update a role's instructions and/or exclusivity.

        Edits take effect on the next `assume_role`; current holders keep the
        instructions they already received. Raises ValueError if not found.
        """
        role = await self.get_role(session, room_id, name)
        if role is None:
            raise ValueError(f"Role '{name}' not found in this room")
        if instructions is not None:
            role.instructions = instructions
        if exclusive is not None:
            role.exclusive = exclusive
        await session.flush()
        return role

    async def delete_role(self, session: AsyncSession, room_id: str, name: str) -> None:
        """Delete a role (and, via cascade, any lease on it). Raises if absent."""
        role = await self.get_role(session, room_id, name)
        if role is None:
            raise ValueError(f"Role '{name}' not found in this room")
        await session.delete(role)
        await session.flush()

    # ── Leases ────────────────────────────────────────────────────────────

    def _cutoff(self) -> datetime:
        return datetime.now(UTC) - self.LEASE_TTL

    def _live(self, live_connection_ids: Collection[str]) -> ColumnElement[bool]:
        """SQL predicate for "this lease is still held".

        Two arms, both scoped to the holder rather than to the agent — which
        is the whole point, because an agent outlives the sessions and
        connections that take seats in its name.

        A holder that renews says so: `last_seen_at` is fresh. Otherwise a
        holder is live while the connection it took the seat over still is.
        For a session that is its agent's controller connection: Switch keeps
        no record of a session's own liveness, so a session's seat is freed
        when it releases it or when that connection goes.

        What is deliberately absent is the arm these replace: "the agent has
        some live connection". It was satisfied by *any* connection the agent
        happened to have, so an agent holding one permanent connection would
        never free a seat at all — a crashed session's role, which frees
        within seconds today, would have been held forever.
        """
        holder_connection_live = (
            RoleLease.transport_session_id.in_(live_connection_ids)
            if live_connection_ids
            else false()
        )
        return or_(
            RoleLease.last_seen_at > self._cutoff(),
            holder_connection_live,
        )

    async def get_live_lease(
        self,
        session: AsyncSession,
        role_id: str,
        live_connection_ids: Collection[str],
    ) -> RoleLease | None:
        """Return the live lease on an *exclusive* `role_id`, or None if free.

        Assumes at most one live holder, so it is only meaningful for exclusive
        roles (a shared role may have several — use `has_live_holder` or
        `live_holders_for_room` there). Raises if a shared role somehow has
        multiple live holders, which would be a bug worth surfacing.
        """
        result = await session.execute(
            select(RoleLease)
            .where(RoleLease.role_id == role_id)
            .where(self._live(live_connection_ids))
        )
        return result.scalar_one_or_none()

    async def has_live_holder(
        self,
        session: AsyncSession,
        role_id: str,
        live_connection_ids: Collection[str],
    ) -> bool:
        """True if at least one live lease holds `role_id` (any exclusivity)."""
        result = await session.execute(
            select(RoleLease.id)
            .where(RoleLease.role_id == role_id)
            .where(self._live(live_connection_ids))
            .limit(1)
        )
        return result.first() is not None

    async def get_agent_live_lease(
        self,
        session: AsyncSession,
        agent_id: str,
        live_connection_ids: Collection[str],
    ) -> RoleLease | None:
        """Return the agent's live lease (across any room), or None."""
        result = await session.execute(
            select(RoleLease)
            .where(RoleLease.agent_id == agent_id)
            .where(self._live(live_connection_ids))
        )
        return result.scalar_one_or_none()

    async def get_agent_lease(
        self, session: AsyncSession, agent_id: str
    ) -> RoleLease | None:
        """Return the agent's lease regardless of liveness, or None.

        Exposes `transport_session_id` (the session that assumed the role) so
        callers can locate where that specific session is currently connected.
        """
        result = await session.execute(
            select(RoleLease).where(RoleLease.agent_id == agent_id)
        )
        return result.scalar_one_or_none()

    async def live_holders_for_room(
        self,
        session: AsyncSession,
        room_id: str,
        live_connection_ids: Collection[str],
    ) -> dict[str, list[str]]:
        """Map role_id → live holder agent_ids for the room.

        A shared (non-exclusive) role may have several concurrent holders; an
        exclusive role has at most one. Roles with no live holder are absent.
        """
        result = await session.execute(
            select(RoleLease.role_id, RoleLease.agent_id)
            .where(RoleLease.room_id == room_id)
            .where(self._live(live_connection_ids))
        )
        holders: dict[str, list[str]] = {}
        for role_id, agent_id in result.all():
            holders.setdefault(role_id, []).append(agent_id)
        return holders

    async def live_leases_for_room(
        self,
        session: AsyncSession,
        room_id: str,
        live_connection_ids: Collection[str],
    ) -> dict[str, list[RoleLease]]:
        """Map role_id → live lease rows for the room.

        Like `live_holders_for_room`, but returns the full lease rows so callers
        can read each holder's `transport_session_id` (the session that assumed
        the role) and locate where that session is currently connected.
        """
        result = await session.execute(
            select(RoleLease)
            .where(RoleLease.room_id == room_id)
            .where(self._live(live_connection_ids))
        )
        leases: dict[str, list[RoleLease]] = {}
        for lease in result.scalars().all():
            leases.setdefault(lease.role_id, []).append(lease)
        return leases

    async def agent_room_role(
        self,
        session: AsyncSession,
        room_id: str,
        agent_id: str,
        live_connection_ids: Collection[str],
    ) -> str | None:
        """Return the role NAME the agent currently (live) holds in the room."""
        result = await session.execute(
            select(RoomRole.name)
            .join(RoleLease, RoleLease.role_id == RoomRole.id)
            .where(RoleLease.room_id == room_id)
            .where(RoleLease.agent_id == agent_id)
            .where(self._live(live_connection_ids))
        )
        return result.scalar_one_or_none()

    async def acquire_lease(
        self,
        session: AsyncSession,
        role: RoomRole,
        agent_id: str,
        transport_session_id: str | None,
        session_id: str | None,
        live_connection_ids: Collection[str],
    ) -> RoleLease:
        """Acquire the lease on `role` for `agent_id`.

        Enforces one live lease per agent and, for exclusive roles, a single
        live holder. Raises ValueError on conflict. A stale lease (the agent's
        own, or an exclusive role's previous holder) is cleared first so it does
        not block a legitimate (re)acquisition.

        `session_id` names the SDK session taking the role, when the caller
        identified itself as one. It is what `_live` and `touch_lease` key the
        holder on, so a lease recorded without it is held by the connection
        that assumed it and must renew its own heartbeat to stay alive.
        """
        now = datetime.now(UTC)

        # Reject if the agent already holds a *live* lease (one lease per session).
        existing = await self.get_agent_live_lease(
            session, agent_id, live_connection_ids
        )
        if existing is not None:
            if existing.role_id == role.id:
                # Idempotent re-assume of the same role: just refresh.
                await session.execute(
                    update(RoleLease)
                    .where(RoleLease.id == existing.id)
                    .values(
                        last_seen_at=now,
                        transport_session_id=transport_session_id,
                        session_id=session_id,
                    )
                )
                await session.flush()
                return existing
            raise ValueError(
                "You already hold a role lease; release it before assuming another"
            )

        if role.exclusive:
            holder = await self.get_live_lease(session, role.id, live_connection_ids)
            if holder is not None and holder.agent_id != agent_id:
                raise ValueError(
                    f"Role '{role.name}' is exclusive and currently held by another agent"
                )

        # Clear the agent's own (possibly stale) lease to satisfy the unique
        # (agent_id) index — one lease per agent. For an *exclusive* role also
        # clear the seat's previous (now-stale, since a live one was rejected
        # above) holder so this acquisition can take it. A shared role admits
        # multiple concurrent holders, so we must NOT touch co-holders' rows.
        clear = RoleLease.agent_id == agent_id
        if role.exclusive:
            clear = clear | (RoleLease.role_id == role.id)
        await session.execute(delete(RoleLease).where(clear))
        lease = RoleLease(
            role_id=role.id,
            room_id=role.room_id,
            agent_id=agent_id,
            transport_session_id=transport_session_id,
            session_id=session_id,
            acquired_at=now,
            last_seen_at=now,
        )
        session.add(lease)
        await session.flush()
        return lease

    async def touch_lease(
        self, session: AsyncSession, agent_id: str, holder: str | None
    ) -> bool:
        """Refresh the lease `holder` holds for `agent_id` (room-agnostic).

        Only the holder may renew. Keying this on the agent alone would let a
        sibling session — or the agent's controller, which holds no role at all
        — keep a dead session's seat occupied indefinitely, which is the same
        defect as an agent-wide liveness arm arriving by a different route.

        `holder` is None when the caller sent no identity, which a client
        older than the holder-scoped lease can still do. Such a caller may
        only renew a lease that names no session, because that is the only
        kind it can have taken: a session-held seat is never renewable by an
        anonymous beat.

        Returns True if a lease row was refreshed, False if the agent holds
        none or this caller is not its holder. Refreshes regardless of
        staleness, so a brief renew gap does not permanently drop a live
        holder.
        """
        owner = (
            RoleLease.session_id.is_(None)
            if holder is None
            else func.coalesce(RoleLease.session_id, RoleLease.transport_session_id)
            == holder
        )
        result = await session.execute(
            update(RoleLease)
            .where(RoleLease.agent_id == agent_id)
            .where(owner)
            .values(last_seen_at=datetime.now(UTC))
        )
        rowcount = result.rowcount  # type: ignore[attr-defined]
        return bool(rowcount > 0)

    async def release_lease(self, session: AsyncSession, agent_id: str) -> None:
        """Drop the agent's lease, if any. Idempotent."""
        await session.execute(delete(RoleLease).where(RoleLease.agent_id == agent_id))
