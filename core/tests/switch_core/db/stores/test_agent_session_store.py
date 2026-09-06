from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.server_connectors.core import (
    CONNECTOR_POLL_TIMEOUT_SECONDS,
)
from switch_core.db.models import Agent, AgentSession, ApiKey, Client, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore


async def _make_agent(session: AsyncSession, name: str) -> Agent:
    """Minimal User → ApiKey → Client → Agent chain (agent_sessions FK)."""
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(
        matrix_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
    )
    session.add(room)
    await session.flush()
    return room


async def _age_heartbeat(session: AsyncSession, agent_id: str, age: timedelta) -> None:
    """Backdate the agent's room-agnostic heartbeat so it is `age` old."""
    await session.execute(
        update(AgentSession)
        .where(AgentSession.agent_id == agent_id)
        .where(AgentSession.room_id.is_(None))
        .values(last_seen_at=datetime.now(UTC) - age)
    )


async def _age_room_heartbeat(
    session: AsyncSession, agent_id: str, room_id: str, age: timedelta
) -> None:
    """Backdate the agent's room-scoped heartbeat so it is `age` old."""
    await session.execute(
        update(AgentSession)
        .where(AgentSession.agent_id == agent_id)
        .where(AgentSession.room_id == room_id)
        .values(last_seen_at=datetime.now(UTC) - age)
    )


class TestLiveness:
    def test_ttl_exceeds_connector_poll_cadence(self) -> None:
        """Regression guard for the always_on flapping bug: the liveness
        window must stay above the connector's long-poll timeout, otherwise a
        healthy agent reads "disconnected" between heartbeats. Keep generous
        headroom for event-handling time on top of the idle cadence."""
        assert AgentSessionStore.ALWAYS_ON_TTL > timedelta(
            seconds=CONNECTOR_POLL_TIMEOUT_SECONDS
        )

    async def test_heartbeat_at_idle_poll_cadence_stays_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A heartbeat as old as the idle connector poll cadence (30s) must
        still count as live — this is the false-negative the bug produced when
        TTL (18s) was below the 30s cadence."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "always-on-idle")
            await store.touch_heartbeat(session, agent.id, None)
            await _age_heartbeat(
                session, agent.id, timedelta(seconds=CONNECTOR_POLL_TIMEOUT_SECONDS)
            )
            await session.commit()

            live = await store.get_live_agent_ids(session, [agent.id], None)
            assert agent.id in live

    async def test_heartbeat_older_than_ttl_is_not_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A genuinely stale heartbeat (older than the TTL, i.e. the agent has
        stopped beating) still drops out of the live set."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "always-on-stale")
            await store.touch_heartbeat(session, agent.id, None)
            await _age_heartbeat(
                session,
                agent.id,
                AgentSessionStore.ALWAYS_ON_TTL + timedelta(seconds=5),
            )
            await session.commit()

            live = await store.get_live_agent_ids(session, [agent.id], None)
            assert agent.id not in live


