"""The room handlers must not hold a pooled connection across provisioning.

A gateway handler that authorizes on the request's session and then awaits
Matrix/bridge work keeps that session's connection checked out for the whole
external call. Under a reconnect stampede those parked slots are what fills
the pool (30 + 10 overflow) and turns a slow minute into `db_pool_timeout`
errors, so the authorization read is scoped to a session of its own that
closes before the external call starts.

Each test drives the route coroutine with a room service that stands in for
that external work: it records how many connections the pool has checked out
at the moment it is entered, then raises. Zero is the property under test.
Raising is what keeps these tests free of a `ProtocolService` — the read-back
that builds the `RoomDetail` never runs — and it doubles as a check that the
handler reaches its external call at all, which is what caught `unarchive_room`
still passing a session where the rewritten `_set_archived` wanted a factory.

Every handler is called by keyword, the way FastAPI calls it. Positionally,
two signatures of the same length line up whatever their parameters mean, and
that is exactly the mistake under test here: `unarchive_room` handing
`_set_archived` a session for its factory and a bool for its user reads as a
correct call at every position.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.rooms import (
    archive_room,
    delete_room,
    delete_room_agent,
    post_room_agents,
    post_room_users,
    unarchive_room,
)
from switch_core.gateway.schemas import RoomAgentsRequest, RoomUsersRequest

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()


class _ExternalCallReached(Exception):
    """Raised by the stand-in service once it has sampled the pool.

    Deliberately not a `ValueError`: the handlers translate that into a 404 or
    a 400, which would hide whether the call happened.
    """


class _PoolProbeRoomService:
    """A `RoomService` stand-in that reports the pool's state when called.

    Every method is one of the slow provisioning calls a handler makes after
    authorizing. Real ones talk to Matrix and the collaboration bridge and
    manage sessions of their own; here the only thing that matters is what the
    pool looks like at the moment control reaches them.
    """

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._pool = session_factory.kw["bind"].pool
        self.checked_out: int | None = None

    def _probe(self) -> None:
        self.checked_out = self._pool.checkedout()
        raise _ExternalCallReached()

    async def set_room_archived(self, room_id: str, archived: bool) -> None:
        self._probe()

    async def delete_room(self, room_id: str) -> None:
        self._probe()

    async def add_agents_to_room(self, room_id: str, **kwargs: Any) -> None:
        self._probe()

    async def remove_agents_from_room(self, room_id: str, agent_ids: list[str]) -> None:
        self._probe()

    async def add_users_to_room(self, room_id: str, user_names: list[str]) -> None:
        self._probe()


async def _owner_and_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[User, Room]:
    """A room its owner may write, committed and detached from any session.

    Committed rather than flushed, and the session closed, so the setup does
    not itself hold the connection the assertion is about.
    """
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.com", role="user")
        session.add(owner)
        await session.flush()
        room = Room(
            matrix_room_id="!scoped:test",
            name="scoped",
            description="d",
            owner_id=owner.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.commit()
        return owner, room


async def _assert_released(
    session_factory: async_sessionmaker[AsyncSession],
    service: _PoolProbeRoomService,
    call: Any,
) -> None:
    with pytest.raises(_ExternalCallReached):
        await call
    assert service.checked_out == 0, (
        "a pooled connection was still checked out when the handler started its "
        "external call — the authorization read is holding it across provisioning"
    )


class TestRoomHandlersReleaseTheConnection:
    async def test_archive(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, room = await _owner_and_room(session_factory)
        svc = _PoolProbeRoomService(session_factory)

        await _assert_released(
            session_factory,
            svc,
            archive_room(
                room_id=room.id,
                session_factory=session_factory,
                room_service=svc,  # type: ignore[arg-type]
                room_store=_ROOM_STORE,
                bridge_store=None,  # type: ignore[arg-type]
                external_user_store=None,  # type: ignore[arg-type]
                protocol=None,  # type: ignore[arg-type]
                user_store=_USER_STORE,
                user=owner,
            ),
        )

    async def test_unarchive(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The regression: this handler was left calling `_set_archived` with
        # the pre-rewrite arguments, so it failed before reaching the service
        # at all.
        owner, room = await _owner_and_room(session_factory)
        svc = _PoolProbeRoomService(session_factory)

        await _assert_released(
            session_factory,
            svc,
            unarchive_room(
                room_id=room.id,
                session_factory=session_factory,
                room_service=svc,  # type: ignore[arg-type]
                room_store=_ROOM_STORE,
                bridge_store=None,  # type: ignore[arg-type]
                external_user_store=None,  # type: ignore[arg-type]
                protocol=None,  # type: ignore[arg-type]
                user_store=_USER_STORE,
                user=owner,
            ),
        )

    async def test_delete(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, room = await _owner_and_room(session_factory)
        svc = _PoolProbeRoomService(session_factory)

        await _assert_released(
            session_factory,
            svc,
            delete_room(
                room_id=room.id,
                session_factory=session_factory,
                room_service=svc,  # type: ignore[arg-type]
                room_store=_ROOM_STORE,
                user_store=_USER_STORE,
                user=owner,
            ),
        )

    async def test_add_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, room = await _owner_and_room(session_factory)
        svc = _PoolProbeRoomService(session_factory)

        await _assert_released(
            session_factory,
            svc,
            post_room_agents(
                room_id=room.id,
                req=RoomAgentsRequest(agent_ids=["agent-1"]),
                session_factory=session_factory,
                room_service=svc,  # type: ignore[arg-type]
                room_store=_ROOM_STORE,
                bridge_store=None,  # type: ignore[arg-type]
                external_user_store=None,  # type: ignore[arg-type]
                protocol=None,  # type: ignore[arg-type]
                user_store=_USER_STORE,
                user=owner,
            ),
        )

    async def test_remove_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, room = await _owner_and_room(session_factory)
        svc = _PoolProbeRoomService(session_factory)

        await _assert_released(
            session_factory,
            svc,
            delete_room_agent(
                room_id=room.id,
                agent_id="agent-1",
                session_factory=session_factory,
                room_service=svc,  # type: ignore[arg-type]
                room_store=_ROOM_STORE,
                bridge_store=None,  # type: ignore[arg-type]
                external_user_store=None,  # type: ignore[arg-type]
                protocol=None,  # type: ignore[arg-type]
                user_store=_USER_STORE,
                user=owner,
            ),
        )

    async def test_add_users(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, room = await _owner_and_room(session_factory)
        svc = _PoolProbeRoomService(session_factory)

        await _assert_released(
            session_factory,
            svc,
            post_room_users(
                room_id=room.id,
                req=RoomUsersRequest(user_names=["someone"]),
                session_factory=session_factory,
                room_service=svc,  # type: ignore[arg-type]
                room_store=_ROOM_STORE,
                bridge_store=None,  # type: ignore[arg-type]
                external_user_store=None,  # type: ignore[arg-type]
                protocol=None,  # type: ignore[arg-type]
                user_store=_USER_STORE,
                user=owner,
            ),
        )
