"""Template installs against real Postgres: what a run records, what goes
with its agent, and two servers moving the same install at once."""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    TemplateInstallResource,
    User,
)
from switch_core.db.stores.template_install_store import (
    NewInstallResource,
    TemplateInstallStore,
)

_STORE = TemplateInstallStore()


async def _agent(session: AsyncSession, name: str) -> Agent:
    owner = User(
        id=f"owner-{name}", name=name, email=f"{name}@example.test", role="user"
    )
    session.add(owner)
    await session.flush()
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{name}",
        encrypted_key="",
        label="unused fixture",
        type="agent",
    )
    session.add_all([client, key])
    await session.flush()
    agent = Agent(
        name=name,
        description="test agent",
        agent_type="session_addressable",
        connector_type="claude",
        integration_profile={},
        client_id=client.id,
        api_key_id=key.id,
        owner_id=owner.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _install(session: AsyncSession, agent: Agent, *, revision: int = 1):
    return await _STORE.create(
        session,
        owner_id=agent.owner_id,
        source="official",
        template_id="official:switch-buddy",
        template_name="switch-buddy",
        revision=revision,
        inputs={"agent_name": agent.name},
        builtins={"$creator": "max"},
        resources=[
            NewInstallResource(
                key="buddy",
                agent_id=agent.id,
                room_id=None,
                fingerprints={"instructions": "abc"},
            )
        ],
    )


async def test_an_agent_is_found_by_the_install_that_made_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "switch-buddy-max")
        install = await _install(session, agent, revision=3)
        await session.commit()

    async with session_factory() as session:
        found = await _STORE.for_agent(session, agent.id)
        assert found is not None
        got, resource = found
        assert (got.id, got.template_id, got.revision) == (
            install.id,
            "official:switch-buddy",
            3,
        )
        assert (resource.key, resource.fingerprints) == (
            "buddy",
            {"instructions": "abc"},
        )
        assert await _STORE.agents_installed_from(
            session, "official:switch-buddy", "buddy"
        ) == {agent.id}
        assert await _STORE.for_agent(session, "someone-else") is None


async def test_the_record_goes_with_its_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "switch-buddy-max")
        install = await _install(session, agent)
        await session.commit()

    async with session_factory() as session:
        await session.execute(delete(Agent).where(Agent.id == agent.id))
        await session.commit()

    async with session_factory() as session:
        assert await _STORE.resources(session, install.id) == []


async def test_an_agent_belongs_to_one_install_at_most(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "switch-buddy-max")
        await _install(session, agent)
        await session.commit()

    async with session_factory() as session:
        with pytest.raises(IntegrityError):
            await _install(session, agent)


async def test_a_resource_is_an_agent_or_a_room_never_both_or_neither(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "switch-buddy-max")
        install = await _install(session, agent)
        await session.commit()

    async with session_factory() as session:
        session.add(
            TemplateInstallResource(
                install_id=install.id,
                key="nothing",
                agent_id=None,
                room_id=None,
                fingerprints={},
            )
        )
        with pytest.raises(IntegrityError):
            await session.flush()


async def test_of_two_servers_moving_an_install_only_one_does(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "switch-buddy-max")
        install = await _install(session, agent, revision=1)
        await session.commit()

    async with session_factory() as session:
        assert await _STORE.move_to_revision(session, install.id, from_revision=1, to=2)
        await session.commit()
    async with session_factory() as session:
        assert not await _STORE.move_to_revision(
            session, install.id, from_revision=1, to=2
        )
        await session.commit()

    async with session_factory() as session:
        (got,) = await _STORE.of_template(session, "official:switch-buddy")
        assert got.revision == 2


async def test_fingerprints_are_replaced_whole(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session, "switch-buddy-max")
        install = await _install(session, agent)
        (resource,) = await _STORE.resources(session, install.id)
        await _STORE.set_fingerprints(session, resource.id, {"description": "d"})
        await session.commit()

    async with session_factory() as session:
        stored = (
            await session.execute(
                select(TemplateInstallResource.fingerprints).where(
                    TemplateInstallResource.id == resource.id
                )
            )
        ).scalar_one()
        assert stored == {"description": "d"}
