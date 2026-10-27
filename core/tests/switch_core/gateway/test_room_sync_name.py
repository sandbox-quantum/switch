"""`POST /gateway/rooms/{id}/sync-name` names a bridged room after its linked
channel, so it follows the channel from then on; only the room's owner or an
admin may. The route is called directly, as in `test_room_participant_read`."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Client, CollaborationBridge, Room, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import NAME_SOURCE_KEY, RoomStore
from switch_core.gateway import rooms as rooms_module
from tests.switch_core.gateway.conftest import _Harness


async def _sync(chats: _Harness, room_id: str, user: User) -> str:
    async with chats.factory() as session:
        return await rooms_module.sync_room_name(  # type: ignore[return-value]
            room_id,
            session,
            chats.room_service,
            RoomStore(),
            CollaborationBridgeStore(),
            None,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            user,
            False,
        )


async def test_the_owner_takes_the_channel_name_and_others_may_not(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def detail(_session: AsyncSession, room: Room, *_args: Any) -> str:
        return room.name

    monkeypatch.setattr(rooms_module, "_build_room_detail", detail)
    async with chats.factory() as session:
        bridge_client = Client(
            transport_user_id="@bridge:test", display_name="bridge", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="discord",
            display_name="Discord",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        linked = Room(
            transport_room_id="!linked:test",
            name="Discord: qa-overnight-adopted",
            description="",
            owner_id=chats.alice.id,
            bridge_id=bridge.id,
            external_channel_id="C-1",
            read_visibility="public",
            write_visibility="public",
            metadata_={"linked_channel_name": "qa-adopted-renamed"},
        )
        unseen = Room(
            transport_room_id="!unseen:test",
            name="Discord: quiet",
            description="",
            owner_id=chats.alice.id,
            bridge_id=bridge.id,
            external_channel_id="C-2",
        )
        session.add_all([linked, unseen])
        await session.commit()

    with pytest.raises(HTTPException) as refused:
        await _sync(chats, linked.id, chats.bob)
    assert refused.value.status_code == 403
    with pytest.raises(HTTPException) as unknown:
        await _sync(chats, unseen.id, chats.alice)
    assert unknown.value.status_code == 409

    assert await _sync(chats, linked.id, chats.alice) == "Discord: qa-adopted-renamed"
    async with chats.factory() as session:
        row = await session.get(Room, linked.id)
        assert row is not None
        assert row.metadata_[NAME_SOURCE_KEY] == "channel"
