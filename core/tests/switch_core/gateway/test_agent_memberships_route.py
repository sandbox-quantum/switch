"""`GET /agents/memberships` — one read in place of a fan-out.

Switch Console redraws its room-grouped sidebar on a timer by calling
`GET /agents/{id}` once per agent, around a hundred requests a minute on the
pilot. Each one assembled tools, models, sessions, child agents, per-room
presence and role leases so that three fields could be taken off it. This
route answers the same question for every agent at once, carrying only those
three fields.

Two things are worth pinning beyond the happy path. The route sits at a
literal path under the same prefix as `/{agent_id}`, so declaration order
decides whether it is reachable at all — a mistake no unit test of the
handler could catch. And an agent in no rooms has to come back with an empty
list rather than be absent, because the caller caches the answer and would
otherwise keep asking about the quiet ones.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, room_agents
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.agents import get_agent_room_memberships
from switch_core.gateway.agents import router as agents_router
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

_ROOMS = RoomStore()
_AGENTS = AgentStore()


async def _room(session: AsyncSession, name: str, *, archived: bool = False) -> Room:
    room = Room(matrix_room_id=f"!{name}:test", name=name, description="d")
    if archived:
        from datetime import UTC, datetime

        room.archived_at = datetime.now(UTC)
    session.add(room)
    await session.flush()
    return room


async def _join(session: AsyncSession, room: Room, agent_id: str) -> None:
    await session.execute(
        room_agents.insert().values(room_id=room.id, agent_id=agent_id)
    )


async def _call(session: AsyncSession, user):  # type: ignore[no-untyped-def]
    return await get_agent_room_memberships(
        session=session,
        room_store=_ROOMS,
        agent_store=_AGENTS,
        _user=user,
    )


class TestMembershipsAreReportedPerAgent:
    async def test_each_agent_gets_the_rooms_it_is_in(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await add_user(session, name="owner")
            alice = await add_agent(session, name="alice", owner_id=user.id)
            bob = await add_agent(session, name="bob", owner_id=user.id)
            shared = await _room(session, "shared")
            alice_only = await _room(session, "alice-only")
            await _join(session, shared, alice.id)
            await _join(session, shared, bob.id)
            await _join(session, alice_only, alice.id)
            await session.commit()

            result = await _call(session, user)

        got = {
            agent_id: sorted(m.room_name for m in rooms)
            for agent_id, rooms in result.memberships.items()
        }
        assert got[alice.id] == ["alice-only", "shared"]
        assert got[bob.id] == ["shared"]

    async def test_an_agent_in_no_rooms_gets_an_empty_list_not_silence(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await add_user(session, name="owner")
            lonely = await add_agent(session, name="lonely", owner_id=user.id)
            await session.commit()

            result = await _call(session, user)

        assert lonely.id in result.memberships, (
            "an agent with no rooms went missing — the caller cannot tell that "
            "from 'not answered' and will keep asking"
        )
        assert result.memberships[lonely.id] == []

    async def test_archived_rooms_are_reported_and_flagged(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Reported rather than filtered: the caller does its own filtering and
        # some views show archived rooms. Dropping them here would silently
        # change what the sidebar can display.
        async with session_factory() as session:
            user = await add_user(session, name="owner")
            agent = await add_agent(session, name="a", owner_id=user.id)
            live = await _room(session, "live")
            old = await _room(session, "old", archived=True)
            await _join(session, live, agent.id)
            await _join(session, old, agent.id)
            await session.commit()

            result = await _call(session, user)

        by_name = {m.room_name: m.archived for m in result.memberships[agent.id]}
        assert by_name == {"live": False, "old": True}

    async def test_it_agrees_with_the_per_agent_endpoint_it_replaces(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The whole point is that the Console can stop calling the other one.
        async with session_factory() as session:
            user = await add_user(session, name="owner")
            agent = await add_agent(session, name="a", owner_id=user.id)
            for name in ("one", "two"):
                await _join(session, await _room(session, name), agent.id)
            await session.commit()

            batched = await _call(session, user)
            per_agent = await _ROOMS.get_agent_room_memberships(session, agent.id)

        assert sorted(
            (m.room_id, m.room_name, m.archived) for m in batched.memberships[agent.id]
        ) == sorted(per_agent)


class TestTheRouteIsActuallyReachable:
    def test_memberships_is_not_swallowed_by_the_agent_id_route(self) -> None:
        """`/memberships` must be matched before `/{agent_id}`.

        Both live under `/agents`, and FastAPI matches in declaration order,
        so moving this route below the path-parameter one would turn every
        call into a lookup for an agent literally named "memberships" — a 404
        that looks like a data problem rather than a routing one.
        """
        # Asked of the router rather than a built app: the prefix is added
        # when it is included, but the order is fixed here, at declaration.
        # GET only — `DELETE /{agent_id}` is declared early and is irrelevant,
        # since a method mismatch does not capture the request.
        paths = [
            getattr(route, "path", "")
            for route in agents_router.routes
            if "GET" in getattr(route, "methods", set())
        ]
        memberships = paths.index("/memberships")
        catch_all = paths.index("/{agent_id}")
        assert memberships < catch_all, (
            "/agents/memberships is declared after /agents/{agent_id} and will "
            "never be matched"
        )
