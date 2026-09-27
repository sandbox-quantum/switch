"""The batched reads must answer exactly what the per-room ones did.

`assemble_agent_detail` used to walk an agent's rooms issuing five queries per
membership — four for presence, one for the role lease. Two of the four never
depended on the room. The Console polls that view for every agent it shows,
so it is the hottest endpoint we have, and the loop was most of its cost.

Batching it is only worth anything if the answer is identical, and "identical"
here is not obvious: presence is a union of three sources with a different
TTL per connection model, and the room-scoped and room-agnostic arms are not
interchangeable. So these tests do not assert a hand-written expectation —
they run both implementations over the same state and require them to agree.
A hand-written expectation would only prove I understood the rules the same
way twice.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.statuses import (
    compute_agent_statuses,
    compute_agent_statuses_for_rooms,
)
from switch_core.db.models import Agent, AgentSession, ApiKey, Client, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.room_role_store import RoomRoleStore

_SESSIONS = AgentSessionStore()
_ROLES = RoomRoleStore()

# One per connection model, because the models take different arms of the
# presence union and a batching bug could easily hit only one of them.
_MODELS = ["always_on", "session_addressable", "auto_session", "session_passive"]


async def _fixture(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    stale: bool = False,
) -> tuple[list[Agent], list[str]]:
    """Four agents, one per connection model, in three rooms.

    `stale` ages the heartbeat rows past `SESSION_TTL` so the same shape also
    exercises the not-live branch — the batched read applies the TTL itself,
    so getting that wrong is a live failure mode rather than a hypothetical.
    """
    async with session_factory() as session:
        user = User(name="owner", email="owner@example.com", role="user")
        session.add(user)
        await session.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash="hash-batched-statuses",
            encrypted_key="x",
            label="l",
            type="agent",
        )
        session.add(key)
        await session.flush()

        rooms = []
        for i in range(3):
            room = Room(
                matrix_room_id=f"!batched-{i}:test",
                name=f"room-{i}",
                description="d",
                owner_id=user.id,
            )
            session.add(room)
            await session.flush()
            rooms.append(room.id)

        agents = []
        for model in _MODELS:
            client = Client(
                matrix_user_id=f"@batched-{model}:test",
                display_name=model,
                type="agent",
            )
            session.add(client)
            await session.flush()
            agent = Agent(
                name=f"batched-{model}",
                description="d",
                agent_type="claude-code",
                connector_type="mcp",
                integration_profile={"connection_model": model},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
            )
            session.add(agent)
            await session.flush()
            agents.append(agent)

        age = timedelta(seconds=600) if stale else timedelta(seconds=0)
        seen = datetime.now(UTC) - age
        # A room-scoped beat in the first two rooms only, so the third room is
        # a genuine "no row" case rather than an aged one.
        for agent in agents:
            for room_id in rooms[:2]:
                session.add(
                    AgentSession(
                        agent_id=agent.id,
                        room_id=room_id,
                        lifecycle="heartbeat",
                        last_seen_at=seen,
                    )
                )
            # …plus the room-agnostic row always_on and auto_session read.
            session.add(
                AgentSession(
                    agent_id=agent.id,
                    room_id=None,
                    lifecycle="heartbeat",
                    last_seen_at=seen,
                )
            )
        await session.commit()
        for agent in agents:
            session.expunge(agent)
        return agents, rooms


@pytest.mark.parametrize("stale", [False, True], ids=["fresh", "stale"])
class TestBatchedStatusesMatchPerRoom:
    async def test_same_status_for_every_agent_in_every_room(
        self, session_factory: async_sessionmaker[AsyncSession], stale: bool
    ) -> None:
        agents, rooms = await _fixture(session_factory, stale=stale)
        connections = ConnectionRegistry()

        async with session_factory() as session:
            batched = await compute_agent_statuses_for_rooms(
                session, agents, rooms, _SESSIONS, connections
            )
            for room_id in rooms:
                one_at_a_time = await compute_agent_statuses(
                    session, agents, room_id, _SESSIONS, connections
                )
                assert batched[room_id] == one_at_a_time, (
                    f"batched and per-room disagree for room {room_id}"
                )

    async def test_agrees_when_called_one_agent_at_a_time(
        self, session_factory: async_sessionmaker[AsyncSession], stale: bool
    ) -> None:
        # How the agent-detail view actually calls it — a single agent over
        # its rooms — which is a different code path through the partitioning
        # than a full fleet in one go.
        agents, rooms = await _fixture(session_factory, stale=stale)
        connections = ConnectionRegistry()

        async with session_factory() as session:
            for agent in agents:
                batched = await compute_agent_statuses_for_rooms(
                    session, [agent], rooms, _SESSIONS, connections
                )
                for room_id in rooms:
                    expected = await compute_agent_statuses(
                        session, [agent], room_id, _SESSIONS, connections
                    )
                    assert batched[room_id] == expected


class TestBatchedStatusEdges:
    async def test_no_rooms_is_empty_not_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        agents, _ = await _fixture(session_factory)
        async with session_factory() as session:
            assert (
                await compute_agent_statuses_for_rooms(
                    session, agents, [], _SESSIONS, ConnectionRegistry()
                )
                == {}
            )

    async def test_every_room_asked_for_gets_an_answer(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The caller indexes the result by room id directly, so a room with no
        # rows at all must still appear rather than raising a KeyError.
        agents, rooms = await _fixture(session_factory)
        async with session_factory() as session:
            out = await compute_agent_statuses_for_rooms(
                session, agents, rooms, _SESSIONS, ConnectionRegistry()
            )
        assert set(out) == set(rooms)
        for room_id in rooms:
            assert set(out[room_id]) == {a.id for a in agents}


class TestBatchedRoomRoles:
    async def test_matches_the_single_room_lookup(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        agents, rooms = await _fixture(session_factory)
        agent = agents[0]
        async with session_factory() as session:
            live: list[str] = []
            batched = await _ROLES.agent_room_roles(session, rooms, agent.id, live)
            for room_id in rooms:
                one = await _ROLES.agent_room_role(session, room_id, agent.id, live)
                assert batched.get(room_id) == one

    async def test_no_rooms_is_empty(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        agents, _ = await _fixture(session_factory)
        async with session_factory() as session:
            assert await _ROLES.agent_room_roles(session, [], agents[0].id, []) == {}
