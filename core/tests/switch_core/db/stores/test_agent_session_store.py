from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    AgentSession,
    ApiKey,
    Client,
    Room,
    User,
)
from switch_core.db.stores.agent_session_store import AgentSessionStore

IDLE_POLL_SECONDS = 30


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
        transport_user_id=f"@{name}:test",
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
        transport_room_id=f"!{name}:test",
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
        window must stay above an idle long-poll's timeout, otherwise a
        healthy agent reads "disconnected" between heartbeats. Keep generous
        headroom for event-handling time on top of the idle cadence."""
        assert AgentSessionStore.ALWAYS_ON_TTL > timedelta(seconds=IDLE_POLL_SECONDS)

    async def test_heartbeat_at_idle_poll_cadence_stays_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A heartbeat as old as an idle 30s long-poll must
        still count as live — this is the false-negative the bug produced when
        TTL (18s) was below the 30s cadence."""
        store = AgentSessionStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "always-on-idle")
            await store.touch_heartbeat(session, agent.id, None)
            await _age_heartbeat(
                session, agent.id, timedelta(seconds=IDLE_POLL_SECONDS)
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
            await store.touch_heartbeat(session, agent.id, room.id)
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
