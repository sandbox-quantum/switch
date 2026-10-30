"""The router decides each room row once, as it is written.

What these pin, each the reason the router exists:

- **Once, on the process that wrote the row.** Two processes share one
  database; a row written through one is decided by it alone: one own event
  per agent, one offline notice, one refusal, one command answer, one
  greeting. The other process does no work for it.
- **Atomic.** A row and the own events decided for it commit together: a
  transaction that rolls back leaves neither.
- **One agent's failure is that agent's.** Storing one agent's event runs in a
  savepoint of its own, so an error there costs that agent the event and
  nothing more: the row is written and the other agents get theirs.
- **No deadlock.** Agents' rows in `agent_event_heads` are locked in the order
  of their ids, whatever order a message names them in.
- **A cost that does not grow with the room.** Deciding a message reads the
  same few things whether the room holds one agent or many; what grows is one
  write per agent the message is for.
- **A post given up on is decided once** by whichever process's sweep claims
  it first.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentEventHead,
    AgentEventRow,
    Client,
    Message,
    PendingAttachmentGroup,
    Room,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery import router as router_module
from switch_core.delivery.addressing import ADDRESSING_DENIED_MESSAGE
from switch_core.delivery.router import MessageRouter
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.transport.postgres import new_event_id
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
    said_by,
)
from tests.switch_core.statement_counts import StatementCounts

SessionFactory = async_sessionmaker[AsyncSession]

_RESTRICTED = {"rules": [{"agents": ["nobody"], "users": []}]}


def _go_live(process: Process, agent_id: str) -> None:
    """A connection for the agent in this process, so it reads as online."""
    process.connections.open(
        agent_id=agent_id,
        connection_id=f"conn-{agent_id}",
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


def _never_routes(monkeypatch: pytest.MonkeyPatch, router: MessageRouter) -> list[str]:
    """Record every row `router` is asked to route or flush, by method."""
    asked: list[str] = []
    for name in ("store", "remove", "flush_due_groups", "after_commit"):
        real = getattr(router, name)

        def recording(
            *args: Any, _real: Any = real, _name: str = name, **kw: Any
        ) -> Any:
            asked.append(_name)
            return _real(*args, **kw)

        monkeypatch.setattr(router, name, recording)
    return asked


async def _messages(session_factory: SessionFactory, room: Room) -> list[Message]:
    async with tenant_session(session_factory, room.tenant_id) as session:
        return list(
            (
                await session.scalars(
                    select(Message)
                    .where(Message.room_id == room.id)
                    .order_by(Message.seq)
                )
            ).all()
        )


class TestTwoProcesses:
    async def test_a_message_is_routed_once_by_the_process_that_wrote_it(
        self, monkeypatch: pytest.MonkeyPatch, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        there = process_on(session_factory)
        asked_there = _never_routes(monkeypatch, there.router)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        offline, offline_client = await make_agent(
            session_factory, "offline", connection_model="session_passive"
        )
        strict, strict_client = await make_agent(
            session_factory, "strict", addressing_policy=_RESTRICTED
        )
        for agent, client in [(offline, offline_client), (strict, strict_client)]:
            await add_member(session_factory, room, client, agent=agent)
        await add_member(session_factory, room, alice)

        await here.say(room, "@offline @strict can you both look", sender=alice)
        await here.idle()
        await there.idle()

        # One own event for the agent the message reached, none for the one
        # whose policy refused the sender.
        assert len(await own_events(session_factory, offline.id)) == 1
        assert await own_events(session_factory, strict.id) == []
        # One offline notice, and one refusal.
        notices = await said_by(session_factory, room, offline_client)
        refusals = await said_by(session_factory, room, strict_client)
        assert len(notices) == 1, [n.body for n in notices]
        assert len(refusals) == 1, [r.body for r in refusals]
        assert ADDRESSING_DENIED_MESSAGE in (refusals[0].body or "")
        # The other process was asked nothing.
        assert asked_there == []

    async def test_a_command_is_answered_once(
        self, monkeypatch: pytest.MonkeyPatch, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        there = process_on(session_factory)
        asked_there = _never_routes(monkeypatch, there.router)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        greeter, greeter_client = await make_agent(session_factory, "greeter")
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, greeter_client, agent=greeter)

        await here.command(room, "agents-greet", "", sender=alice)
        await here.idle()
        await there.idle()

        answers = await said_by(session_factory, room, greeter_client)
        assert len(answers) == 1, [a.body for a in answers]
        assert "@greeter" in (answers[0].body or "")
        assert asked_there == []

    async def test_an_arrival_is_greeted_once(
        self, monkeypatch: pytest.MonkeyPatch, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        there = process_on(session_factory)
        asked_there = _never_routes(monkeypatch, there.router)
        room = await make_room(session_factory)
        newcomer, newcomer_client = await make_agent(session_factory, "newcomer")

        await here.provisioning.invite_to_room(
            room.transport_room_id, newcomer_client.transport_user_id
        )
        # A second invitation finds the membership and writes nothing.
        await here.provisioning.invite_to_room(
            room.transport_room_id, newcomer_client.transport_user_id
        )
        await here.idle()
        await there.idle()

        greetings = await said_by(session_factory, room, newcomer_client)
        assert len(greetings) == 1
        assert "@newcomer" in (greetings[0].body or "")
        assert asked_there == []

    async def test_a_removal_written_by_one_process_is_let_go_of_in_the_other(
        self, session_factory: SessionFactory
    ) -> None:
        """The removal's own events go once, with the membership; what the
        other process holds in memory for the agent (its connections' claim on
        the room) it lets go of when it hears the membership changed."""
        here = process_on(session_factory)
        there = process_on(session_factory)
        room = await make_room(session_factory)
        agent, client = await make_agent(session_factory, "leaver")
        await add_member(session_factory, room, client, agent=agent)
        conn = there.connections.open(
            agent_id=agent.id,
            connection_id="held-there",
            scope="single",
            delivery_filter="all",
            spawn_capable=False,
            position={OWN_EVENTS: 0},
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
            expected_generation=None,
        )
        there.connections.claim_room(conn, room.id)

        await here.provisioning.kick_user(
            room.transport_room_id, client.transport_user_id
        )
        assert conn.rooms == {room.id}, "the other process is told by a signal"
        await there.router.membership_changed((room.tenant_id, client.id, room.id))

        assert conn.rooms == set()

    async def test_a_membership_signal_for_a_room_still_held_changes_nothing(
        self, session_factory: SessionFactory
    ) -> None:
        there = process_on(session_factory)
        room = await make_room(session_factory)
        agent, client = await make_agent(session_factory, "stayer")
        await add_member(session_factory, room, client, agent=agent)
        conn = there.connections.open(
            agent_id=agent.id,
            connection_id="held",
            scope="single",
            delivery_filter="all",
            spawn_capable=False,
            position={OWN_EVENTS: 0},
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
            expected_generation=None,
        )
        there.connections.claim_room(conn, room.id)

        await there.router.membership_changed((room.tenant_id, client.id, room.id))

        assert conn.rooms == {room.id}

    async def test_a_controller_streaming_from_the_other_process_hears_of_a_join(
        self, session_factory: SessionFactory
    ) -> None:
        """A managed agent's controller streams from one process; the agent
        is added to a room through another. The controller's room set, kept
        in the memory of the process it streams from, grows when that process
        hears the membership changed, and again on a re-check if it never
        did."""
        here = process_on(session_factory)
        there = process_on(session_factory)
        first = await make_room(session_factory, "first")
        second = await make_room(session_factory, "second")
        third = await make_room(session_factory, "third")
        agent, client = await make_agent(session_factory, "managed")
        await add_member(session_factory, first, client, agent=agent)
        presence = there.connections.controllers
        presence.bind(
            Binding(
                agent_id=agent.id,
                controller_id="controller-1",
                tenant_id=TENANT_ZERO_ID,
                controller_name="machine",
                running=True,
            )
        )
        presence.set_rooms(agent.id, {first.id})

        await here.provisioning.invite_to_room(
            second.transport_room_id, client.transport_user_id
        )
        await there.router.membership_changed((TENANT_ZERO_ID, client.id, second.id))
        assert presence.rooms(agent.id) == {first.id, second.id}

        await add_member(session_factory, third, client, agent=agent)
        await there.router.recheck_agent_rooms(TENANT_ZERO_ID)
        assert presence.rooms(agent.id) == {first.id, second.id, third.id}

    async def test_a_missed_signal_is_made_up_by_the_recheck(
        self, session_factory: SessionFactory
    ) -> None:
        """A process that never heard a removal finds it on its next
        re-check: the claim on the room left goes, the one on the room kept
        stays."""
        there = process_on(session_factory)
        left = await make_room(session_factory, "left")
        kept = await make_room(session_factory, "kept")
        agent, client = await make_agent(session_factory, "agent")
        for room in (left, kept):
            await add_member(session_factory, room, client, agent=agent)
        held = []
        for room in (left, kept):
            conn = there.connections.open(
                agent_id=agent.id,
                connection_id=f"held-{room.name}",
                scope="single",
                delivery_filter="all",
                spawn_capable=False,
                position={OWN_EVENTS: 0},
                declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
                expected_generation=None,
            )
            there.connections.claim_room(conn, room.id)
            held.append(conn)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await RoomStore().remove_client(session, client.id, left.id)
            await session.commit()

        await there.router.recheck_agent_rooms(TENANT_ZERO_ID)

        assert [conn.rooms for conn in held] == [set(), {kept.id}]

    async def test_a_post_given_up_on_is_decided_once_by_two_sweeps(
        self, monkeypatch: pytest.MonkeyPatch, session_factory: SessionFactory
    ) -> None:
        """Both processes sweep at the same moment; the post is claimed by one
        of them and decided once."""
        # Long enough that the writer's own timer does not fire in the test.
        monkeypatch.setattr(router_module, "ATTACHMENT_GROUP_TIMEOUT_SECONDS", 60.0)
        here = process_on(session_factory)
        there = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        agent, client = await make_agent(session_factory, "agent-a")
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, client, agent=agent)
        group = "grp-two-sweeps"
        await here.send_file(
            room,
            "one.png",
            sender=alice,
            caption="@agent-a two of three",
            group={"id": group, "index": 0, "total": 3},
        )
        await here.send_file(
            room, "two.png", sender=alice, group={"id": group, "index": 1, "total": 3}
        )
        here.router.close()
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await session.execute(
                update(PendingAttachmentGroup).values(
                    deadline=PendingAttachmentGroup.deadline
                    - text("interval '2 minutes'")
                )
            )
            await session.commit()

        decided = await asyncio.gather(
            here.router.flush_due_groups(TENANT_ZERO_ID),
            there.router.flush_due_groups(TENANT_ZERO_ID),
        )
        await here.idle()
        await there.idle()

        assert sorted(decided) == [0, 1]
        [row] = await own_events(session_factory, agent.id)
        assert "incomplete attachment group: 2 of 3" in row.payload["payload"]["body"]


class TestAtomicity:
    async def test_a_rolled_back_row_leaves_no_own_event(
        self, session_factory: SessionFactory
    ) -> None:
        """What a process that stops before it commits leaves behind: nothing.
        The row is not written, so it was never decided either."""
        process = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        agent, client = await make_agent(
            session_factory, "fixer", connection_model="session_passive"
        )
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, client, agent=agent)

        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            routed = await process.router.store(
                session,
                tenant_id=TENANT_ZERO_ID,
                room_id=room.id,
                transport_room_id=room.transport_room_id,
                message=_message(room, alice, "@fixer are you there"),
                attachments=[],
            )
            # Decided and written, inside the transaction.
            assert (await session.scalars(select(AgentEventRow))).all() != []
            await session.rollback()
        await process.idle()

        assert await _messages(session_factory, room) == []
        assert await own_events(session_factory, agent.id) == []
        # Nor was anything owed posted: `committed()` is for a commit.
        assert await said_by(session_factory, room, client) == []
        assert routed.seq > 0


class TestFailuresStayWithTheAgent:
    async def test_one_agents_failure_costs_that_agent_alone(
        self, monkeypatch: pytest.MonkeyPatch, session_factory: SessionFactory
    ) -> None:
        """A database error while storing one agent's event is rolled back to
        that agent's savepoint: the message is written, the other agent gets
        its event, and the failure is counted."""
        process = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        broken, broken_client = await make_agent(session_factory, "broken")
        fine, fine_client = await make_agent(session_factory, "fine")
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, broken_client, agent=broken)
        await add_member(session_factory, room, fine_client, agent=fine)
        _go_live(process, broken.id)
        _go_live(process, fine.id)
        claim = EventBuffer._claim

        def failing_claim(self: EventBuffer, tenant_id: str, agent_id: str) -> Any:
            if agent_id == broken.id:
                return text("SELECT 1 / 0")
            return claim(self, tenant_id, agent_id)

        monkeypatch.setattr(EventBuffer, "_claim", failing_claim)
        registry = MetricsRegistry()
        install(registry)
        try:
            await process.say(room, "@broken @fine one for each", sender=alice)
            await process.idle()
            failures = next(
                p
                for p in registry.collect()
                if p.name == "switch.messages.routing_failures"
            )
        finally:
            uninstall()

        assert [m.body for m in await _messages(session_factory, room)] == [
            "@broken @fine one for each"
        ]
        assert await own_events(session_factory, broken.id) == []
        assert len(await own_events(session_factory, fine.id)) == 1
        assert failures.numbers[0].value == 1.0
        assert dict(failures.numbers[0].attributes) == {"stage": "store"}


class TestLockOrder:
    async def test_agents_are_locked_in_the_order_of_their_ids(
        self, postgres_schema: str, session_factory: SessionFactory
    ) -> None:
        """A message naming the later agent first still locks the earlier one
        first. While another transaction holds the later agent's row, the
        message's transaction holds the earlier agent's and waits; were the
        order the message's own, two messages naming the same two agents the
        other way round could each hold one row and wait for the other."""
        process = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        one, one_client = await make_agent(session_factory, "one")
        two, two_client = await make_agent(session_factory, "two")
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, one_client, agent=one)
        await add_member(session_factory, room, two_client, agent=two)
        _go_live(process, one.id)
        _go_live(process, two.id)
        first, second = sorted([one, two], key=lambda agent: agent.id)
        # Both have a numbering row, so locking it is visible to others.
        await process.say(room, f"@{first.name} @{second.name} warm up", sender=alice)
        await process.idle()

        engine = create_async_engine(postgres_schema, poolclass=NullPool)
        try:
            async with engine.connect() as holder:
                await holder.execute(text("BEGIN"))
                await holder.execute(
                    select(AgentEventHead.agent_id)
                    .where(AgentEventHead.agent_id == second.id)
                    .with_for_update()
                )
                writing = asyncio.create_task(
                    process.say(
                        room, f"@{second.name} then @{first.name}", sender=alice
                    )
                )
                await asyncio.sleep(0.5)
                assert not writing.done(), "the write did not wait for the lock"

                async with engine.connect() as prober:
                    await prober.execute(text("BEGIN"))
                    with pytest.raises(DBAPIError, match="could not obtain lock"):
                        await prober.execute(
                            select(AgentEventHead.agent_id)
                            .where(AgentEventHead.agent_id == first.id)
                            .with_for_update(nowait=True)
                        )
                    await prober.execute(text("ROLLBACK"))
                await holder.execute(text("ROLLBACK"))
            await writing
        finally:
            await engine.dispose()

        assert len(await own_events(session_factory, first.id)) == 2
        assert len(await own_events(session_factory, second.id)) == 2

    async def test_two_rooms_naming_the_same_two_agents_both_go_through(
        self, session_factory: SessionFactory
    ) -> None:
        """Many at once, each pair naming the agents in opposite orders from
        two rooms: none waits on another for good, and every own event is
        stored."""
        process = process_on(session_factory)
        rooms = [await make_room(session_factory, name) for name in ("left", "right")]
        alice = await make_person(session_factory, "alice")
        one, one_client = await make_agent(session_factory, "one")
        two, two_client = await make_agent(session_factory, "two")
        for room in rooms:
            await add_member(session_factory, room, alice)
            await add_member(session_factory, room, one_client, agent=one)
            await add_member(session_factory, room, two_client, agent=two)
        _go_live(process, one.id)
        _go_live(process, two.id)
        registry = MetricsRegistry()
        install(registry)
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *(
                        process.say(
                            rooms[n % 2],
                            "@one @two go" if n % 2 else "@two @one go",
                            sender=alice,
                        )
                        for n in range(20)
                    )
                ),
                timeout=30,
            )
            await process.idle()
            failures = [
                p
                for p in registry.collect()
                if p.name == "switch.messages.routing_failures"
            ]
        finally:
            uninstall()

        assert len(await own_events(session_factory, one.id)) == 20
        assert len(await own_events(session_factory, two.id)) == 20
        assert failures == []


class TestCost:
    @staticmethod
    async def _room_of(
        session_factory: SessionFactory, size: int
    ) -> tuple[Process, Room, Client, list[str]]:
        process = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        await add_member(session_factory, room, alice)
        names = []
        for n in range(size):
            name = f"a{n}-{uuid.uuid4().hex[:4]}"
            agent, client = await make_agent(session_factory, name)
            await add_member(session_factory, room, client, agent=agent)
            _go_live(process, agent.id)
            names.append(name)
        # The steady state: alice's transport knows the room already.
        await process.say(room, "hello", sender=alice)
        await process.idle()
        return process, room, alice, names

    @staticmethod
    def _kinds(statements: list[str]) -> dict[str, int]:
        kinds: dict[str, int] = {}
        for statement in statements:
            kind = statement.lstrip().split(None, 1)[0].upper()
            kinds[kind] = kinds.get(kind, 0) + 1
        return kinds

    @pytest.mark.parametrize("body", ["just chatting", "@{0} can you look"])
    async def test_reads_do_not_grow_with_the_room(
        self,
        body: str,
        session_factory: SessionFactory,
        statement_counts: StatementCounts,
    ) -> None:
        """The room, its agent members, and what the message asks of them
        (role leases, budgets) are each read once for the whole room. Two
        agents and twelve cost the same: with two, one is named and one is
        not, so every read the room can need is already made."""
        counted = []
        for size in (2, 12):
            process, room, alice, names = await self._room_of(session_factory, size)
            with statement_counts.scope(f"{size} agents") as scope:
                await process.say(room, body.format(names[0]), sender=alice)
            await process.idle()
            counted.append(self._kinds(scope.statements))

        small, large = counted
        assert small.get("SELECT") == large.get("SELECT"), (small, large)
        assert small == large

    @pytest.mark.parametrize("agents", [1, 2])
    async def test_a_direct_room_reads_no_agent_count_per_message(
        self,
        agents: int,
        session_factory: SessionFactory,
        statement_counts: StatementCounts,
    ) -> None:
        """Whether a direct room holds one agent rides on the room's own read,
        so every message there costs no query for the room's agents: one
        agent hears an unnamed message, two do not."""
        process = process_on(session_factory)
        room = await make_room(session_factory, channel_type="direct")
        alice = await make_person(session_factory, "alice")
        await add_member(session_factory, room, alice)
        ids = []
        for n in range(agents):
            agent, client = await make_agent(
                session_factory, f"d{n}-{uuid.uuid4().hex[:4]}"
            )
            await add_member(session_factory, room, client, agent=agent)
            _go_live(process, agent.id)
            ids.append(agent.id)
        await process.say(room, "hello", sender=alice)
        await process.idle()
        before = [len(await own_events(session_factory, i)) for i in ids]

        with statement_counts.scope("direct") as scope:
            await process.say(room, "just chatting", sender=alice)
        await process.idle()

        agent_reads = [
            s
            for s in (" ".join(st.split()) for st in scope.statements)
            if s.startswith("SELECT room_agents.agent_id FROM room_agents")
        ]
        assert agent_reads == []
        after = [len(await own_events(session_factory, i)) for i in ids]
        heard = 1 if agents == 1 else 0
        assert after == [b + heard for b in before]

    async def test_writes_grow_with_the_agents_a_message_is_for(
        self, session_factory: SessionFactory, statement_counts: StatementCounts
    ) -> None:
        """Naming every agent in the room: the reads are what they are for a
        room of one, and each agent named costs its own event's writes."""
        counted = []
        for size in (1, 6):
            process, room, alice, names = await self._room_of(session_factory, size)
            body = " ".join(f"@{name}" for name in names) + " all of you"
            with statement_counts.scope(f"{size} agents") as scope:
                await process.say(room, body, sender=alice)
            await process.idle()
            counted.append(self._kinds(scope.statements))

        small, large = counted
        assert small.get("SELECT") == large.get("SELECT"), (small, large)
        # One message, then per agent named: its number and its event, each
        # in a savepoint of its own.
        per_agent = {
            kind: (large.get(kind, 0) - small.get(kind, 0)) // 5
            for kind in ("INSERT", "SAVEPOINT", "RELEASE")
        }
        assert per_agent == {"INSERT": 2, "SAVEPOINT": 1, "RELEASE": 1}, (small, large)
        assert large.get("INSERT", 0) == 1 + 2 * 6


def _message(room: Room, sender: Client, body: str) -> Message:
    return Message(
        room_id=room.id,
        transport_event_id=new_event_id(),
        sender_id=sender.transport_user_id,
        sender_client_id=sender.id,
        sender_name=sender.display_name,
        event_type="m.room.message",
        msgtype="m.text",
        body=body,
        content={"body": body, "msgtype": "m.text"},
    )
