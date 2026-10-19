"""How many pool connections routing one room message costs.

A room used to fan every message out to all of its agent clients at once,
each taking a pool slot to decide it and another to store what it decided,
so the cost of one message was multiplied by the size of the room before it
ever reached the pool: a ten-agent room turned one Slack message into eleven
checkouts, the burst that pushed the pool to its ceiling.

The router decides in the writer's own session, so the contract is one
connection for writing a message, whatever the room holds, and never two at
once. The replies a message owes are posted once its connection is back in
the pool; the read an offline notice needs takes a connection of its own and
gives it back before the notice is posted, because posting is a write that
can wait, and a slot held across it sits idle in a transaction.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, Client, Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.recipient import AgentRecipient
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)
from tests.switch_core.pool_checkouts import PoolCheckouts


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    names: list[str],
    addressing_policy: dict[str, Any] | None = None,
) -> tuple[Process, Room, Client, dict[str, tuple[Agent, Client]]]:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    louisa = await make_person(session_factory, "louisa")
    await add_member(session_factory, room, louisa)
    agents = {}
    for name in names:
        agent, client = await make_agent(
            session_factory,
            name,
            connection_model="session_addressable",
            addressing_policy=addressing_policy,
        )
        await add_member(session_factory, room, client, agent=agent)
        agents[name] = (agent, client)
    # The steady state: louisa's transport has written here before, so it
    # knows the room and needs no read of its own to find it.
    await process.say(room, "hello", sender=louisa)
    return process, room, louisa, agents


@pytest.fixture
def posted(
    monkeypatch: pytest.MonkeyPatch, session_factory: async_sessionmaker[AsyncSession]
) -> list[int]:
    """How many pool connections were checked out as each reply was posted,
    across the whole pool: nothing else is running in the test, so anything
    held then is held by the work posting the reply."""
    pool = session_factory.kw["bind"].sync_engine.pool
    held: list[int] = []
    real = AgentRecipient._post_auto_reply

    async def recording(self: AgentRecipient, *args: Any, **kwargs: Any) -> None:
        held.append(pool.checkedout())
        await real(self, *args, **kwargs)

    monkeypatch.setattr(AgentRecipient, "_post_auto_reply", recording)
    return held


class TestWritingAMessage:
    async def test_chatter_with_no_at_costs_the_write_alone(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        # The common case in a busy room: no `@`, so there is nothing an alias
        # or a role lease could match. It addresses nobody, so it is the room's
        # conversation, read from the room's log, and nothing is stored.
        process, room, louisa, agents = await _seed(session_factory, names=["member"])

        with pool_checkouts.scope("say") as scope:
            await process.say(room, "just talking amongst ourselves", sender=louisa)

        assert (scope.taken, scope.peak) == (1, 1)
        assert await own_events(session_factory, agents["member"][0].id) == []

    async def test_an_at_message_for_somebody_else_costs_the_write_alone(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        # Was a lookup of its own per agent: the room alias and the role lease
        # are read once, in the writer's session, for every agent at once.
        process, room, louisa, _ = await _seed(
            session_factory, names=["member", "other"]
        )

        with pool_checkouts.scope("say") as scope:
            await process.say(room, "@other can you look at this", sender=louisa)

        assert (scope.taken, scope.peak) == (1, 1)

    async def test_being_addressed_and_offline_costs_the_write_alone(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
        posted: list[int],
    ) -> None:
        # The expensive path: addressing policy, liveness, and the whole
        # offline-reply derivation. The decision and the stored event ride the
        # write; the offline notice is composed and posted after it.
        process, room, louisa, agents = await _seed(session_factory, names=["member"])

        with pool_checkouts.scope("say") as scope:
            await process.say(room, "@member can you look at this", sender=louisa)
        await process.idle()

        assert (scope.taken, scope.peak) == (1, 1)
        assert len(await own_events(session_factory, agents["member"][0].id)) == 1
        assert len(posted) == 1

    async def test_no_session_is_open_while_the_auto_reply_is_posted(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        posted: list[int],
    ) -> None:
        # Posting is an unbounded wait as far as the pool is concerned; doing
        # it inside a transaction is how a slot ends up idle in it for seconds.
        process, room, louisa, _ = await _seed(session_factory, names=["member"])

        await process.say(room, "@member you there?", sender=louisa)
        await process.idle()

        assert posted == [0]

    async def test_a_restricted_agent_refusing_a_sender_costs_the_write_alone(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
        posted: list[int],
    ) -> None:
        process, room, louisa, agents = await _seed(
            session_factory,
            names=["member"],
            addressing_policy={"rules": [{"agents": ["nobody"], "users": []}]},
        )

        with pool_checkouts.scope("say") as scope:
            await process.say(room, "@member you there?", sender=louisa)
        await process.idle()

        # The refusal leaves the message as chatter, so nothing is stored.
        assert (scope.taken, scope.peak) == (1, 1)
        assert await own_events(session_factory, agents["member"][0].id) == []
        assert posted == [0]

    async def test_an_alias_tag_costs_the_write_alone(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
        posted: list[int],
    ) -> None:
        # Reached only after the name misses, so this is the path where alias
        # and role used to be separate checkouts.
        process, room, louisa, agents = await _seed(session_factory, names=["member"])
        async with session_factory() as session:
            await RoomStore().set_alias(
                session, room.id, agents["member"][0].id, "fixer"
            )
            await session.commit()

        with pool_checkouts.scope("say") as scope:
            await process.say(room, "@fixer please look", sender=louisa)
        await process.idle()

        assert (scope.taken, scope.peak) == (1, 1)
        assert len(await own_events(session_factory, agents["member"][0].id)) == 1
        assert len(posted) == 1

    async def test_a_ten_agent_room_costs_the_write_alone(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        # The burst, end to end. One message to a room of ten agents: one
        # connection, where it used to be one per agent plus the addressed
        # agent's own write.
        names = [f"a{i}" for i in range(10)]
        process, room, louisa, agents = await _seed(session_factory, names=names)

        with pool_checkouts.scope("say") as scope:
            await process.say(room, "@a3 can you take this", sender=louisa)

        assert (scope.taken, scope.peak) == (1, 1)
        assert len(await own_events(session_factory, agents["a3"][0].id)) == 1
