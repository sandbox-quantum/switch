"""Where the dashboard lists rooms or a room's documents, it is told what the
caller may change, by the same rule the attach and detach routes enforce
(write access to the room), so it offers only what the server would allow.
The route coroutines are called directly against real Postgres, as in
`test_room_resource_read_authz`."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.documents import get_room_document, list_rooms_for_document
from switch_core.gateway.rooms import list_rooms

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()
_AGENT_STORE = AgentStore()


def _svc(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def _room(
    session: AsyncSession, name: str, owner: User, write_visibility: str
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="",
        owner_id=owner.id,
        read_visibility="public",
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


async def test_rooms_and_room_documents_say_what_the_caller_may_change(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        owner = await _user(session, "owner")
        member = await _user(session, "member")
        public = await _room(session, "public", owner, write_visibility="public")
        read_only = await _room(session, "read-only", owner, write_visibility="private")
        doc = await svc.create_document(
            session,
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="spec",
            description="",
            instructions="",
            content="",
        )
        for room in (public, read_only):
            await svc.attach_document_to_room(
                session, room.id, doc.id, user_id=owner.id
            )
        await session.commit()

        summaries = await list_rooms(
            session,
            _ROOM_STORE,
            RoomGroupStore(),
            CollaborationBridgeStore(),
            ExternalUserStore(),
            _USER_STORE,
            member,
            False,
        )
        assert {r.id: (r.can_write, r.can_manage) for r in summaries} == {
            public.id: (True, False),
            read_only.id: (False, False),
        }

        attached = await list_rooms_for_document(doc.id, session, svc, member, False)
        assert {r.room_id: r.can_write for r in attached} == {
            public.id: True,
            read_only.id: False,
        }

        async def can_remove(room: Room, user: User) -> bool:
            detail = await get_room_document(
                room.id,
                doc.id,
                session,
                svc,
                _USER_STORE,
                _AGENT_STORE,
                _ROOM_STORE,
                user,
                False,
            )
            return detail.can_remove

        assert await can_remove(public, member) is True
        assert await can_remove(read_only, member) is False
        assert await can_remove(read_only, owner) is True
