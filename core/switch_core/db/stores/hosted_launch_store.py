from typing import cast

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, HostedLaunch, require_tenant_id


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
