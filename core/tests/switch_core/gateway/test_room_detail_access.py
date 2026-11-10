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
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
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
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.gateway.rooms import get_room, list_rooms
from switch_core.gateway.schemas import RoomSummary

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


_NO_DECISIONS = DecisionAvailability(
    enabled=False,
    server=ServerDefault(endpoint_url=None, api_key=None, bedrock_enabled=False),
    store=DecisionSettingsStore(),
)


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
                _NO_DECISIONS,
                owner,
                await _USER_STORE.administers(session, owner),
            )

            assert detail.owner_id == owner.id
            assert detail.owner_name == "owner"


class TestDetailMatchesList:
    """A room's detail carries every field of its list entry with the same
    value. Clients read the two interchangeably: Console's room settings read
    `is_console_chat` from the detail, and the Overview's member counts and
    the lists narrow by `viewer_is_member`."""

    async def _detail_and_summary(
        self, session: AsyncSession, room: Room, viewer: User, is_admin: bool
    ) -> tuple[dict[str, object], dict[str, object]]:
        detail = await get_room(
            room.id,
            session,
            _ROOM_STORE,
            None,  # type: ignore[arg-type]  # bridge_store: the room has no bridge
            None,  # type: ignore[arg-type]  # external_user_store
            _protocol(),
            _NO_DECISIONS,
            viewer,
            is_admin,
        )
        listed = await list_rooms(
            session,
            _ROOM_STORE,
            RoomGroupStore(),
            CollaborationBridgeStore(),
            ExternalUserStore(),
            _USER_STORE,
            viewer,
            is_admin,
        )
        summary = next(r for r in listed if r.id == room.id)
        return detail.model_dump(
            include=set(RoomSummary.model_fields)
        ), summary.model_dump()

    async def test_the_detail_says_what_the_list_says_to_each_viewer(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            reader = await _add_user(session, name="reader")
            admin = await _add_user(session, name="admin")
            room = await _add_room(
                session, name="r1", owner_id=owner.id, read_visibility="public"
            )

            for viewer, is_admin, takes_part in [
                (owner, False, True),
                (reader, False, False),
                (admin, True, False),
            ]:
                detail, summary = await self._detail_and_summary(
                    session, room, viewer, is_admin
                )
                assert detail == summary
                assert detail["viewer_is_member"] is takes_part

    async def test_the_detail_names_a_console_chat(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            chat = await _add_room(session, name="chat", owner_id=owner.id)
            chat.metadata_ = {"chat_operation_id": "op-1"}
            await session.flush()

            detail, summary = await self._detail_and_summary(
                session, chat, owner, False
            )
            assert detail == summary
            assert detail["is_console_chat"] is True
