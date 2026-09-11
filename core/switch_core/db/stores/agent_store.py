from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    ClientRoom,
    Model,
    Tool,
    require_tenant_id,
    room_agents,
)


class AgentStore:
    # ── Agent CRUD ────────────────────────────────────────────────────────────

    async def create(self, session: AsyncSession, agent: Agent) -> None:
        session.add(agent)
        await session.flush()

    async def get(self, session: AsyncSession, agent_id: str) -> Agent | None:
        return await session.get(Agent, agent_id)

    async def get_by_name(self, session: AsyncSession, name: str) -> Agent | None:
        """Resolve an agent by name within the bound tenant.

        Scoped explicitly rather than left to row-level security: `name` is
        unique per tenant (`uq_agents_tenant_name`), not globally, so the
        moment a second tenant has an agent of the same name, an unfiltered
        read here matches both rows and raises `MultipleResultsFound` out of
        every caller that resolves an agent by name — mention routing,
        registration, and the gateway's agent lookup among them.
        """
        result = await session.execute(
            select(Agent).where(
                Agent.tenant_id == require_tenant_id(), Agent.name == name
            )
        )
        return result.scalar_one_or_none()

    async def get_by_name_insensitive(
        self, session: AsyncSession, name: str
    ) -> Agent | None:
        """Resolve an agent by name, case-insensitively, within the bound tenant.

        Mirrors how `@name` mentions are matched (case-insensitive), so a tagged
        token resolves to the same agent the router would address. Scoped for
        the same reason as `get_by_name`.
        """
        result = await session.execute(
            select(Agent).where(
                Agent.tenant_id == require_tenant_id(),
                func.lower(Agent.name) == name.lower(),
            )
        )
        return result.scalar_one_or_none()

    async def get_by_client_id(
        self, session: AsyncSession, client_id: str
    ) -> Agent | None:
        result = await session.execute(
            select(Agent).where(Agent.client_id == client_id)
        )
        return result.scalar_one_or_none()

    async def get_by_api_key_id(
        self, session: AsyncSession, api_key_id: str
    ) -> Agent | None:
        result = await session.execute(
            select(Agent).where(Agent.api_key_id == api_key_id)
        )
        return result.scalar_one_or_none()

    async def get_by_oauth_client_id(
        self, session: AsyncSession, oauth_client_id: str
    ) -> Agent | None:
        result = await session.execute(
            select(Agent).where(Agent.oauth_client_id == oauth_client_id)
        )
        return result.scalar_one_or_none()

    async def get_by_names(
        self, session: AsyncSession, names: list[str]
    ) -> list[Agent]:
        result = await session.execute(select(Agent).where(Agent.name.in_(names)))
        return list(result.scalars().all())

    async def get_all(self, session: AsyncSession) -> list[Agent]:
        result = await session.execute(select(Agent))
        return list(result.scalars().all())

    async def get_children(
        self, session: AsyncSession, parent_agent_ids: list[str]
    ) -> list[Agent]:
        """Return all agents whose `parent_agent_id` is in `parent_agent_ids`.

        Used to cascade an agent's subagents (e.g. Claude Code subagents) into
        a room. Returns an empty list when `parent_agent_ids` is empty.
        """
        if not parent_agent_ids:
            return []
        result = await session.execute(
            select(Agent).where(Agent.parent_agent_id.in_(parent_agent_ids))
        )
        return list(result.scalars().all())

    async def update(
        self,
        session: AsyncSession,
        agent_id: str,
        **kwargs: object,
    ) -> None:
        agent = await session.get(Agent, agent_id)
        if agent is None:
            raise ValueError(f"Agent not found: {agent_id}")
        for key, value in kwargs.items():
            setattr(agent, key, value)
        await session.flush()

    async def delete(self, session: AsyncSession, agent_id: str) -> None:
        agent = await session.get(Agent, agent_id)
        if not agent:
            return
        await session.execute(delete(Tool).where(Tool.agent_id == agent_id))
        await session.execute(delete(Model).where(Model.agent_id == agent_id))
        await session.execute(
            delete(room_agents).where(room_agents.c.agent_id == agent_id)
        )
        await session.execute(
            delete(ClientRoom).where(ClientRoom.client_id == agent.client_id)
        )
        await session.delete(agent)
        await session.flush()

    # ── Tool CRUD ─────────────────────────────────────────────────────────────

    async def add_tool(self, session: AsyncSession, tool: Tool) -> None:
        session.add(tool)
        await session.flush()

    async def get_tools(self, session: AsyncSession, agent_id: str) -> list[Tool]:
        result = await session.execute(select(Tool).where(Tool.agent_id == agent_id))
        return list(result.scalars().all())

    async def get_tool(self, session: AsyncSession, tool_id: str) -> Tool | None:
        return await session.get(Tool, tool_id)

    async def remove_tool(self, session: AsyncSession, tool_id: str) -> None:
        tool = await session.get(Tool, tool_id)
        if tool:
            await session.delete(tool)
            await session.flush()

    # ── Model CRUD ────────────────────────────────────────────────────────────

    async def add_model(self, session: AsyncSession, model: Model) -> None:
        session.add(model)
        await session.flush()

    async def get_models(self, session: AsyncSession, agent_id: str) -> list[Model]:
        result = await session.execute(select(Model).where(Model.agent_id == agent_id))
        return list(result.scalars().all())

    async def get_model(self, session: AsyncSession, model_id: str) -> Model | None:
        return await session.get(Model, model_id)

    async def remove_model(self, session: AsyncSession, model_id: str) -> None:
        model = await session.get(Model, model_id)
        if model:
            await session.delete(model)
            await session.flush()