class TestSessionLiveness:
    """Room-scoped (session_addressable) liveness uses the short SESSION_TTL,
    fed by the dedicated /connection/renew path rather than polling."""

    def test_session_ttl_is_much_shorter_than_always_on(self) -> None:
        assert AgentSessionStore.SESSION_TTL < AgentSessionStore.ALWAYS_ON_TTL

    async def test_fresh_room_heartbeat_is_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "addr-fresh")
            room = await _make_room(session, "addr-fresh-room")
            await store.touch_heartbeat(session, agent.id, room.id)
            await session.commit()

            live = await store.get_live_agent_ids(session, [agent.id], room.id)
            assert agent.id in live

    async def test_room_heartbeat_older_than_session_ttl_is_not_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "addr-stale")
            room = await _make_room(session, "addr-stale-room")
            await store.touch_heartbeat(session, agent.id, room.id)
            await _age_room_heartbeat(
                session,
                agent.id,
                room.id,
                AgentSessionStore.SESSION_TTL + timedelta(seconds=2),
            )
            await session.commit()

            live = await store.get_live_agent_ids(session, [agent.id], room.id)
            assert agent.id not in live

    async def test_short_ttl_applies_only_to_room_scoped_queries(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A room-scoped heartbeat aged past SESSION_TTL but well within
        ALWAYS_ON_TTL is NOT live — the short window applies to room-scoped
        (session_addressable) queries, proving the per-model split."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "addr-split")
            room = await _make_room(session, "addr-split-room")
            await store.touch_heartbeat(session, agent.id, room.id)
            # Older than SESSION_TTL (6s) but far younger than ALWAYS_ON_TTL.
            await _age_room_heartbeat(session, agent.id, room.id, timedelta(seconds=30))
            await session.commit()

            live = await store.get_live_agent_ids(session, [agent.id], room.id)
            assert agent.id not in live


class TestLiveConnectedRooms:
    async def test_returns_fresh_room_bound_sessions_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "hopper")
            room_a = await _make_room(session, "room-a")
            room_b = await _make_room(session, "room-b")
            # Bound and fresh in both rooms (connect_to_room sets the binding).
            await store.set_connected_room(
                session, agent.id, room_a.id, "tx-a", "heartbeat"
            )
            await store.set_connected_room(
                session, agent.id, room_b.id, "tx-b", "heartbeat"
            )
            await session.commit()

            rooms = await store.live_connected_rooms(session, agent.id)
            assert set(rooms) == {room_a.id, room_b.id}

            # Age room-a's session past SESSION_TTL: only room-b remains.
            await _age_room_heartbeat(
                session,
                agent.id,
                room_a.id,
                AgentSessionStore.SESSION_TTL + timedelta(seconds=2),
            )
            await session.commit()
            rooms = await store.live_connected_rooms(session, agent.id)
            assert rooms == [room_b.id]

    async def test_excludes_unbound_heartbeat_rows(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A room-scoped heartbeat with no transport binding (no connect_to_room)
        is not a 'connected' session and must not be listed."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "beater")
            room = await _make_room(session, "beat-room")
            await store.touch_heartbeat(session, agent.id, room.id)
            await session.commit()

            assert await store.live_connected_rooms(session, agent.id) == []

    async def test_excludes_explicit_passive_rows(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """session_passive bindings (lifecycle='explicit') are not live sessions."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "passive")
            room = await _make_room(session, "passive-room")
            await store.set_connected_room(
                session, agent.id, room.id, "tx-p", "explicit"
            )
            await session.commit()

            assert await store.live_connected_rooms(session, agent.id) == []


class TestHasRoomBinding:
    async def test_true_for_transport_bound_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """connect_to_room sets a transport binding — has_room_binding sees it
        regardless of liveness (no session-close signal clears it)."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "bound")
            room = await _make_room(session, "bound-room")
            await store.set_connected_room(
                session, agent.id, room.id, "tx-b", "heartbeat"
            )
            await session.commit()

            assert await store.has_room_binding(session, agent.id, room.id)

    async def test_true_even_when_heartbeat_is_stale(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A bound-but-not-live session (stale heartbeat) still counts — this is
        exactly the dev-channels-flag-missing case the warning targets."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "stale-bound")
            room = await _make_room(session, "stale-bound-room")
            await store.set_connected_room(
                session, agent.id, room.id, "tx-sb", "heartbeat"
            )
            await _age_room_heartbeat(
                session,
                agent.id,
                room.id,
                AgentSessionStore.SESSION_TTL + timedelta(minutes=5),
            )
            await session.commit()

            assert await store.has_room_binding(session, agent.id, room.id)

    async def test_false_when_no_session_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "absent")
            room = await _make_room(session, "absent-room")
            await session.commit()

            assert not await store.has_room_binding(session, agent.id, room.id)

    async def test_false_for_heartbeat_without_transport_binding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A bare heartbeat row (no connect_to_room) is not a session binding."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "beater")
            room = await _make_room(session, "beat-room")
            await store.touch_heartbeat(session, agent.id, room.id)
            await session.commit()

            assert not await store.has_room_binding(session, agent.id, room.id)

    async def test_scoped_to_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A binding to another room does not count as bound here."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "elsewhere")
            here = await _make_room(session, "here-room")
            there = await _make_room(session, "there-room")
            await store.set_connected_room(
                session, agent.id, there.id, "tx-e", "heartbeat"
            )
            await session.commit()

            assert await store.has_room_binding(session, agent.id, there.id)
            assert not await store.has_room_binding(session, agent.id, here.id)


class TestGetSessionsForAgent:
    async def test_returns_all_rows_regardless_of_freshness(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The detail view needs every session row — room-agnostic and
        room-scoped, fresh or stale — so it can show each one's derived state."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "lister")
            room = await _make_room(session, "lister-room")
            await store.touch_heartbeat(session, agent.id, None)
            await store.set_connected_room(
                session, agent.id, room.id, "tx-list", "heartbeat"
            )
            # Stale room heartbeat must still be returned.
            await _age_room_heartbeat(
                session,
                agent.id,
                room.id,
                AgentSessionStore.SESSION_TTL + timedelta(seconds=10),
            )
            await session.commit()

            rows = await store.get_sessions_for_agent(session, agent.id)
            by_room = {r.room_id: r for r in rows}
            assert set(by_room) == {None, room.id}
            assert by_room[room.id].transport_session_id == "tx-list"

    async def test_excludes_other_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "mine")
            other = await _make_agent(session, "theirs")
            await store.touch_heartbeat(session, agent.id, None)
            await store.touch_heartbeat(session, other.id, None)
            await session.commit()

            rows = await store.get_sessions_for_agent(session, agent.id)
            assert [r.agent_id for r in rows] == [agent.id]
