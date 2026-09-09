"""Pointing a session at a room, and who is allowed to.

Two permissions have to hold at once and they protect opposite things, so most
of this file is one of them being present and the other missing. Driven through
the route rather than the service, because the route is where a real caller's
identity turns into a `Principal` and that conversion is part of the rule.

The last class is the property the slice exists for, and it is a negative:
nothing on the host's side of the tree can reach this. That is checked by
looking at the tree, not by calling anything — there is no call to make.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_room_association_store import (
    SessionRoomAssociationStore,
)
from switch_core.db.stores.session_store import SessionStore
from switch_core.gateway.schemas import (
    SessionAssociationRequest,
    SessionAssociationResponse,
)
from switch_core.gateway.sessions import associate_session_with_room
from switch_core.session_association import SessionAssociationService
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

REPO_ROOT = Path(__file__).resolve().parents[4]

_SERVICE = SessionAssociationService(
    SessionStore(), SessionRoomAssociationStore(), RoomStore(), AgentStore()
)


async def _add_room(
    session: AsyncSession,
    *,
    name: str,
    owner_id: str | None,
    write_visibility: str = "private",
) -> Room:
    room = Room(
        matrix_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
        owner_id=owner_id,
        read_visibility="private",
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


async def _associate(
    session: AsyncSession, session_id: str, room_id: str, user: User
) -> SessionAssociationResponse:
    return await associate_session_with_room(
        session_id,
        SessionAssociationRequest(room_id=room_id),
        session,
        _SERVICE,
        user,
    )


class TestTheTwoPermissions:
    async def test_one_owner_of_both_may_associate(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(db, name="r1", owner_id=owner.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            answer = await _associate(db, "s1", room.id, owner)

            assert answer.room_id == room.id
            assert answer.source == "granted"
            assert answer.granted_by_actor_id == owner.id

    async def test_owning_the_room_is_not_enough(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Publishing shows a room what a session is doing, so it takes
        authority over the session, not only over the room being written to."""
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            stranger = await add_user(db, name="stranger")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(db, name="r1", owner_id=stranger.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "s1", room.id, stranger)

            assert refusal.value.status_code == 403
            assert await SessionRoomAssociationStore().get(db, "s1") is None

    async def test_owning_the_session_is_not_enough(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """And it puts posts in a room, so it takes write on the room."""
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            stranger = await add_user(db, name="stranger")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(db, name="r1", owner_id=stranger.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "s1", room.id, owner)

            assert refusal.value.status_code == 403
            assert await SessionRoomAssociationStore().get(db, "s1") is None

    async def test_a_publicly_writable_room_supplies_its_half(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            stranger = await add_user(db, name="stranger")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(
                db, name="r1", owner_id=stranger.id, write_visibility="public"
            )
            await SessionStore().register(db, "s1", agent.id, "host-a")

            answer = await _associate(db, "s1", room.id, owner)

            assert answer.room_id == room.id

    async def test_a_public_room_does_not_supply_the_other_half(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A room anyone may write to is not a session anyone may expose."""
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            stranger = await add_user(db, name="stranger")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(
                db, name="r1", owner_id=stranger.id, write_visibility="public"
            )
            await SessionStore().register(db, "s1", agent.id, "host-a")

            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "s1", room.id, stranger)

            assert refusal.value.status_code == 403

    async def test_an_admin_may_associate_anything(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            admin = await add_user(db, name="admin", role="admin")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(db, name="r1", owner_id=owner.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            answer = await _associate(db, "s1", room.id, admin)

            assert answer.granted_by_actor_id == admin.id

    async def test_an_agent_nobody_owns_needs_an_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`require_manage` treats a null owner as owned by nobody, so an
        ownerless agent's session cannot be exposed by an ordinary user.

        The agent keeps the key it was registered with — `api_keys.user_id` is
        not nullable and `agents.owner_id` is, so losing an owner is a state a
        real row can be in.
        """
        async with session_factory() as db:
            user = await add_user(db, name="user")
            agent = await add_agent(db, name="a1", owner_id=user.id)
            agent.owner_id = None
            await db.flush()
            room = await _add_room(db, name="r1", owner_id=user.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "s1", room.id, user)

            assert refusal.value.status_code == 403


class TestWhatIsNotThere:
    async def test_an_unregistered_session_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A session id is host-generated and not a secret, so associating one
        that does not exist must not reserve a room against it."""
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            room = await _add_room(db, name="r1", owner_id=owner.id)

            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "no-such-session", room.id, owner)

            assert refusal.value.status_code == 404

    async def test_a_room_that_does_not_exist_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "s1", "no-such-room", owner)

            assert refusal.value.status_code == 404


class TestOneRoomPerSession:
    async def test_a_second_association_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Moving a session is a decision about a room someone is already
        watching, so it is not something a second call makes silently."""
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            first = await _add_room(db, name="r1", owner_id=owner.id)
            second = await _add_room(db, name="r2", owner_id=owner.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            await _associate(db, "s1", first.id, owner)
            with pytest.raises(HTTPException) as refusal:
                await _associate(db, "s1", second.id, owner)

            assert refusal.value.status_code == 409
            held = await SessionRoomAssociationStore().get(db, "s1")
            assert held is not None
            assert held.room_id == first.id

    async def test_the_refusal_leaves_the_transaction_usable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The savepoint is the point: a caller has to be able to answer."""
        async with session_factory() as db:
            owner = await add_user(db, name="owner")
            agent = await add_agent(db, name="a1", owner_id=owner.id)
            room = await _add_room(db, name="r1", owner_id=owner.id)
            await SessionStore().register(db, "s1", agent.id, "host-a")

            await _associate(db, "s1", room.id, owner)
            with pytest.raises(HTTPException):
                await _associate(db, "s1", room.id, owner)

            assert await SessionRoomAssociationStore().get(db, "s1") is not None


class TestTheHostCannotAssociateItself:
    def test_nothing_on_the_agent_bridge_reaches_the_association(self) -> None:
        """The lease and the events route are everything a host credential can
        reach. Neither imports the association store or this service, and that
        is what makes "a leaseholder still cannot publish" a fact about the code
        rather than about the checks currently written into it.
        """
        agent_side = REPO_ROOT / "core/switch_core/bridges/agent"
        offenders = [
            path.relative_to(REPO_ROOT)
            for path in agent_side.rglob("*.py")
            if "session_room_association" in path.read_text()
            or "SessionAssociationService" in path.read_text()
        ]
        assert offenders == []
