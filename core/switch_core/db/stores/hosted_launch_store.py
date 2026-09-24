from datetime import UTC, datetime
from typing import cast

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    HostedLaunch,
    HostedOperation,
    SdkSession,
    require_tenant_id,
)


class HostedLaunchConflict(Exception):
    pass


class HostedLaunchStore:
    async def reserve(
        self,
        session: AsyncSession,
        *,
        request_id: str,
        owner_id: str,
        name: str,
        spec: dict,
        capacity: int,
        owner_capacity: int,
        agent_ids: list[str],
    ) -> HostedLaunch:
        tenant_id = require_tenant_id()
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"hosted-launches:{tenant_id}"},
        )
        existing = await session.get(HostedLaunch, (tenant_id, request_id))
        if existing:
            if (
                existing.owner_id != owner_id
                or existing.name != name
                or existing.spec != spec
            ):
                raise HostedLaunchConflict(
                    "This launch request was already used for different agent details."
                )
            return existing
        if await session.scalar(
            select(Agent.id).where(Agent.tenant_id == tenant_id, Agent.name == name)
        ):
            raise HostedLaunchConflict("An agent already uses this name.")
        launches = list(
            (
                await session.scalars(
                    select(HostedLaunch).where(HostedLaunch.tenant_id == tenant_id)
                )
            ).all()
        )
        if any(launch.name == name for launch in launches):
            raise HostedLaunchConflict(
                "A cloud launch already reserves this agent name."
            )
        active = [launch for launch in launches if launch.state != "deleted"]
        if sum(launch.owner_id == owner_id for launch in active) >= owner_capacity:
            raise HostedLaunchConflict(
                "Your cloud agent limit has been reached. Remove a stopped worker before creating another."
            )
        if len(active) >= capacity:
            raise HostedLaunchConflict(
                "Cloud agent capacity is full. Contact your server administrator."
            )
        used = {launch.agent_id for launch in launches}
        agent_id = next((value for value in agent_ids if value not in used), None)
        if agent_id is None:
            raise HostedLaunchConflict("No cloud worker identity is available.")
        launch = HostedLaunch(
            id=request_id,
            owner_id=owner_id,
            name=name,
            spec=spec,
            state="queued",
            agent_id=agent_id,
        )
        session.add(launch)
        await session.flush()
        return launch

    async def owned(
        self, session: AsyncSession, request_id: str, owner_id: str
    ) -> HostedLaunch | None:
        return cast(
            HostedLaunch | None,
            await session.scalar(
                select(HostedLaunch).where(
                    HostedLaunch.tenant_id == require_tenant_id(),
                    HostedLaunch.id == request_id,
                    HostedLaunch.owner_id == owner_id,
                )
            ),
        )

    async def idle_busy(self, session: AsyncSession, launch: HostedLaunch) -> bool:
        rows = await session.scalars(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.agent_id == launch.agent_id,
                SdkSession.lease_expires_at > datetime.now(UTC),
            )
        )
        for row in rows:
            state = row.snapshot.get("session", {})
            if not state.get("retired") and (
                state.get("status") in ("starting", "running")
                or state.get("pendingRequestIds")
            ):
                return True
        pending = await session.scalar(
            select(HostedOperation.id)
            .where(
                HostedOperation.tenant_id == require_tenant_id(),
                HostedOperation.launch_id == launch.id,
                HostedOperation.state.in_(["queued", "claimed"]),
            )
            .limit(1)
        )
        return pending is not None

    async def note_addressed(
        self, session: AsyncSession, launch_id: str
    ) -> HostedLaunch | None:
        """Record that the launch's agent was addressed, waking it if idle-stopped.

        Takes the same lock as the lifecycle and controller routes. The caller
        commits.
        """
        tenant_id = require_tenant_id()
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"hosted-launch:{tenant_id}:{launch_id}"},
        )
        launch = await session.get(HostedLaunch, (tenant_id, launch_id))
        if launch is None:
            return None
        now = datetime.now(UTC)
        if launch.sleeping and launch.desired_state == "stopped":
            launch.desired_state = "running"
            launch.state = "queued"
            launch.revision += 1
            launch.sleeping = False
            launch.error = None
            launch.active_at = now
            launch.updated_at = now
        elif launch.desired_state not in {"stopped", "deleted"}:
            launch.active_at = now
        return launch
