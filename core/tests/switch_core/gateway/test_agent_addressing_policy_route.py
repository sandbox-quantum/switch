"""`PUT /agents/{id}/addressing-policy`: only an agent's owner lets more
people or agents address it. A workspace admin may narrow it, to stop an
agent misbehaving, and that change is recorded in the audit log."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import default_agent_policy, owner_only_policy
from switch_core.db.models import Agent, AuditEvent
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.role_matrix.harness import (
    TENANT,
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.world import World

OWNER_ONLY = owner_only_policy([]).model_dump()


async def _policy(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> dict[str, Any] | None:
    with tenant_scope(TENANT):
        async with session_factory() as session:
            agent = await session.get(Agent, agent_id)
            assert agent is not None
            return agent.addressing_policy


async def _set_policy(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    policy: dict[str, Any] | None,
) -> None:
    with tenant_scope(TENANT):
        async with session_factory() as session:
            agent = await session.get(Agent, agent_id)
            assert agent is not None
            agent.addressing_policy = policy
            await session.commit()


async def _audited(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[AuditEvent]:
    with tenant_scope(TENANT):
        async with session_factory() as session:
            return list(
                (
                    await session.execute(
                        select(AuditEvent).where(
                            AuditEvent.action == "agent.addressing_changed"
                        )
                    )
                )
                .scalars()
                .all()
            )


async def test_an_admin_may_narrow_who_addresses_a_members_agent_but_not_widen_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        world = World(session_factory, people, "addressing", http, gateway)
        agent_id = await world.agent()
        path = f"/gateway/agents/{agent_id}/addressing-policy"
        await _set_policy(
            session_factory, agent_id, default_agent_policy().model_dump()
        )

        widened: dict[str, int] = {}
        for persona in (Persona.WORKSPACE_ADMIN, Persona.ORG_ADMIN, Persona.OPERATOR):
            for label, policy in (
                ("open", None),
                ("anyone", {"rules": [{"users": "*", "agents": [], "owner": True}]}),
            ):
                response = await http.put(
                    path, json={"policy": policy}, headers=people.headers(persona)
                )
                widened[f"{persona.value} {label}"] = response.status_code
                if response.status_code == 403:
                    assert "Only the agent's owner" in response.json()["detail"]
        kept = await _policy(session_factory, agent_id)

        narrowed = await http.put(
            path,
            json={"policy": OWNER_ONLY},
            headers=people.headers(Persona.WORKSPACE_ADMIN),
        )
        detail = narrowed.json()

    assert set(widened.values()) == {403}, widened
    assert kept == default_agent_policy().model_dump()
    assert narrowed.status_code == 200, narrowed.text
    assert detail["addressing_policy"]["rules"][0]["owner_agents"] is False
    assert (detail["can_manage"], detail["can_widen_addressing"]) == (True, False)
    [event] = await _audited(session_factory)
    assert event.actor_user_id == people.ids[Persona.WORKSPACE_ADMIN]
    assert event.target_id == agent_id
    assert event.details is not None
    assert event.details["owner_id"] == people.ids[Persona.OWNER]
    assert event.details["before"] == default_agent_policy().model_dump()
    assert event.details["after"] == OWNER_ONLY


async def test_its_owner_may_open_it_and_is_not_audited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        world = World(session_factory, people, "addressing-owner", http, gateway)
        agent_id = await world.agent()
        await _set_policy(session_factory, agent_id, OWNER_ONLY)
        opened = await http.put(
            f"/gateway/agents/{agent_id}/addressing-policy",
            json={"policy": None},
            headers=people.headers(Persona.OWNER),
        )

    assert opened.status_code == 200, opened.text
    assert opened.json()["can_widen_addressing"] is True
    assert await _policy(session_factory, agent_id) is None
    assert await _audited(session_factory) == []
