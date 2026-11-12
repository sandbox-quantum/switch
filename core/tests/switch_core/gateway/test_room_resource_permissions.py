"""Who sees which rooms a resource is in, and who may unlink it or delete a
room's own documents.

- A resource's rooms, and its attached-rooms count, take in only rooms the
  caller may read. So do a room's links and the room graph. A tenant admin
  sees every one. Whoever may manage a resource is still told how many rooms
  they cannot read it is in, though never their names.
- Unlinking a reference, document or package from a room is for those taking
  part in the room and tenant admins. Write access is not enough: on a
  publicly writable room it is everyone's.
- A room-scoped document is deleted by its creator (an agent's document is
  recorded under the agent's owner), the room's owner, or a tenant admin.
- Whoever takes part in a private room may read its resources.

Each flag the dashboard reads says the same as the route that enforces it.
The route coroutines are called directly against real Postgres, as in
`test_room_resource_read_authz`.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Document, Room, User, room_agents
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import get_agent_detail
from switch_core.gateway.documents import (
    detach_document_from_room,
    get_room_document,
    list_documents,
    list_room_documents,
    list_rooms_for_document,
)
from switch_core.gateway.packages import (
    detach_package_from_room,
    remove_reference_from_package,
)
from switch_core.gateway.references import (
    detach_reference_from_room,
    list_references,
    list_rooms_for_reference,
)
from switch_core.gateway.room_links import (
    create_linked_room,
    get_room_link_graph,
    list_inbound_linked_rooms,
    list_linked_rooms,
)
from switch_core.gateway.rooms import list_rooms
from switch_core.gateway.schemas import LinkedRoomCreateRequest
from tests.switch_core.gateway.agent_route_harness import SERVICES_ON, add_agent

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
    session: AsyncSession, name: str, owner: User, *, read: str, write: str
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="",
        owner_id=owner.id,
        read_visibility=read,
        write_visibility=write,
    )
    session.add(room)
    await session.flush()
    return room


@dataclass
class _World:
    """`owner` owns every room. `member` takes part in `theirs` through an
    agent they own, and in nothing else; `stranger` takes part in nothing.

    - `public`: publicly writable, so `member` and `stranger` may write to it.
    - `theirs`: private, but `member` takes part in it, so may read it.
    - `hidden`: private, and only `owner` takes part in it.
    """

    owner: User
    member: User
    stranger: User
    public: Room
    theirs: Room
    hidden: Room
    member_agent_id: str


async def _world(session: AsyncSession) -> _World:
    owner = await _user(session, "owner")
    member = await _user(session, "member")
    stranger = await _user(session, "stranger")
    public = await _room(session, "public", owner, read="public", write="public")
    theirs = await _room(session, "theirs", owner, read="private", write="private")
    hidden = await _room(session, "hidden", owner, read="private", write="private")
    agent = await add_agent(session, name="member-agent", owner_id=member.id)
    await session.execute(
        room_agents.insert().values(room_id=theirs.id, agent_id=agent.id)
    )
    return _World(owner, member, stranger, public, theirs, hidden, agent.id)


async def _shared_document(
    session: AsyncSession, svc: ResourceService, world: _World
) -> Document:
    """A public document `owner` attached to all three rooms."""
    doc = await svc.create_document(
        session,
        owner_id=world.owner.id,
        read_visibility="public",
        write_visibility="private",
        name="spec",
        description="",
        instructions="",
        content="",
    )
    for room in (world.public, world.theirs, world.hidden):
        await svc.attach_document_to_room(
            session, room.id, doc.id, user_id=world.owner.id
        )
    return doc


async def _rooms_of(
    session: AsyncSession, svc: ResourceService, doc: Document, user: User, admin: bool
) -> dict[str, bool]:
    rooms = await list_rooms_for_document(
        doc.id, session, svc, _ROOM_STORE, user, admin
    )
    return {r.room_name: r.can_unlink for r in rooms}


async def _count_of(
    session: AsyncSession, svc: ResourceService, doc: Document, user: User, admin: bool
) -> int:
    docs = await list_documents(session, svc, _USER_STORE, _AGENT_STORE, user, admin)
    return next(d.attached_rooms_count for d in docs if d.id == doc.id)


async def _detach(
    session: AsyncSession,
    svc: ResourceService,
    room: Room,
    doc_id: str,
    user: User,
    admin: bool,
) -> None:
    await detach_document_from_room(
        room.id, doc_id, session, svc, _ROOM_STORE, user, admin
    )


async def test_a_resource_lists_only_the_rooms_its_viewer_may_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        doc = await _shared_document(session, svc, world)
        await session.commit()

        # `member` reads `public` and `theirs`; `hidden` is left out, count too.
        assert await _rooms_of(session, svc, doc, world.member, False) == {
            "public": False,
            "theirs": True,
        }
        assert await _count_of(session, svc, doc, world.member, False) == 2
        assert await _rooms_of(session, svc, doc, world.stranger, False) == {
            "public": False
        }
        assert await _count_of(session, svc, doc, world.stranger, False) == 1
        # A tenant admin sees, and may unlink from, every room.
        assert await _rooms_of(session, svc, doc, world.stranger, True) == {
            "public": True,
            "theirs": True,
            "hidden": True,
        }
        assert await _count_of(session, svc, doc, world.stranger, True) == 3


async def test_unlinking_is_for_those_taking_part_in_the_room_and_admins(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        doc = await _shared_document(session, svc, world)
        pkg = await svc.create_package(
            session,
            owner_id=world.owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        await svc.attach_package_to_room(
            session, world.public.id, pkg.id, user_id=world.owner.id
        )
        await session.commit()

        summaries = await list_rooms(
            session,
            _ROOM_STORE,
            RoomGroupStore(),
            CollaborationBridgeStore(),
            ExternalUserStore(),
            _USER_STORE,
            world.member,
            False,
        )
        assert {r.name: (r.can_write, r.can_unlink) for r in summaries} == {
            "public": (True, False),
            "theirs": (False, True),
        }

        # May write to `public`, but takes part in it no more than anyone does.
        with pytest.raises(HTTPException) as refused:
            await _detach(session, svc, world.public, doc.id, world.member, False)
        assert refused.value.status_code == 403
        with pytest.raises(HTTPException) as refused:
            await detach_package_from_room(
                world.public.id, pkg.id, session, svc, _ROOM_STORE, world.member, False
            )
        assert refused.value.status_code == 403

        # Takes part in `theirs` without write access to it, and may unlink.
        await _detach(session, svc, world.theirs, doc.id, world.member, False)
        # So may an admin, from a room they are not in.
        await _detach(session, svc, world.hidden, doc.id, world.stranger, True)

        assert await _rooms_of(session, svc, doc, world.owner, False) == {
            "public": True
        }


async def test_a_room_document_is_deleted_by_its_creator_the_room_owner_or_an_admin(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        notes = []
        for name in ("by-creator", "by-owner", "by-admin"):
            # Made by `member`'s agent, so recorded under `member`.
            doc = await svc.create_room_document(
                session,
                room_id=world.public.id,
                agent_id=world.member_agent_id,
                owner_id=world.member.id,
                name=name,
                description="",
                instructions="",
                content="",
            )
            notes.append(doc)
        await session.commit()
        by_creator, by_owner, by_admin = notes

        async def can_remove(doc: Document, user: User, admin: bool) -> bool:
            listed = await list_room_documents(
                world.public.id,
                session,
                svc,
                _USER_STORE,
                _AGENT_STORE,
                _ROOM_STORE,
                user,
                admin,
            )
            detail = await get_room_document(
                world.public.id,
                doc.id,
                session,
                svc,
                _USER_STORE,
                _AGENT_STORE,
                _ROOM_STORE,
                user,
                admin,
            )
            from_list = next(d.can_remove for d in listed if d.id == doc.id)
            assert from_list == detail.can_remove
            return detail.can_remove

        # `stranger` may write to the room, and so change the document, but
        # did not make it and does not own the room.
        assert await can_remove(by_creator, world.stranger, False) is False
        with pytest.raises(HTTPException) as refused:
            await _detach(
                session, svc, world.public, by_creator.id, world.stranger, False
            )
        assert refused.value.status_code == 403

        assert await can_remove(by_creator, world.member, False) is True
        await _detach(session, svc, world.public, by_creator.id, world.member, False)
        assert await can_remove(by_owner, world.owner, False) is True
        await _detach(session, svc, world.public, by_owner.id, world.owner, False)
        assert await can_remove(by_admin, world.stranger, True) is True
        await _detach(session, svc, world.public, by_admin.id, world.stranger, True)


async def test_those_taking_part_in_a_private_room_read_its_resources(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        doc = await _shared_document(session, svc, world)
        await session.commit()

        async def listed(room: Room, user: User) -> list[str]:
            docs = await list_room_documents(
                room.id,
                session,
                svc,
                _USER_STORE,
                _AGENT_STORE,
                _ROOM_STORE,
                user,
                False,
            )
            return [d.id for d in docs]

        assert await listed(world.theirs, world.member) == [doc.id]
        with pytest.raises(HTTPException) as refused:
            await listed(world.hidden, world.member)
        assert refused.value.status_code == 403


async def test_a_reference_follows_the_same_rules(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        ref = await svc.create_reference(
            session,
            owner_id=world.owner.id,
            is_admin=False,
            read_visibility="public",
            write_visibility="private",
            type="github",
            name="repo",
            description="",
            instructions="",
            value={"urls": ["https://github.com/example/repo"]},
        )
        for room in (world.public, world.theirs, world.hidden):
            await svc.attach_reference_to_room(
                session, room.id, ref.id, user_id=world.owner.id
            )
        await session.commit()

        rooms = await list_rooms_for_reference(
            ref.id, session, svc, _ROOM_STORE, world.member, False
        )
        assert {r.room_name: r.can_unlink for r in rooms} == {
            "public": False,
            "theirs": True,
        }
        listed = await list_references(session, svc, _USER_STORE, world.member, False)
        assert next(r.attached_rooms_count for r in listed if r.id == ref.id) == 2

        with pytest.raises(HTTPException) as refused:
            await detach_reference_from_room(
                world.public.id, ref.id, session, svc, _ROOM_STORE, world.member, False
            )
        assert refused.value.status_code == 403
        await detach_reference_from_room(
            world.theirs.id, ref.id, session, svc, _ROOM_STORE, world.member, False
        )


async def test_links_and_the_room_graph_name_only_rooms_the_viewer_may_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        for source, target in (
            (world.public, world.hidden),
            (world.hidden, world.public),
        ):
            await svc.attach_linked_room(
                session, source_room_id=source.id, target_room_id=target.id, label="see"
            )
        await svc.attach_linked_room(
            session,
            source_room_id=world.public.id,
            target_room_id=world.theirs.id,
            label="see",
        )
        await session.commit()

        outbound = await list_linked_rooms(
            world.public.id, session, svc, _ROOM_STORE, world.member, False
        )
        assert [link.target_room_name for link in outbound] == ["theirs"]
        inbound = await list_inbound_linked_rooms(
            world.public.id, session, svc, _ROOM_STORE, world.member, False
        )
        assert inbound == []

        graph = await get_room_link_graph(
            session, svc, _ROOM_STORE, world.member, False
        )
        assert {room.name for room in graph.rooms} == {"public", "theirs"}
        assert [(link.source_room_id, link.target_room_id) for link in graph.links] == [
            (world.public.id, world.theirs.id)
        ]

        admin_graph = await get_room_link_graph(
            session, svc, _ROOM_STORE, world.stranger, True
        )
        assert {room.name for room in admin_graph.rooms} == {
            "public",
            "theirs",
            "hidden",
        }
        assert len(admin_graph.links) == 3


async def test_a_resource_owner_is_told_how_many_private_rooms_use_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        # `member` owns the document; `owner` puts it in a room only they read.
        doc = await svc.create_document(
            session,
            owner_id=world.member.id,
            read_visibility="public",
            write_visibility="private",
            name="theirs-to-share",
            description="",
            instructions="",
            content="",
        )
        await svc.attach_document_to_room(
            session, world.hidden.id, doc.id, user_id=world.owner.id
        )
        await session.commit()

        async def counts(user: User, admin: bool) -> tuple[int, int]:
            docs = await list_documents(
                session, svc, _USER_STORE, _AGENT_STORE, user, admin
            )
            listed = next(d for d in docs if d.id == doc.id)
            return listed.attached_rooms_count, listed.hidden_rooms_count

        # The room stays unnamed to its owner, but they know it is there.
        assert await _rooms_of(session, svc, doc, world.member, False) == {}
        assert await counts(world.member, False) == (1, 1)
        # Anyone else who may not read the room is not told of it at all.
        assert await counts(world.stranger, False) == (0, 0)
        # An admin reads every room, so none is hidden from them.
        assert await counts(world.stranger, True) == (1, 0)


async def test_a_link_reply_names_only_a_room_its_maker_may_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        await session.commit()

        async def link(target: Room) -> str:
            created = await create_linked_room(
                world.public.id,
                LinkedRoomCreateRequest(target_room_id=target.id, label="see"),
                session,
                svc,
                _ROOM_STORE,
                world.member,
                False,
            )
            return created.target_room_name

        # `member` may write to `public`, but not read `hidden`.
        with pytest.raises(HTTPException) as refused:
            await link(world.hidden)
        assert refused.value.status_code == 403
        assert await link(world.theirs) == "theirs"


async def test_an_agents_detail_names_only_rooms_its_viewer_may_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    protocol = SimpleNamespace(
        agent_session_store=AgentSessionStore(),
        room_role_store=RoomRoleStore(),
        connections=AgentConnectionRegistry(),
    )
    async with session_factory() as session:
        world = await _world(session)
        await session.execute(
            room_agents.insert().values(
                room_id=world.public.id, agent_id=world.member_agent_id
            )
        )
        await session.commit()

        async def rooms_seen_by(user: User, admin: bool) -> set[str]:
            detail = await get_agent_detail(
                world.member_agent_id,
                session,
                _AGENT_STORE,
                _ROOM_STORE,
                _USER_STORE,
                protocol,  # type: ignore[arg-type]
                user,
                admin,
                SERVICES_ON,  # type: ignore[arg-type]
            )
            return {room.room_name for room in detail.rooms}

        assert await rooms_seen_by(world.member, False) == {"public", "theirs"}
        assert await rooms_seen_by(world.stranger, False) == {"public"}
        assert await rooms_seen_by(world.stranger, True) == {"public", "theirs"}


async def test_removing_from_a_package_names_only_readable_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _svc(session_factory)
    async with session_factory() as session:
        world = await _world(session)
        ref = await svc.create_reference(
            session,
            owner_id=world.owner.id,
            is_admin=False,
            read_visibility="public",
            write_visibility="public",
            type="github",
            name="repo",
            description="",
            instructions="",
            value={"urls": ["https://github.com/example/repo"]},
        )
        pkg = await svc.create_package(
            session,
            owner_id=world.owner.id,
            read_visibility="public",
            write_visibility="public",
            name="kit",
            description="",
            instructions="",
        )
        await svc.add_reference_to_package(
            session, pkg.id, ref.id, user_id=world.owner.id, is_admin=False
        )
        for room in (world.public, world.hidden):
            await svc.attach_package_to_room(
                session, room.id, pkg.id, user_id=world.owner.id
            )
        await session.commit()

        removed = await remove_reference_from_package(
            pkg.id, ref.id, session, svc, _ROOM_STORE, world.stranger, False
        )
        assert removed.affected_room_names == ["public"]
        assert removed.hidden_affected_rooms_count == 1
