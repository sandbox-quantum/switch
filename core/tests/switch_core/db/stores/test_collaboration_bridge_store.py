from __future__ import annotations

import asyncio
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


@pytest.mark.asyncio
async def test_set_channel_team_merges_rather_than_replaces(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Learning one channel's team must not forget the others.

    The map is a single JSONB value, so a write that assigned instead of
    merging would drop every channel learned before it — and each loss costs
    Teams channel capture until the bot is mentioned in that channel again.
    """
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)

        await store.set_channel_team(session, bridge_id, "19:a@thread.tacv2", "team-1")
        await store.set_channel_team(session, bridge_id, "19:b@thread.tacv2", "team-2")
        await session.commit()

    async with session_factory() as session:
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.connection_config["channel_teams"] == {
            "19:a@thread.tacv2": "team-1",
            "19:b@thread.tacv2": "team-2",
        }


@pytest.mark.asyncio
async def test_set_channel_team_updates_a_channel_that_moved(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)

        await store.set_channel_team(session, bridge_id, "19:a@thread.tacv2", "team-1")
        await store.set_channel_team(session, bridge_id, "19:a@thread.tacv2", "team-2")
        await session.commit()

    async with session_factory() as session:
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.connection_config["channel_teams"] == {
            "19:a@thread.tacv2": "team-2"
        }


@pytest.mark.asyncio
async def test_set_channel_team_leaves_the_rest_of_the_config_alone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)
        await store.set_service_url(session, bridge_id, "https://smba.example")

        await store.set_channel_team(session, bridge_id, "19:a@thread.tacv2", "team-1")
        await session.commit()

    async with session_factory() as session:
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.connection_config["service_url"] == "https://smba.example"
        assert bridge.connection_config["channel_teams"]


@pytest.mark.asyncio
async def test_set_channel_team_unknown_bridge_raises(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        with pytest.raises(ValueError):
            await store.set_channel_team(session, "does-not-exist", "19:a", "team-1")


@pytest.mark.asyncio
async def test_concurrent_channel_team_writes_do_not_lose_each_other(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The Teams bridge persists a channel's team the first time it sees that
    channel, each from its own session — so a burst of new channels is a burst
    of concurrent read-modify-writes on one JSONB value. Unlocked, the last
    write won and the rest vanished; measured at eight concurrent writes
    landing two. A dropped entry is the exact state that makes Graph refuse
    that channel's subscription after the next restart.
    """
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)
        await session.commit()

    async def write(index: int) -> None:
        # Mirrors lifecycle_service._persist_channel_team: its own session.
        async with session_factory() as session:
            await store.set_channel_team(
                session, bridge_id, f"19:c{index}@thread.tacv2", f"team-{index}"
            )
            await session.commit()

    await asyncio.gather(*(write(i) for i in range(8)))

    async with session_factory() as session:
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.connection_config["channel_teams"] == {
            f"19:c{i}@thread.tacv2": f"team-{i}" for i in range(8)
        }


@pytest.mark.asyncio
async def test_a_service_url_write_does_not_clobber_learned_channel_teams(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # The two writers share one JSONB column, so they race each other as well
    # as themselves.
    store = CollaborationBridgeStore()
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)
        await session.commit()

    async def set_team() -> None:
        async with session_factory() as session:
            await store.set_channel_team(
                session, bridge_id, "19:a@thread.tacv2", "team-1"
            )
            await session.commit()

    async def set_url() -> None:
        async with session_factory() as session:
            await store.set_service_url(session, bridge_id, "https://smba.example")
            await session.commit()

    await asyncio.gather(set_team(), set_url())

    async with session_factory() as session:
        bridge = await store.get(session, bridge_id)
        assert bridge is not None
        assert bridge.connection_config["service_url"] == "https://smba.example"
        assert bridge.connection_config["channel_teams"] == {
            "19:a@thread.tacv2": "team-1"
        }
