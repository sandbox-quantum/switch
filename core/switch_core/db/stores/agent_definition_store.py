from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, AgentController, AgentDefinition


class AgentDefinitionStore:
    """Managed agent definitions, one per agent.

    Every read names its tenant as well as relying on the policy, for the
    reason `JoinDomainStore` gives.
    """

    async def create(
        self,
        session: AsyncSession,
        *,
        agent_id: str,
        owner_id: str,
        controller_id: str | None,
        desired_state: str,
        definition: dict[str, Any],
    ) -> AgentDefinition:
        row = AgentDefinition(
            agent_id=agent_id,
            owner_id=owner_id,
            controller_id=controller_id,
            revision=1,
            desired_state=desired_state,
            definition=definition,
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
        return row

    async def get_for_agent(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> AgentDefinition | None:
        result = await session.execute(
            select(AgentDefinition).where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id == agent_id,
            )
        )
        return result.scalar_one_or_none()

    async def on_cloud_controller(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> bool:
        """Whether the agent is placed on an ec2 controller, a Switch cloud
        machine's, which makes it a cloud agent."""
        placed = await session.scalar(
            select(AgentDefinition.agent_id)
            .join(
                AgentController,
                (AgentController.tenant_id == AgentDefinition.tenant_id)
                & (AgentController.id == AgentDefinition.controller_id),
            )
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id == agent_id,
                AgentController.kind == "ec2",
            )
        )
        return placed is not None

    async def list_for_owner(
        self, session: AsyncSession, tenant_id: str, owner_id: str
    ) -> list[tuple[AgentDefinition, Agent]]:
        result = await session.execute(
            select(AgentDefinition, Agent)
            .join(
                Agent,
                (Agent.id == AgentDefinition.agent_id)
                & (Agent.tenant_id == AgentDefinition.tenant_id),
            )
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.owner_id == owner_id,
            )
            .order_by(Agent.name)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def list_for_controller(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> list[tuple[AgentDefinition, Agent]]:
        result = await session.execute(
            select(AgentDefinition, Agent)
            .join(
                Agent,
                (Agent.id == AgentDefinition.agent_id)
                & (Agent.tenant_id == AgentDefinition.tenant_id),
            )
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.controller_id == controller_id,
            )
            .order_by(Agent.name)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def list_placed(
        self, session: AsyncSession, tenant_id: str
    ) -> list[AgentDefinition]:
        """Every definition placed on a controller."""
        result = await session.execute(
            select(AgentDefinition).where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.controller_id.is_not(None),
            )
        )
        return list(result.scalars().all())

    async def update(
        self,
        session: AsyncSession,
        tenant_id: str,
        agent_id: str,
        *,
        controller_id: str | None,
        desired_state: str,
        definition: dict[str, Any],
    ) -> AgentDefinition:
        """Replace the placement, desired state and definition, bumping the revision."""
        result = await session.execute(
            update(AgentDefinition)
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id == agent_id,
            )
            .values(
                controller_id=controller_id,
                desired_state=desired_state,
                definition=definition,
                revision=AgentDefinition.revision + 1,
            )
            .returning(AgentDefinition)
            .execution_options(synchronize_session=False, populate_existing=True)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise LookupError(f"No definition for agent: {agent_id}")
        return row

    async def delete(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> None:
        await session.execute(
            delete(AgentDefinition)
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id == agent_id,
            )
            .execution_options(synchronize_session=False)
        )
