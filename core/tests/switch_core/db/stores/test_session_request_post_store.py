from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Client,
    CollaborationBridge,
    Room,
    SessionRequestPost,
)
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore


async def _make_bridge(session: AsyncSession) -> str:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack",
        display_name="Slack",
        client_id=client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _make_room(session: AsyncSession) -> str:
    suffix = uuid.uuid4().hex[:8]
    room = Room(
        matrix_room_id=f"!room-{suffix}:test",
        name=f"room-{suffix}",
        description="a room",
    )
    session.add(room)
    await session.flush()
    return room.id


def _post(bridge_id: str, room_id: str, **overrides: object) -> SessionRequestPost:
    fields: dict[str, object] = {
        "bridge_id": bridge_id,
        "room_id": room_id,
        "token": "opaque-token",
        "handle": "R42",
        "external_channel_id": "C1",
        "external_post_id": "C1:111.0",
        "thread_id": "thread-demo",
        "session_id": "session-demo",
        "epoch": "epoch-demo",
        "request_id": "request-demo",
        "revision": 1,
    }
    fields.update(overrides)
    return SessionRequestPost(**fields)


class TestSessionRequestPostStore:
    async def test_a_token_resolves_to_what_was_posted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_token(session, bridge_id, "opaque-token")

        assert found is not None
        assert found.session_id == "session-demo"
        assert found.epoch == "epoch-demo"
        assert found.request_id == "request-demo"
        assert found.revision == 1

    async def test_a_token_does_not_resolve_on_another_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The workspace fence. A token names a request in one connection only."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            other_bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            found = await store.get_by_token(session, other_bridge_id, "opaque-token")

        assert found is None

    async def test_an_unknown_token_resolves_to_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await session.commit()

        async with session_factory() as session:
            assert await store.get_by_token(session, bridge_id, "made-up") is None

    async def test_one_request_is_posted_once_per_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two rows for one request would give a request two live cards."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _post(bridge_id, room_id, token="another-token", handle="R43"),
                )

    async def test_a_handle_is_unambiguous_within_a_channel(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`R42` is what someone types instead of pressing. It must mean one thing."""
        store = SessionRequestPostStore()
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            room_id = await _make_room(session)
            await store.create(session, _post(bridge_id, room_id))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(
                    session,
                    _post(
                        bridge_id,
                        room_id,
                        token="another-token",
                        request_id="request-other",
                    ),
                )
