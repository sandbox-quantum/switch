from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import BridgeMessageMap, Client, CollaborationBridge
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore


async def _make_bridge(session: AsyncSession) -> str:
    """Insert the Client + CollaborationBridge a mapping row depends on."""
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


class TestBridgeMessageMapStore:
    async def test_create_and_lookup_both_directions(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await store.create(
                session,
                BridgeMessageMap(
                    bridge_id=bridge_id,
                    external_channel_id="chan-1",
                    transport_event_id="$evt1",
                    external_post_id="post1",
                ),
            )
            await session.commit()

            by_event = await store.get_by_transport_event_id(
                session, bridge_id, "$evt1"
            )
            by_post = await store.get_by_external_post_id(session, bridge_id, "post1")

        assert by_event is not None and by_event.external_post_id == "post1"
        assert by_post is not None and by_post.transport_event_id == "$evt1"

    async def test_lookup_miss_returns_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            assert (
                await store.get_by_transport_event_id(session, bridge_id, "$nope")
                is None
            )
            assert (
                await store.get_by_external_post_id(session, bridge_id, "nope") is None
            )

    async def test_delete_by_transport_event_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await store.create(
                session,
                BridgeMessageMap(
                    bridge_id=bridge_id,
                    external_channel_id="chan-1",
                    transport_event_id="$evt1",
                    external_post_id="post1",
                ),
            )
            await session.commit()

            await store.delete_by_transport_event_id(session, bridge_id, "$evt1")
            await session.commit()

            assert (
                await store.get_by_transport_event_id(session, bridge_id, "$evt1")
                is None
            )
            assert (
                await store.get_by_external_post_id(session, bridge_id, "post1") is None
            )

    async def test_scoped_by_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The same ids under a different bridge must not resolve across bridges."""
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_a = await _make_bridge(session)
            bridge_b = await _make_bridge(session)
            await store.create(
                session,
                BridgeMessageMap(
                    bridge_id=bridge_a,
                    external_channel_id="chan-1",
                    transport_event_id="$evt1",
                    external_post_id="post1",
                ),
            )
            await session.commit()

            assert (
                await store.get_by_transport_event_id(session, bridge_b, "$evt1")
                is None
            )
            assert (
                await store.get_by_external_post_id(session, bridge_b, "post1") is None
            )
