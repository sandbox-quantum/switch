from datetime import UTC, datetime, timedelta

from sqlalchemy import func, literal_column, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentSession

_CONFLICT_TARGET = [
    AgentSession.agent_id,
    func.coalesce(AgentSession.room_id, literal_column("''")),
]


class AgentSessionStore:
    """Reachability tracking and MCP-session room bindings.

    One row per (agent_id, room_id). The row carries two independent pieces
    of state:

    - `lifecycle` + `last_seen_at`: reachability. "heartbeat" rows are kept
      fresh by poll handlers (always_on, session_addressable) and considered
      live while `last_seen_at` is within the TTL. "explicit" rows
      (session_passive) are not used for liveness — the connection_model
      determines reachability.
    - `transport_session_id`: the MCP transport currently bound to this
      (agent, room), set by `connect_to_room`. Independent of lifecycle.

    `touch_heartbeat` never clears `transport_session_id`, so a connected
    MCP session survives concurrent heartbeats.

    Two connection models feed liveness, each with its own freshness window
    (see `get_live_agent_ids`). They are distinguished purely by the `room_id`
    they heartbeat against — `None` for always_on (room-agnostic), a concrete
    room for session_addressable — so the TTL can be chosen per model without
    a schema change.
    """

    # always_on agents (server-side connectors) refresh their heartbeat as a
    # side effect of re-entering poll_events, so the gap between beats is
    # bounded below by the poll long-poll timeout — 30s for the server
    # connector (see CONNECTOR_POLL_TIMEOUT_SECONDS) — and grows further while
    # the agent is busy handling an event. 90s gives that 30s cadence ~3x
    # headroom so always_on agents stay live across idle long-polls and slow
    # event handling, while a genuinely crashed agent still drops within 90s.
    ALWAYS_ON_TTL = timedelta(seconds=90)

    # session_addressable agents (the Claude Code plugin) renew their heartbeat
    # on a dedicated fast cadence (POST /connection/renew every 2s from the
    # channel process), decoupled from polling. A much lower TTL is therefore
    # safe and desirable: a closed/crashed session drops to "no session" within
    # ~6s instead of 90s. 6s gives the 2s renew 3x headroom (tolerates two
    # fully-missed renews) against transient network/DB slowness so a healthy
    # session does not flap to offline.
    SESSION_TTL = timedelta(seconds=6)

    async def touch_heartbeat(
        self,
        session: AsyncSession,
        agent_id: str,
        room_id: str | None,
    ) -> None:
        now = datetime.now(UTC)
        stmt = insert(AgentSession).values(
            agent_id=agent_id,
            room_id=room_id,
            transport_session_id=None,
            lifecycle="heartbeat",
            last_seen_at=now,
        )
        # Only refresh liveness — never clobber a transport_session_id written
        # by connect_to_room. The MCP transport binding and the heartbeat
        # share a row (per the (agent_id, room_id) unique index) but are
        # independent concerns.
        stmt = stmt.on_conflict_do_update(
            index_elements=_CONFLICT_TARGET,  # type: ignore[arg-type]
            set_={
                "lifecycle": "heartbeat",
                "last_seen_at": now,
            },
        )
        await session.execute(stmt)

    async def set_connected_room(
        self,
        session: AsyncSession,
        agent_id: str,
        room_id: str,
        transport_session_id: str,
        lifecycle: str,
    ) -> None:
        """Bind an MCP transport session to a room.

        Upserts on (agent_id, room_id). `lifecycle` is "explicit" for
        session_passive agents (the row's sole purpose is the transport
        binding) and "heartbeat" for always_on / session_addressable agents
        (the row also tracks liveness via touch_heartbeat). The on-conflict
        update never downgrades an existing "heartbeat" row to "explicit"
        — it only updates the transport binding and last_seen_at.
        """
        now = datetime.now(UTC)
        # A transport session is bound to at most one room at a time. If this
        # transport was previously bound to a different (agent, room) row
        # (e.g. connect_to_room was called for room X, then room Y), clear
        # that stale binding before writing the new one — otherwise
        # get_connected_room would see two rows with the same
        # transport_session_id and return whichever the DB picked first.
        await session.execute(
            update(AgentSession)
            .where(AgentSession.transport_session_id == transport_session_id)
            .where(AgentSession.room_id != room_id)
            .values(transport_session_id=None)
        )
        stmt = insert(AgentSession).values(
            agent_id=agent_id,
            room_id=room_id,
            transport_session_id=transport_session_id,
            lifecycle=lifecycle,
            last_seen_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=_CONFLICT_TARGET,  # type: ignore[arg-type]
            set_={
                "transport_session_id": transport_session_id,
                "last_seen_at": now,
            },
        )
        await session.execute(stmt)

    async def get_connected_room(
        self, session: AsyncSession, transport_session_id: str
    ) -> tuple[str, str] | None:
        """Look up the room an MCP transport session is bound to.

        Returns (agent_id, room_id) or None if not connected.
        """
        result = await session.execute(
            select(AgentSession.agent_id, AgentSession.room_id).where(
                AgentSession.transport_session_id == transport_session_id,
            )
        )
        row = result.first()
        if row is None:
            return None
        return (row[0], row[1])

    async def has_room_binding(
        self, session: AsyncSession, agent_id: str, room_id: str
    ) -> bool:
        """Return True if `agent_id` has ever bound a transport to `room_id`.

        A row qualifies when `connect_to_room` has set a `transport_session_id`
        for this (agent, room). Liveness is NOT checked — there is no reliable
        session-close signal, so the binding lingers after a session ends.
        Paired with a liveness check by the caller: a binding present while the
        agent is not live means a session_addressable session is connected but
        not reporting in (e.g. launched without the dev-channels flag).
        """
        result = await session.execute(
            select(AgentSession.agent_id)
            .where(AgentSession.agent_id == agent_id)
            .where(AgentSession.room_id == room_id)
            .where(AgentSession.transport_session_id.is_not(None))
            .limit(1)
        )
        return result.first() is not None

    async def live_connected_rooms(
        self, session: AsyncSession, agent_id: str
    ) -> list[str]:
        """Return the room ids where `agent_id` has a live, room-bound session.

        A row qualifies when it carries an MCP transport binding (set by
        connect_to_room), names a concrete room, and its heartbeat is fresh
        within SESSION_TTL. This is the set of rooms a session_addressable
        agent's session(s) are currently attending — used to tell an asker
        where to find an agent that has no live session in the room they
        addressed it from. always_on rows (room-agnostic heartbeat) and
        session_passive rows (lifecycle="explicit") do not qualify.
        """
        cutoff = datetime.now(UTC) - self.SESSION_TTL
        result = await session.execute(
            select(AgentSession.room_id)
            .where(AgentSession.agent_id == agent_id)
            .where(AgentSession.room_id.is_not(None))
            .where(AgentSession.transport_session_id.is_not(None))
            .where(AgentSession.lifecycle == "heartbeat")
            .where(AgentSession.last_seen_at > cutoff)
        )
        return [room_id for room_id in result.scalars().all() if room_id is not None]

    async def get_sessions_for_agent(
        self, session: AsyncSession, agent_id: str
    ) -> list[AgentSession]:
        """Return every session row for an agent.

        One row per room the agent has a session in, plus any room-agnostic
        (`room_id IS NULL`) always_on heartbeat row. Liveness is not filtered
        here — the caller derives each row's state from `lifecycle`,
        `last_seen_at`, and the connection model's TTL. Used by the agent
        detail view to show all current sessions and their state.
        """
        result = await session.execute(
            select(AgentSession).where(AgentSession.agent_id == agent_id)
        )
        return list(result.scalars().all())

    async def get_live_agent_ids(
        self,
        session: AsyncSession,
        agent_ids: list[str],
        room_id: str | None,
    ) -> set[str]:
        """Return the subset of `agent_ids` with a fresh heartbeat for `room_id`.

        `room_id=None` matches rows with `room_id IS NULL` (always_on agents)
        and applies `ALWAYS_ON_TTL`; a concrete `room_id` matches the
        room-scoped rows of session_addressable agents and applies the much
        shorter `SESSION_TTL`. Only heartbeat rows within the TTL count as
        live; explicit rows are not used for liveness.
        """
        if not agent_ids:
            return set()

        ttl = self.ALWAYS_ON_TTL if room_id is None else self.SESSION_TTL
        cutoff = datetime.now(UTC) - ttl
        room_pred = (
            AgentSession.room_id.is_(None)
            if room_id is None
            else AgentSession.room_id == room_id
        )
        result = await session.execute(
            select(AgentSession.agent_id)
            .where(AgentSession.agent_id.in_(agent_ids))
            .where(room_pred)
            .where(AgentSession.lifecycle == "heartbeat")
            .where(AgentSession.last_seen_at > cutoff)
        )
        return set(result.scalars().all())
