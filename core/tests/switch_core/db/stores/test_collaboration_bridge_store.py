from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore


async def _make_bridge(session: AsyncSession) -> str:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge client",
        type="bridge",
        password="x",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="mattermost",
        display_name="MM",
        client_id=client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


@pytest.mark.asyncio
async def test_agent_greetings_enabled_defaults_true(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.agent_greetings_enabled is True


@pytest.mark.asyncio
async def test_set_agent_greetings_enabled_toggles_and_persists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)

        updated = await store.set_agent_greetings_enabled(session, bridge_id, False)
        assert updated.agent_greetings_enabled is False
        await session.commit()

    async with session_factory() as session:
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.agent_greetings_enabled is False


@pytest.mark.asyncio
async def test_set_agent_greetings_enabled_unknown_bridge_raises(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        with pytest.raises(ValueError):
            await store.set_agent_greetings_enabled(session, "does-not-exist", False)


@pytest.mark.asyncio
async def test_no_default_bridge_until_one_is_nominated(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)

        assert await store.get_default(session) is None
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.is_default is False


@pytest.mark.asyncio
async def test_set_default_persists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)
        await store.set_default(session, bridge_id)
        await session.commit()

    async with session_factory() as session:
        default = await store.get_default(session)
        assert default is not None
        assert default.id == bridge_id


@pytest.mark.asyncio
async def test_nominating_a_new_default_demotes_the_previous_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Only one bridge may be default — promoting a second must demote the
    first rather than trip the partial unique index."""
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        first = await _make_bridge(session)
        second = await _make_bridge(session)

        await store.set_default(session, first)
        await store.set_default(session, second)
        await session.commit()

    async with session_factory() as session:
        default = await store.get_default(session)
        assert default is not None
        assert default.id == second

        demoted = await store.get(session, first)
        assert demoted is not None
        assert demoted.is_default is False


@pytest.mark.asyncio
async def test_set_default_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)

        await store.set_default(session, bridge_id)
        await store.set_default(session, bridge_id)
        await session.commit()

    async with session_factory() as session:
        default = await store.get_default(session)
        assert default is not None
        assert default.id == bridge_id


@pytest.mark.asyncio
async def test_set_default_unknown_bridge_raises(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        with pytest.raises(ValueError):
            await store.set_default(session, "does-not-exist")
