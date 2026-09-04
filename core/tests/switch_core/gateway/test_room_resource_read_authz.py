"""Room-scoped resource reads/detaches must check room access (IDOR fix).

The room-scoped document/reference/package endpoints authenticated the caller
but never checked access to the room, so any authenticated user could read a
private room's document content or detach (hard-delete) its resources by id.
These tests pin the added `require_room_access` guard: a non-owner is refused
(403) and the owner still gets through.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.documents import (
    detach_document_from_room,
    get_room_document,
    list_room_documents,
)
from switch_core.gateway.packages import detach_package_from_room
from switch_core.gateway.references import detach_reference_from_room

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()
_AGENT_STORE = AgentStore()


def _svc(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
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


async def _add_private_room(session: AsyncSession, *, owner_id: str) -> Room:
    room = Room(
        matrix_room_id="!r:test",
        name="r",
        description="d",
        owner_id=owner_id,
        read_visibility="private",
        write_visibility="private",
    )
    session.add(room)
    await session.flush()
    return room


class TestRoomResourceReadAuthz:
    async def test_non_owner_cannot_read_room_document(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_private_room(session, owner_id=owner.id)
            svc = _svc(session_factory)

            with pytest.raises(HTTPException) as exc:
                await get_room_document(
                    room.id,
                    "any-doc",
                    session,
                    svc,
                    _USER_STORE,
                    _AGENT_STORE,
                    _ROOM_STORE,
                    other,
                )
            assert exc.value.status_code == 403

    async def test_non_owner_cannot_list_room_documents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_private_room(session, owner_id=owner.id)
            svc = _svc(session_factory)

            with pytest.raises(HTTPException) as exc:
                await list_room_documents(
                    room.id,
                    session,
                    svc,
                    _USER_STORE,
                    _AGENT_STORE,
                    _ROOM_STORE,
                    other,
                )
            assert exc.value.status_code == 403

    async def test_non_owner_cannot_detach_room_document(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_private_room(session, owner_id=owner.id)
            svc = _svc(session_factory)

            with pytest.raises(HTTPException) as exc:
                await detach_document_from_room(
                    room.id, "any-doc", session, svc, _ROOM_STORE, other
                )
            assert exc.value.status_code == 403

    async def test_non_owner_cannot_detach_reference(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_private_room(session, owner_id=owner.id)
            svc = _svc(session_factory)

            with pytest.raises(HTTPException) as exc:
                await detach_reference_from_room(
                    room.id, "any-ref", session, svc, _ROOM_STORE, other
                )
            assert exc.value.status_code == 403

    async def test_non_owner_cannot_detach_package(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_private_room(session, owner_id=owner.id)
            svc = _svc(session_factory)

            with pytest.raises(HTTPException) as exc:
                await detach_package_from_room(
                    room.id, "any-pkg", session, svc, _ROOM_STORE, other
                )
            assert exc.value.status_code == 403

    async def test_owner_read_passes_authz(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Owner is past the authz gate: an empty room lists no documents, and a
        # missing document is 404 (not 403), proving access was granted.
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            room = await _add_private_room(session, owner_id=owner.id)
            svc = _svc(session_factory)

            assert (
                await list_room_documents(
                    room.id,
                    session,
                    svc,
                    _USER_STORE,
                    _AGENT_STORE,
                    _ROOM_STORE,
                    owner,
                )
                == []
            )
            with pytest.raises(HTTPException) as exc:
                await get_room_document(
                    room.id,
                    "missing",
                    session,
                    svc,
                    _USER_STORE,
                    _AGENT_STORE,
                    _ROOM_STORE,
                    owner,
                )
            assert exc.value.status_code == 404
