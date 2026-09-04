"""Regression tests for CHOO-643 — the gateway reference-attach / room-link
endpoints must check WRITE access to the target room.

Before the fix these handlers authorized access to the *reference* (or, for
links, nothing at all) but never checked that the caller could write the
room they were mutating, so any authenticated user could attach references
to / link rooms they did not own (IDOR). The route coroutines are exercised
directly against real Postgres with real stores.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Reference, Room, User
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.references import attach_reference_to_room
from switch_core.gateway.room_links import create_linked_room, delete_linked_room
from switch_core.gateway.schemas import LinkedRoomCreateRequest

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()


def _resource_service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


async def _add_user(session: AsyncSession, *, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.com", role=role)
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
        matrix_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


async def _add_reference(session: AsyncSession, *, owner_id: str) -> Reference:
    ref = Reference(
        owner_id=owner_id,
        read_visibility="private",
        write_visibility="private",
        type="github",
        name="repo",
        description="d",
        instructions="",
        value={"urls": ["https://github.com/x/y"]},
    )
    session.add(ref)
    await session.flush()
    return ref


class TestAttachReferenceRoomWriteAuthz:
    async def test_non_owner_cannot_attach_to_private_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_room(session, name="r1", owner_id=owner.id)
            # `other` owns the reference, so the failure can only come from the
            # room-write check — not from a reference-read denial.
            ref = await _add_reference(session, owner_id=other.id)
            svc = _resource_service(session_factory)

            with pytest.raises(HTTPException) as exc:
                await attach_reference_to_room(
                    room.id, ref.id, session, svc, _ROOM_STORE, _USER_STORE, other
                )

            assert exc.value.status_code == 403
            assert await svc.list_room_references(session, room.id) == []

    async def test_owner_can_attach(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            room = await _add_room(session, name="r1", owner_id=owner.id)
            ref = await _add_reference(session, owner_id=owner.id)
            svc = _resource_service(session_factory)

            detail = await attach_reference_to_room(
                room.id, ref.id, session, svc, _ROOM_STORE, _USER_STORE, owner
            )

            assert detail.id == ref.id
            attached = await svc.list_room_references(session, room.id)
            assert [r.id for r in attached] == [ref.id]

    async def test_admin_can_attach_to_room_they_dont_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            admin = await _add_user(session, name="admin", role="admin")
            room = await _add_room(session, name="r1", owner_id=owner.id)
            ref = await _add_reference(session, owner_id=admin.id)
            svc = _resource_service(session_factory)

            detail = await attach_reference_to_room(
                room.id, ref.id, session, svc, _ROOM_STORE, _USER_STORE, admin
            )

            assert detail.id == ref.id

    async def test_public_write_room_allows_non_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The fix must not over-block: a room whose write_visibility is public
        # is still attachable by a non-owner.
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_room(
                session,
                name="r1",
                owner_id=owner.id,
                read_visibility="public",
                write_visibility="public",
            )
            ref = await _add_reference(session, owner_id=other.id)
            svc = _resource_service(session_factory)

            detail = await attach_reference_to_room(
                room.id, ref.id, session, svc, _ROOM_STORE, _USER_STORE, other
            )

            assert detail.id == ref.id

    async def test_missing_room_is_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await _add_user(session, name="owner")
            ref = await _add_reference(session, owner_id=user.id)
            svc = _resource_service(session_factory)

            with pytest.raises(HTTPException) as exc:
                await attach_reference_to_room(
                    "missing-room", ref.id, session, svc, _ROOM_STORE, _USER_STORE, user
                )

            assert exc.value.status_code == 404


class TestCreateLinkedRoomWriteAuthz:
    async def test_non_owner_cannot_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            source = await _add_room(session, name="src", owner_id=owner.id)
            target = await _add_room(session, name="tgt", owner_id=owner.id)
            svc = _resource_service(session_factory)
            req = LinkedRoomCreateRequest(target_room_id=target.id, label="rel")

            with pytest.raises(HTTPException) as exc:
                await create_linked_room(
                    source.id, req, session, svc, _ROOM_STORE, other
                )

            assert exc.value.status_code == 403
            assert await svc.list_linked_rooms_for_room(session, source.id) == []

    async def test_owner_can_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            source = await _add_room(session, name="src", owner_id=owner.id)
            target = await _add_room(session, name="tgt", owner_id=owner.id)
            svc = _resource_service(session_factory)
            req = LinkedRoomCreateRequest(target_room_id=target.id, label="rel")

            detail = await create_linked_room(
                source.id, req, session, svc, _ROOM_STORE, owner
            )

            assert detail.target_room_id == target.id
            links = await svc.list_linked_rooms_for_room(session, source.id)
            assert [link["target_room_id"] for link in links] == [target.id]


class TestDeleteLinkedRoomWriteAuthz:
    async def test_non_owner_cannot_delete_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            source = await _add_room(session, name="src", owner_id=owner.id)
            target = await _add_room(session, name="tgt", owner_id=owner.id)
            svc = _resource_service(session_factory)
            await svc.attach_linked_room(
                session, source_room_id=source.id, target_room_id=target.id, label="rel"
            )

            with pytest.raises(HTTPException) as exc:
                await delete_linked_room(
                    source.id, target.id, session, svc, _ROOM_STORE, other
                )

            assert exc.value.status_code == 403
            links = await svc.list_linked_rooms_for_room(session, source.id)
            assert [link["target_room_id"] for link in links] == [target.id]

    async def test_owner_can_delete_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            source = await _add_room(session, name="src", owner_id=owner.id)
            target = await _add_room(session, name="tgt", owner_id=owner.id)
            svc = _resource_service(session_factory)
            await svc.attach_linked_room(
                session, source_room_id=source.id, target_room_id=target.id, label="rel"
            )

            resp = await delete_linked_room(
                source.id, target.id, session, svc, _ROOM_STORE, owner
            )

            assert resp.status_code == 204
            assert await svc.list_linked_rooms_for_room(session, source.id) == []
