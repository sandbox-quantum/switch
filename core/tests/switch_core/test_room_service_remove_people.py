"""Taking people out of a bridged room (CHOO-4255).

Against a real PostgreSQL and the real provisioning, because what matters is
what the tables end up holding: the membership gone, and the departure that
explains it in the room's history.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    Room,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.transport.invites import InviteBus
from tests.routing import router_on


class _Adapter:
    def __init__(self, refuses: set[str]) -> None:
        self.refuses = refuses
        self.removed: list[tuple[str, list[str]]] = []

    async def remove_users_from_channel(
        self, channel_id: str, user_external_ids: list[str]
    ) -> list[str]:
        self.removed.append((channel_id, list(user_external_ids)))
        return [i for i in user_external_ids if i in self.refuses]


class _Bridge:
    def __init__(self, adapter: _Adapter) -> None:
        self.adapter = adapter


class _Lifecycle:
    def __init__(self, bridge: _Bridge) -> None:
        self._bridge = bridge

    def get(self, bridge_id: str) -> _Bridge:
        return self._bridge


def _service(
    session_factory: async_sessionmaker[AsyncSession], adapter: _Adapter
) -> tuple[RoomService, list[tuple[str, str, list[str]]]]:
    service = object.__new__(RoomService)
    service._session_factory = session_factory
    service._room_store = RoomStore()
    service._collab_lifecycle = _Lifecycle(_Bridge(adapter))  # type: ignore[assignment]
    service._provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=RoomStore(),
        client_store=ClientStore(),
        router=router_on(session_factory),
        invites=InviteBus(),
    )
    service._telemetry = None
    left: list[tuple[str, str, list[str]]] = []

    async def on_left(tenant_id: str, room_id: str, client_ids: list[str]) -> None:
        left.append((tenant_id, room_id, client_ids))

    service.on_people_left(on_left)
    return service, left


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, Any]:
    """A bridged room with Bob in it, through his Slack account."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        consumer = Client(
            transport_user_id=f"@bridge-{suffix}:test",
            display_name="bridge",
            type="bridge",
        )
        bob = Client(
            transport_user_id=f"@bob-{suffix}:test", display_name="bob", type="user"
        )
        session.add_all([consumer, bob])
        await session.flush()
        bridge = CollaborationBridge(
            type="slack", display_name="Slack", client_id=consumer.id, status="active"
        )
        session.add(bridge)
        await session.flush()
        session.add(
            ExternalUser(
                bridge_id=bridge.id,
                external_user_id="U-BOB",
                external_username="bob",
                client_id=bob.id,
            )
        )
        room = Room(
            transport_room_id=f"!{suffix}:test",
            name="room",
            description="",
            bridge_id=bridge.id,
            external_channel_id="C1",
            channel_type="channel_public",
        )
        session.add(room)
        await session.commit()
        seeded = {
            "room_id": room.id,
            "transport_room_id": room.transport_room_id,
            "bob": bob.id,
            "bob_handle": bob.transport_user_id,
        }
    return seeded


async def _put_bob_in(service: RoomService, seeded: dict[str, Any]) -> None:
    await service._provisioning.invite_to_room(
        seeded["transport_room_id"], seeded["bob_handle"]
    )


async def _is_member(
    session_factory: async_sessionmaker[AsyncSession], seeded: dict[str, Any]
) -> bool:
    async with session_factory() as session:
        row = await session.get(
            ClientRoom, {"client_id": seeded["bob"], "room_id": seeded["room_id"]}
        )
    return row is not None


async def _departures(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[dict[str, Any]]:
    async with session_factory() as session:
        rows = await MessageStore().list_for_room(
            session, room_id, after_seq=0, limit=20
        )
    return [
        dict(row.content or {})
        for row in rows
        if (row.content or {}).get("membership") == "leave"
    ]


async def test_someone_who_left_the_channel_leaves_the_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    adapter = _Adapter(refuses=set())
    service, left = _service(session_factory, adapter)
    seeded = await _seed(session_factory)
    await _put_bob_in(service, seeded)

    refused = await service.remove_people_from_room(seeded["room_id"], ["U-BOB"])

    assert refused == []
    assert not await _is_member(session_factory, seeded)
    assert await _departures(session_factory, seeded["room_id"]) == [
        {"membership": "leave", "prev_membership": "join", "displayname": "bob"}
    ]
    # The platform already said they went: it is not asked to remove them.
    assert adapter.removed == []
    # What a departure revokes on the server hears of it.
    assert [(r, ids) for _, r, ids in left] == [(seeded["room_id"], [seeded["bob"]])]


async def test_a_removal_through_switch_takes_them_out_of_the_channel_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    adapter = _Adapter(refuses=set())
    service, _ = _service(session_factory, adapter)
    seeded = await _seed(session_factory)
    await _put_bob_in(service, seeded)

    await service.remove_people_from_room(
        seeded["room_id"], ["U-BOB"], removed_by="Rita", from_channel=True
    )

    assert adapter.removed == [("C1", ["U-BOB"])]
    assert not await _is_member(session_factory, seeded)
    [departure] = await _departures(session_factory, seeded["room_id"])
    assert departure["removed_by"] == "Rita"


async def test_a_platform_refusal_still_takes_them_out_of_the_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    adapter = _Adapter(refuses={"U-BOB"})
    service, _ = _service(session_factory, adapter)
    seeded = await _seed(session_factory)
    await _put_bob_in(service, seeded)

    refused = await service.remove_people_from_room(
        seeded["room_id"], ["U-BOB"], from_channel=True
    )

    assert refused == ["U-BOB"]
    assert not await _is_member(session_factory, seeded)


async def test_someone_never_in_the_room_is_nothing_to_remove(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    adapter = _Adapter(refuses=set())
    service, left = _service(session_factory, adapter)
    seeded = await _seed(session_factory)

    await service.remove_people_from_room(seeded["room_id"], ["U-BOB", "U-GHOST"])

    assert await _departures(session_factory, seeded["room_id"]) == []


async def test_an_unbridged_room_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, _ = _service(session_factory, _Adapter(refuses=set()))
    async with session_factory() as session:
        room = Room(transport_room_id="!plain:test", name="plain", description="")
        session.add(room)
        await session.commit()
        room_id = room.id

    with pytest.raises(ValueError, match="not bridged"):
        await service.remove_people_from_room(room_id, ["U-BOB"])
