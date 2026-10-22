"""What the room detail tells the Gateway about the caller's access.

The Gateway offers a room's controls from what the server sends: the room's
owner decides who may change its access or delete it, so the detail has to
carry it, and a room's linked rooms say whether the caller may open each one.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.room_links import create_linked_room, list_linked_rooms
from switch_core.gateway.rooms import get_room
from switch_core.gateway.schemas import LinkedRoomCreateRequest

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()


def _svc(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


def _protocol() -> Any:
    """Just enough of `AgentCore` for a room with no agents or roles held."""
    return SimpleNamespace(
        get_agent_statuses_by_ids_in_session=AsyncMock(return_value={}),
        room_role_store=RoomRoleStore(),
        connections=SimpleNamespace(live_connection_ids=lambda: set()),
        agent_store=AgentStore(),
    )


async def _add_user(session: AsyncSession, *, name: str) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def _add_room(
    session: AsyncSession,
    *,
    name: str,
    owner_id: str | None,
    read_visibility: str = "private",
    write_visibility: str = "private",
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


class TestRoomDetailOwner:
    async def test_detail_names_the_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            room = await _add_room(session, name="r1", owner_id=owner.id)

            detail = await get_room(
                room.id,
                session,
                _ROOM_STORE,
                None,  # type: ignore[arg-type]  # bridge_store: the room has no bridge
                None,  # type: ignore[arg-type]  # external_user_store
                _protocol(),
                owner,
                await _USER_STORE.administers(session, owner),
            )

            assert detail.owner_id == owner.id
            assert detail.owner_name == "owner"


class TestLinkedRoomReadAccess:
    async def test_each_linked_room_says_whether_the_caller_may_read_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            reader = await _add_user(session, name="reader")
            source = await _add_room(
                session, name="src", owner_id=owner.id, read_visibility="public"
            )
            shared = await _add_room(
                session, name="shared", owner_id=owner.id, read_visibility="public"
            )
            hidden = await _add_room(session, name="hidden", owner_id=owner.id)
            mine = await _add_room(session, name="mine", owner_id=reader.id)
            svc = _svc(session_factory)
            for target in (shared, hidden, mine):
                await svc.attach_linked_room(
                    session,
                    source_room_id=source.id,
                    target_room_id=target.id,
                    label="see also",
                )

            async def readable_for(user: User) -> dict[str, bool]:
                links = await list_linked_rooms(
                    source.id,
                    session,
                    svc,
                    _ROOM_STORE,
                    user,
                    await _USER_STORE.administers(session, user),
                )
                return {link.target_room_name: link.can_read for link in links}

            assert await readable_for(reader) == {
                "shared": True,
                "hidden": False,
                "mine": True,
            }
            # The owner reads what they own, not a private room of someone else.
            assert await readable_for(owner) == {
                "shared": True,
                "hidden": True,
                "mine": False,
            }

    async def test_a_new_link_says_whether_the_caller_may_read_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            source = await _add_room(
                session,
                name="src",
                owner_id=owner.id,
                read_visibility="public",
                write_visibility="public",
            )
            hidden = await _add_room(session, name="hidden", owner_id=owner.id)

            link = await create_linked_room(
                source.id,
                LinkedRoomCreateRequest(target_room_id=hidden.id, label="see also"),
                session,
                _svc(session_factory),
                _ROOM_STORE,
                other,
                await _USER_STORE.administers(session, other),
            )

            assert link.can_read is False
