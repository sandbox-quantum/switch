from datetime import UTC, datetime, timedelta

from sqlalchemy import func, literal_column, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentSession

_CONFLICT_TARGET = [
    AgentSession.agent_id,
    func.coalesce(AgentSession.room_id, literal_column("''")),
]


class AgentSessionStore:
    """Reachability tracking from heartbeats.

    One row per (agent_id, room_id), kept fresh by the heartbeat routes and
    considered live while `last_seen_at` is within the TTL.

    Two connection models feed liveness, each with its own freshness window
    (see `get_live_agent_ids`). They are distinguished purely by the `room_id`
    they heartbeat against — `None` for always_on (room-agnostic), a concrete
    room for session_addressable — so the TTL can be chosen per model without
    a schema change.
    """

    # The room-agnostic beat (`POST /watch/heartbeat`, an auto_session
    # watcher) comes on a slow cadence. 90s leaves it several missed beats of
    # headroom, while a watcher that has genuinely gone still drops within 90s.
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
            lifecycle="heartbeat",
            last_seen_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=_CONFLICT_TARGET,  # type: ignore[arg-type]
            set_={
                "lifecycle": "heartbeat",
                "last_seen_at": now,
            },
        )
        await session.execute(stmt)

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
