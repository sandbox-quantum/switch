from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentRuntimeState

# The state a row collapses to when there is nothing live to surface. A row in
# this state contributes no bridge surface; the sweep resets stale sessions to
# it.
IDLE = "idle"


class AgentRuntimeStateStore:
    """Per-(agent, room) runtime state — what an agent's session is doing.

    One row per (agent, room), upserted as the Switch Console-managed session
    transitions. Not a liveness store (that is `AgentSessionStore`); this only
    records the last reported state so it can be queried (`!status`) and
    re-surfaced on the bridge.
    """

    async def upsert(
        self,
        session: AsyncSession,
        agent_id: str,
        room_id: str,
        state: str,
        deeplink_url: str | None = None,
        control_capabilities: dict | None = None,
    ) -> None:
        now = datetime.now(UTC)
        stmt = insert(AgentRuntimeState).values(
            agent_id=agent_id,
            room_id=room_id,
            state=state,
            deeplink_url=deeplink_url,
            control_capabilities=control_capabilities,
            updated_at=now,
        )
        set_: dict[str, object] = {"state": state, "updated_at": now}
        # Only overwrite the stored link when a new one is supplied, so a
        # deeplink-less report (e.g. the idle sweep) preserves the last-known
        # link rather than clearing it.
        if deeplink_url is not None:
            set_["deeplink_url"] = deeplink_url
        # Same preserve-on-omit rule for control capabilities: an idle/sweep
        # report carries none and must not wipe the last-known capabilities.
        if control_capabilities is not None:
            set_["control_capabilities"] = control_capabilities
        stmt = stmt.on_conflict_do_update(
            constraint="uq_agent_runtime_states_agent_room",
            set_=set_,
        )
        await session.execute(stmt)

    async def get(
        self, session: AsyncSession, agent_id: str, room_id: str
    ) -> AgentRuntimeState | None:
        result = await session.execute(
            select(AgentRuntimeState)
            .where(AgentRuntimeState.agent_id == agent_id)
            .where(AgentRuntimeState.room_id == room_id)
        )
        return result.scalar_one_or_none()

    async def get_by_room(
        self, session: AsyncSession, room_id: str
    ) -> list[AgentRuntimeState]:
        result = await session.execute(
            select(AgentRuntimeState).where(AgentRuntimeState.room_id == room_id)
        )
        return list(result.scalars().all())

    async def get_active(self, session: AsyncSession) -> list[AgentRuntimeState]:
        """Return every row not already collapsed to idle.

        These are the rows that surface something on a bridge; the sweep checks
        each one's session liveness and resets the stale ones to idle.
        """
        result = await session.execute(
            select(AgentRuntimeState).where(AgentRuntimeState.state != IDLE)
        )
        return list(result.scalars().all())
