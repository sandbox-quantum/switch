"""Taking an account out of every room, and freezing a room, against Postgres
(`room_moderation.py`).

A removal goes through the single-room steps the rest of Switch uses, so each
room it left records the departure, and the audit log has one event naming
every room. A freeze is recorded, told to the room, and refused a second
time; while it holds the room takes no posts, and once lifted it does.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.admin_messages import ADMIN_MARKER
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Client,
    ClientRoom,
    Message,
    Room,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_moderation import (
    FROZEN_NOTICE,
    UNFROZEN_NOTICE,
    AccountRemoval,
    ModerationConflict,
    ModerationTargetNotFound,
    RoomFreeze,
)
from switch_core.room_read_only import RoomReadOnly
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    process_on,
)
from tests.switch_core.hosted_machine_helpers import add_tenant


class _Listeners:
    def __init__(self) -> None:
        self.agents_changed: list[str] = []
        self.changed: list[str] = []
        self.memberships: list[tuple[str, list[str], list[str]]] = []

    async def room_agents_changed(self, tenant_id: str, room_id: str) -> None:
        self.agents_changed.append(room_id)

    def room_changed(self, tenant_id: str, room_id: str) -> None:
        self.changed.append(room_id)

    def memberships_changed(
        self, tenant_id: str, user_ids: list[str], room_ids: list[str]
    ) -> None:
        self.memberships.append((tenant_id, user_ids, room_ids))


def _removal(
    session_factory: async_sessionmaker[AsyncSession],
    process: Process,
    listeners: _Listeners,
) -> AccountRemoval:
    return AccountRemoval(
        session_factory=session_factory,
        provisioning=process.provisioning,
        room_store=RoomStore(),
        listeners=listeners,
        memberships_changed=listeners.memberships_changed,
    )


async def _audit(
    session_factory: async_sessionmaker[AsyncSession], action: AuditAction
) -> list[AuditEvent]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return list(
            await session.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == action.value)
                .order_by(AuditEvent.occurred_at)
            )
        )


async def _departures(
    session_factory: async_sessionmaker[AsyncSession], room: Room, client: Client
) -> list[Message]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return [
            row
            for row in await session.scalars(
                select(Message).where(
                    Message.room_id == room.id,
                    Message.sender_client_id == client.id,
                    Message.event_type == "m.room.member",
                )
            )
            if row.content.get("membership") == "leave"
        ]


async def _memberships(
    session_factory: async_sessionmaker[AsyncSession], client: Client
) -> list[str]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return list(
            await session.scalars(
                select(ClientRoom.room_id).where(ClientRoom.client_id == client.id)
            )
        )


async def _room_agent_rows(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> list[str]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return list(
            await session.scalars(
                select(room_agents.c.room_id).where(room_agents.c.agent_id == agent_id)
            )
        )


async def _admin(session_factory: async_sessionmaker[AsyncSession]) -> User:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        user = User(
            name="secops",
            email=f"secops-{uuid.uuid4().hex[:6]}@test.local",
            role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
    return user


async def test_an_agent_leaves_every_room_with_a_departure_in_each(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    listeners = _Listeners()
    agent, client = await make_agent(session_factory, "suspect")
    bystander, bystander_client = await make_agent(session_factory, "bystander")
    rooms = [await make_room(session_factory, f"room-{i}") for i in range(3)]
    untouched = await make_room(session_factory, "elsewhere")
    for room in rooms:
        await add_member(session_factory, room, client, agent=agent)
        await add_member(session_factory, room, bystander_client, agent=bystander)
    await add_member(session_factory, untouched, bystander_client, agent=bystander)
    actor = await _admin(session_factory)

    result = await _removal(session_factory, process, listeners).remove_agent(
        TENANT_ZERO_ID,
        agent.id,
        actor_user_id=actor.id,
        removed_by="secops",
        request="INC-1",
    )

    assert sorted(room.id for room in result.rooms) == sorted(r.id for r in rooms)
    assert await _memberships(session_factory, client) == []
    assert await _room_agent_rows(session_factory, agent.id) == []
    assert sorted(await _room_agent_rows(session_factory, bystander.id)) == sorted(
        [*(r.id for r in rooms), untouched.id]
    )
    for room in rooms:
        [departure] = await _departures(session_factory, room, client)
        assert departure.content["removed_by"] == "secops"
    assert sorted(listeners.agents_changed) == sorted(r.id for r in rooms)
    [event] = await _audit(session_factory, AuditAction.MEMBER_REMOVED_FROM_ALL_ROOMS)
    assert event.actor_user_id == actor.id
    assert event.target_type == "agent"
    assert event.target_id == agent.id
    assert sorted(room["id"] for room in event.details["rooms"]) == sorted(
        r.id for r in rooms
    )
    assert event.details["request"] == "INC-1"


async def test_a_person_leaves_every_room_with_their_agents(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    listeners = _Listeners()
    agent, agent_client = await make_agent(session_factory, "theirs")
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        member = Client(
            transport_user_id=f"@member-{uuid.uuid4().hex[:6]}:test",
            display_name="mallory",
            type=MEMBER_CLIENT_TYPE,
            user_id=agent.owner_id,
        )
        session.add(member)
        await session.commit()
        await session.refresh(member)
    chat = await make_room(session_factory, "chat")
    shared = await make_room(session_factory, "shared")
    await add_member(session_factory, chat, member)
    await add_member(session_factory, shared, member)
    await add_member(session_factory, shared, agent_client, agent=agent)
    actor = await _admin(session_factory)

    result = await _removal(session_factory, process, listeners).remove_person(
        TENANT_ZERO_ID,
        agent.owner_id,
        include_agents=True,
        actor_user_id=actor.id,
        removed_by="secops",
        request=None,
    )

    assert sorted(room.id for room in result.rooms) == sorted([chat.id, shared.id])
    assert [room.id for room in result.agents[agent.id]] == [shared.id]
    assert await _memberships(session_factory, member) == []
    assert await _memberships(session_factory, agent_client) == []
    assert len(await _departures(session_factory, chat, member)) == 1
    assert len(await _departures(session_factory, shared, agent_client)) == 1
    assert listeners.memberships == [
        (TENANT_ZERO_ID, [agent.owner_id], [chat.id, shared.id])
    ]
    [event] = await _audit(session_factory, AuditAction.MEMBER_REMOVED_FROM_ALL_ROOMS)
    assert event.target_type == "user"
    assert [room["id"] for room in event.details["agents"][agent.id]] == [shared.id]


async def test_an_account_of_another_workspace_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await add_tenant(session, "other")
        await session.commit()
    agent, client = await make_agent(session_factory, "theirs", tenant_id="other")
    room = await make_room(session_factory, "theirs", tenant_id="other")
    await add_member(session_factory, room, client, agent=agent)
    actor = await _admin(session_factory)
    removal = _removal(session_factory, process, _Listeners())

    with pytest.raises(ModerationTargetNotFound):
        await removal.remove_agent(
            TENANT_ZERO_ID,
            agent.id,
            actor_user_id=actor.id,
            removed_by="secops",
            request=None,
        )
    with pytest.raises(ModerationTargetNotFound):
        await removal.remove_person(
            TENANT_ZERO_ID,
            agent.owner_id,
            include_agents=True,
            actor_user_id=actor.id,
            removed_by="secops",
            request=None,
        )

    async with tenant_session(session_factory, "other") as session:
        assert list(
            await session.scalars(
                select(ClientRoom.room_id).where(ClientRoom.client_id == client.id)
            )
        ) == [room.id]
    assert (
        await _audit(session_factory, AuditAction.MEMBER_REMOVED_FROM_ALL_ROOMS) == []
    )


async def test_freezing_a_room_refuses_posts_until_it_is_unfrozen(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory, "incident")
    alice = await make_person(session_factory, "alice")
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        system = Client(
            transport_user_id=f"@switch-{uuid.uuid4().hex[:6]}:test",
            display_name="Switch",
            type="admin",
        )
        session.add(system)
        await session.commit()
        await session.refresh(system)
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, system)
    actor = await _admin(session_factory)

    async def post_notice(tenant_id: str, transport_room_id: str, body: str) -> None:
        await process.transport(system).send_message(
            transport_room_id,
            body,
            sender_name="Switch",
            metered=False,
            format="markdown",
            thread_root_id=None,
            extra_content={ADMIN_MARKER: {"type": "room_settings_notice"}},
        )

    freeze = RoomFreeze(
        session_factory=session_factory, room_store=RoomStore(), post_notice=post_notice
    )

    assert (
        await freeze.freeze(
            TENANT_ZERO_ID, room.id, actor_user_id=actor.id, reason="INC-7 exfil"
        )
        is None
    )
    with pytest.raises(ModerationConflict):
        await freeze.freeze(TENANT_ZERO_ID, room.id, actor_user_id=actor.id, reason="x")
    with pytest.raises(RoomReadOnly):
        await process.say(room, "anyone there?", sender=alice)

    assert (
        await freeze.unfreeze(TENANT_ZERO_ID, room.id, actor_user_id=actor.id) is None
    )
    await process.say(room, "back", sender=alice)
    with pytest.raises(ModerationConflict):
        await freeze.unfreeze(TENANT_ZERO_ID, room.id, actor_user_id=actor.id)

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        bodies = list(
            await session.scalars(
                select(Message.body)
                .where(Message.room_id == room.id)
                .order_by(Message.seq)
            )
        )
        stored = await session.get(Room, room.id)
        assert stored is not None
        assert stored.frozen_at is None and stored.frozen_reason is None
    assert bodies == [FROZEN_NOTICE, UNFROZEN_NOTICE, "back"]
    [frozen] = await _audit(session_factory, AuditAction.ROOM_FROZEN)
    assert frozen.actor_user_id == actor.id
    assert frozen.details["reason"] == "INC-7 exfil"
    [unfrozen] = await _audit(session_factory, AuditAction.ROOM_UNFROZEN)
    assert unfrozen.details["frozen_by"] == actor.id


async def test_a_freeze_needs_a_reason(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await make_room(session_factory, "incident")
    actor = await _admin(session_factory)

    async def never(*_args: str) -> None:
        raise AssertionError("no notice for a refused freeze")

    freeze = RoomFreeze(
        session_factory=session_factory, room_store=RoomStore(), post_notice=never
    )
    with pytest.raises(ValueError):
        await freeze.freeze(TENANT_ZERO_ID, room.id, actor_user_id=actor.id, reason=" ")


async def test_a_freeze_holds_when_the_room_cannot_be_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await make_room(session_factory, "incident")
    actor = await _admin(session_factory)

    async def broken(*_args: str) -> None:
        raise RuntimeError("No admin client is running")

    freeze = RoomFreeze(
        session_factory=session_factory, room_store=RoomStore(), post_notice=broken
    )
    error = await freeze.freeze(
        TENANT_ZERO_ID, room.id, actor_user_id=actor.id, reason="INC-8"
    )

    assert error is not None and "No admin client" in error
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        stored = await session.get(Room, room.id)
        assert stored is not None and stored.frozen_at is not None
