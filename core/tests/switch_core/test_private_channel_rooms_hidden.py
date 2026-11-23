"""A room on a private channel, a group or a DM is hidden from people not in
it, whatever its stored read visibility. Workspace admins still see every
room.

Rooms made before rooms took their visibility from their channel can still be
stored public. The room policy (`room_policy.open_to_workspace`), the room
store's query (`room_store.open_to_workspace`) and every read built on them
must hide such a room from a non-member, and agree with each other room by
room.

Real Postgres.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import Principal
from switch_core.db.models import Client, CollaborationBridge, Room, User, room_agents
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore, open_to_workspace, readable_by
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.rooms import get_room, list_rooms
from switch_core.room_policy import RoomCaller, allows, visible_from_outside
from switch_core.room_policy import open_to_workspace as policy_open_to_workspace
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.gateway.test_room_detail_access import _NO_DECISIONS, _protocol

_STORE = RoomStore()


@dataclass(frozen=True)
class Case:
    name: str
    read_visibility: str
    channel_type: str | None
    bridged: bool
    open: bool


CASES = [
    Case("public-channel", "public", "channel_public", True, True),
    Case("old-private-channel", "public", "channel_private", True, False),
    Case("old-group", "public", "group", True, False),
    Case("old-dm", "public", "direct", True, False),
    Case("old-unrecorded-type", "public", None, True, False),
    Case("internal-public", "public", None, False, True),
    Case("internal-private-channel", "public", "channel_private", False, False),
    Case("private-public-channel", "private", "channel_public", True, False),
    Case("private-private-channel", "private", "channel_private", True, False),
]


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


async def _bridge(session: AsyncSession) -> str:
    client = Client(
        transport_user_id="@bridge:test", display_name="bridge client", type="bridge"
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Slack", client_id=client.id, status="active"
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _rooms(session: AsyncSession, owner: User) -> dict[str, Room]:
    bridge_id = await _bridge(session)
    rooms: dict[str, Room] = {}
    for case in CASES:
        room = Room(
            transport_room_id=f"!{case.name}:test",
            name=case.name,
            description=f"{case.name} desc",
            owner_id=owner.id,
            read_visibility=case.read_visibility,
            write_visibility="private",
            channel_type=case.channel_type,
            bridge_id=bridge_id if case.bridged else None,
            external_channel_id=f"C-{case.name}" if case.bridged else None,
        )
        session.add(room)
        rooms[case.name] = room
    await session.flush()
    return rooms


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_the_policy_says_who_outside_the_room_sees_it(case: Case) -> None:
    room = Room(
        name=case.name,
        owner_id="u-owner",
        read_visibility=case.read_visibility,
        channel_type=case.channel_type,
        external_channel_id="C-1" if case.bridged else None,
    )
    bystander = Principal("u-bystander", False)

    assert policy_open_to_workspace(room) is case.open
    assert visible_from_outside(bystander, room) is case.open
    assert allows(RoomCaller(bystander, in_room=False), room, "read") is case.open
    # The people in it, its owner and admins still see it.
    assert allows(RoomCaller(bystander, in_room=True), room, "read")
    assert visible_from_outside(Principal("u-owner", False), room)
    assert visible_from_outside(Principal("u-admin", True), room)


async def test_the_query_and_the_policy_agree_on_every_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The checks give the same answer room by room: the policy, the reader's
    query, an agent's query, and an agent nobody owns."""
    async with session_factory() as session:
        owner = await _user(session, "owner")
        bystander = await _user(session, "bystander")
        rooms = await _rooms(session, owner)
        agent = await add_agent(session, name="bystanders-agent", owner_id=bystander.id)
        expected = {c.name for c in CASES if c.open}

        by_expression = await _STORE.visible_room_ids(
            session, [r.id for r in rooms.values()], open_to_workspace()
        )
        by_query = {
            r.name
            for r in await _STORE.list_readable(session, bystander.id, is_admin=False)
        }
        by_agent_query = {
            r.name
            for r in await _STORE.list_visible_to_agent(
                session,
                reader_id=bystander.id,
                reader_is_admin=False,
                member_agent_id=agent.id,
                include_archived=False,
            )
        }
        by_ownerless_agent = {
            r.name
            for r in await _STORE.list_visible_to_agent(
                session,
                reader_id=None,
                reader_is_admin=False,
                member_agent_id=agent.id,
                include_archived=False,
            )
        }
        principal = Principal(bystander.id, False)
        by_policy = {
            r.name for r in rooms.values() if visible_from_outside(principal, r)
        }

        assert {r.name for r in rooms.values() if r.id in by_expression} == expected
        assert by_query == expected
        assert by_agent_query == expected
        assert by_ownerless_agent == expected
        assert by_policy == expected


