"""`PUT|DELETE /rooms/{id}/personal-archive`: a room archived in one person's
own lists — against real Postgres.

Archiving is personal: the caller's room and chat lists flag it, nobody
else's do, and the room itself (its `archived_at`, its channel) is untouched.
Only someone who can see the room may archive it, and sending a message in it
unarchives it for the sender alone.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Room, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.rooms import router as rooms_router
from tests.switch_core.gateway.conftest import _Harness


async def _no_deeplink(external_channel_id: str) -> None:
    return None


@pytest.fixture
async def rooms(
    chats: _Harness,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[httpx.AsyncClient]:
    # The room list asks the platform only for a channel deeplink.
    adapter = SimpleNamespace(channel_deeplink=_no_deeplink)
    monkeypatch.setattr(
        rooms_module,
        "get_collab_lifecycle",
        lambda: SimpleNamespace(get_adapter=lambda bridge_id: adapter),
    )

    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    async def user_from_header(request: Request) -> User:
        async with session_factory() as session:
            user = await session.get(User, request.headers["x-user"])
            assert user is not None
            return user

    app = FastAPI()
    app.state.chat_service = chats.service
    app.include_router(rooms_router, prefix="/rooms")
    overrides: dict[Callable[..., Any], Callable[..., Any]] = {
        get_current_user: user_from_header,
        gw_deps.get_session: _session,
        gw_deps.get_user_store: UserStore,
        gw_deps.get_room_store: RoomStore,
        gw_deps.get_room_group_store: RoomGroupStore,
        gw_deps.get_bridge_store: CollaborationBridgeStore,
        gw_deps.get_external_user_store: ExternalUserStore,
    }
    app.dependency_overrides.update(overrides)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://switch.test"
    ) as client:
        yield client


async def _bridged_room(chats: _Harness, *, owner: User, visibility: str) -> str:
    """A Slack-bridged room nobody joined through Switch Console."""
    async with chats.factory() as session:
        bridge_client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.test",
            display_name="bridge",
            type="bridge",
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Acme",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="Acme: general",
            description="",
            owner_id=owner.id,
            read_visibility=visibility,
            write_visibility=visibility,
            bridge_id=bridge.id,
            external_channel_id="C0PLACEHOLDER",
        )
        session.add(room)
        await session.commit()
        return room.id


async def _archived_by(
    rooms: httpx.AsyncClient, chats: _Harness, user: User
) -> dict[str, bool]:
    response = await rooms.get(
        "/rooms?include_archived=true", headers=chats.as_user(user)
    )
    assert response.status_code == 200, response.text
    return {room["id"]: room["archived_by_viewer"] for room in response.json()}


async def test_archiving_a_bridged_room_changes_only_the_callers_lists(
    chats: _Harness, rooms: httpx.AsyncClient
) -> None:
    room_id = await _bridged_room(chats, owner=chats.bob, visibility="public")

    archived = await rooms.put(
        f"/rooms/{room_id}/personal-archive", headers=chats.as_user(chats.alice)
    )
    assert archived.status_code == 204, archived.text
    again = await rooms.put(
        f"/rooms/{room_id}/personal-archive", headers=chats.as_user(chats.alice)
    )
    assert again.status_code == 204

    assert (await _archived_by(rooms, chats, chats.alice))[room_id] is True
    assert (await _archived_by(rooms, chats, chats.bob))[room_id] is False
    # Still in the default list, for everyone: the room is not archived.
    default = await rooms.get("/rooms", headers=chats.as_user(chats.bob))
    assert room_id in {room["id"] for room in default.json()}
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        assert room.archived_at is None

    restored = await rooms.delete(
        f"/rooms/{room_id}/personal-archive", headers=chats.as_user(chats.alice)
    )
    assert restored.status_code == 204
    assert (await _archived_by(rooms, chats, chats.alice))[room_id] is False


async def test_only_someone_who_can_see_the_room_archives_it(
    chats: _Harness, rooms: httpx.AsyncClient
) -> None:
    room_id = await _bridged_room(chats, owner=chats.bob, visibility="private")

    refused = await rooms.put(
        f"/rooms/{room_id}/personal-archive", headers=chats.as_user(chats.alice)
    )
    assert refused.status_code == 403
    assert room_id not in await _archived_by(rooms, chats, chats.alice)

    for user in (chats.bob, chats.admin):
        response = await rooms.put(
            f"/rooms/{room_id}/personal-archive", headers=chats.as_user(user)
        )
        assert response.status_code == 204, response.text
        assert (await _archived_by(rooms, chats, user))[room_id] is True

    missing = await rooms.put(
        "/rooms/no-such-room/personal-archive", headers=chats.as_user(chats.bob)
    )
    assert missing.status_code == 404


async def _chat_flag(chats: _Harness, user: User, room_id: str) -> bool:
    response = await chats.client.get("/chats", headers=chats.as_user(user))
    assert response.status_code == 200, response.text
    [chat] = [c for c in response.json()["chats"] if c["roomId"] == room_id]
    return bool(chat["archivedByViewer"])


async def test_a_chat_archived_by_one_member_stays_listed_and_a_send_unarchives_it_for_the_sender(
    chats: _Harness, rooms: httpx.AsyncClient
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    for user in (chats.alice, chats.bob):
        response = await rooms.put(
            f"/rooms/{room_id}/personal-archive", headers=chats.as_user(user)
        )
        assert response.status_code == 204, response.text

    assert await _chat_flag(chats, chats.alice, room_id) is True
    assert await _chat_flag(chats, chats.bob, room_id) is True

    sent = await chats.send(chats.bob, room_id, "s1", "back to it")
    assert sent.status_code == 200, sent.text
    assert await _chat_flag(chats, chats.bob, room_id) is False
    assert await _chat_flag(chats, chats.alice, room_id) is True
