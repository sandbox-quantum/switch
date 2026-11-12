from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import BridgeMessageMap, Client, CollaborationBridge
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore


async def _make_bridge(session: AsyncSession) -> str:
    """Insert the Client + CollaborationBridge a mapping row depends on."""
    client = Client(
        transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
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

    async def test_a_stale_claim_claimed_again_records_the_new_channel(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The holder that claimed the message died before posting it, and
        the room moved to another channel of the bridge since. The next
        holder posts it to the new channel, and the row says so."""
        store = BridgeMessageMapStore()
        unposted_after = timedelta(seconds=10)
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            assert await store.claim(
                session,
                bridge_id=bridge_id,
                external_channel_id="chan-1",
                transport_event_id="$evt1",
                unposted_after=unposted_after,
            )
            await session.execute(
                update(BridgeMessageMap)
                .where(BridgeMessageMap.bridge_id == bridge_id)
                .values(created_at=func.now() - timedelta(seconds=30))
            )
            await session.commit()

            assert await store.claim(
                session,
                bridge_id=bridge_id,
                external_channel_id="chan-2",
                transport_event_id="$evt1",
                unposted_after=unposted_after,
            )
            await store.fill(
                session,
                bridge_id=bridge_id,
                transport_event_id="$evt1",
                external_post_id="post1",
            )
            await session.commit()

        async with session_factory() as session:
            posted = await store.get_by_external_post_id(session, bridge_id, "post1")
        assert posted is not None and posted.external_channel_id == "chan-2"


class TestCardAnswer:
    async def _posted(self, session: AsyncSession, store: BridgeMessageMapStore) -> str:
        bridge_id = await _make_bridge(session)
        await store.create(
            session,
            BridgeMessageMap(
                bridge_id=bridge_id,
                external_channel_id="chan-1",
                transport_event_id="$card",
                external_post_id="post1",
            ),
        )
        await session.commit()
        return bridge_id

    async def test_the_first_answer_stands(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        first = {"by": "alice", "label": "Approve"}
        async with session_factory() as session:
            bridge_id = await self._posted(session, store)
            assert (
                await store.answer_card(
                    session, bridge_id=bridge_id, external_post_id="post1", answer=first
                )
                is None
            )
            assert (
                await store.answer_card(
                    session,
                    bridge_id=bridge_id,
                    external_post_id="post1",
                    answer={"by": "bob", "label": "Reject"},
                )
                == first
            )

    async def test_concurrent_answers_record_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_id = await self._posted(session, store)

        async def answer(by: str) -> dict | None:
            async with session_factory() as session:
                earlier = await store.answer_card(
                    session,
                    bridge_id=bridge_id,
                    external_post_id="post1",
                    answer={"by": by, "label": "Approve"},
                )
                await asyncio.sleep(0.05)
                await session.commit()
                return earlier

        results = await asyncio.gather(*(answer(f"u{i}") for i in range(5)))

        assert results.count(None) == 1
        winner = next(f"u{i}" for i, r in enumerate(results) if r is None)
        assert all(r == {"by": winner, "label": "Approve"} for r in results if r)

    async def test_a_cleared_answer_can_be_given_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_id = await self._posted(session, store)
            await store.answer_card(
                session,
                bridge_id=bridge_id,
                external_post_id="post1",
                answer={"by": "alice", "label": "Approve"},
            )
            await store.clear_card_answer(
                session, bridge_id=bridge_id, external_post_id="post1"
            )
            assert (
                await store.answer_card(
                    session,
                    bridge_id=bridge_id,
                    external_post_id="post1",
                    answer={"by": "bob", "label": "Reject"},
                )
                is None
            )

    async def test_an_unknown_post_is_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = BridgeMessageMapStore()
        async with session_factory() as session:
            bridge_id = await self._posted(session, store)
            with pytest.raises(LookupError):
                await store.answer_card(
                    session,
                    bridge_id=bridge_id,
                    external_post_id="nope",
                    answer={"by": "alice", "label": "Approve"},
                )