async def test_a_room_nobody_owns_is_not_let_in_by_a_null(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bystander = await _user(session, "bystander")
        bridge_id = await _bridge(session)
        rooms = []
        for name, visibility, channel_type in (
            ("nobodys-private", "private", None),
            ("nobodys-old-dm", "public", "direct"),
            ("nobodys-unrecorded", "public", None),
        ):
            room = Room(
                transport_room_id=f"!{name}:test",
                name=name,
                description="",
                owner_id=None,
                read_visibility=visibility,
                write_visibility="private",
                channel_type=channel_type,
                bridge_id=bridge_id,
                external_channel_id=f"C-{name}",
            )
            session.add(room)
            rooms.append(room)
        await session.flush()
        ids = [r.id for r in rooms]

        assert (
            await _STORE.visible_room_ids(
                session, ids, readable_by(bystander.id, is_admin=False)
            )
            == set()
        )
        assert (
            await _STORE.visible_room_ids(
                session, ids, readable_by(None, is_admin=False)
            )
            == set()
        )
        assert await _STORE.visible_room_ids(session, ids, open_to_workspace()) == set()


async def test_the_people_in_a_private_channel_room_and_admins_still_see_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        member = await _user(session, "member")
        rooms = await _rooms(session, owner)
        old = rooms["old-private-channel"]
        agent = await add_agent(session, name="members-agent", owner_id=member.id)
        await session.execute(
            insert(room_agents), [{"room_id": old.id, "agent_id": agent.id}]
        )
        await session.flush()

        def names(listed: list[Room]) -> set[str]:
            return {r.name for r in listed}

        assert old.name in names(
            await _STORE.list_readable(session, member.id, is_admin=False)
        )
        assert old.name in names(
            await _STORE.list_readable(session, owner.id, is_admin=False)
        )
        assert names(
            await _STORE.list_readable(session, "u-nobody", is_admin=True)
        ) == {c.name for c in CASES}
        # The agent in the room sees it even with no owner to read through.
        assert old.name in names(
            await _STORE.list_visible_to_agent(
                session,
                reader_id=None,
                reader_is_admin=False,
                member_agent_id=agent.id,
                include_archived=False,
            )
        )


class _NoAdapters:
    def get_adapter(self, bridge_id: str) -> None:
        return None

    def adapter_class(self, bridge_type: str) -> None:
        return None


@pytest.fixture
def no_running_bridges(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rooms_module, "get_collab_lifecycle", lambda: _NoAdapters())


async def _detail(
    session: AsyncSession, room: Room, viewer: User, is_admin: bool
) -> Any:
    return await get_room(
        room.id,
        session,
        _STORE,
        CollaborationBridgeStore(),
        ExternalUserStore(),
        _protocol(),
        _NO_DECISIONS,
        viewer,
        is_admin,
    )


async def _listed(session: AsyncSession, viewer: User, is_admin: bool) -> Any:
    return await list_rooms(
        session,
        _STORE,
        RoomGroupStore(),
        CollaborationBridgeStore(),
        ExternalUserStore(),
        UserStore(),
        viewer,
        is_admin,
    )


@pytest.mark.usefixtures("no_running_bridges")
async def test_the_gateway_answers_not_found_to_a_non_member(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The reported case: a non-member opening an old Slack private channel's
    room, stored public, saw its detail, agents and people."""
    async with session_factory() as session:
        owner = await _user(session, "owner")
        bystander = await _user(session, "bystander")
        admin = await _user(session, "admin")
        rooms = await _rooms(session, owner)
        open_names = {c.name for c in CASES if c.open}

        listed = {r.name for r in await _listed(session, bystander, False)}
        assert listed == open_names
        for case in CASES:
            room = rooms[case.name]
            if case.open:
                assert (await _detail(session, room, bystander, False)).id == room.id
                continue
            with pytest.raises(HTTPException) as refused:
                await _detail(session, room, bystander, False)
            assert refused.value.status_code == 404, case.name
            assert refused.value.detail == "Room not found"

        # Admins are unchanged: every room, listed and opened.
        assert {r.name for r in await _listed(session, admin, True)} == {
            c.name for c in CASES
        }
        old = rooms["old-private-channel"]
        assert (await _detail(session, old, admin, True)).id == old.id
