"""Controller-backed agents, seen and served by every switch-core process.

Two processes on one database, each with its own presence, its own management
and a signal bus listening on the real `NOTIFY` channel. A controller's socket
is held by one of them; the other must read its agents as live, keep the same
bindings, let the socket attach after an open it did not handle, and close its
own copy when the controller is taken over elsewhere.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.connection_rows import SharedConnections
from switch_core.bridges.agent.protocol.presence import agents_present_in
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID, AgentController, SwitchCoreProcess
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.process_lease import LEASE_TTL
from switch_core.user_changes import MACHINE, UserChange
from tests.db_buffer import say
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    add_room,
    attach,
    beat,
    build_harness,
    connect,
    cookies_for,
    enroll_console,
    open_connection,
    open_stream,
    place_agent,
    take,
)

SessionFactory = async_sessionmaker[AsyncSession]

WAIT_SECONDS = 10.0


async def _eventually(check: Callable[[], bool]) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("the other process never caught up")
        await asyncio.sleep(0.02)


async def _ask(harness: Harness, agent_id: str, room_id: str, body: str) -> int:
    """An addressed message to the agent, queued for it. Returns its seq."""
    row = await say(
        harness.session_factory, room_id, body, sender="@ada:test", sender_name="Ada"
    )
    return await harness.protocol.event_buffer.enqueue(
        TENANT_ZERO_ID,
        agent_id,
        room_id,
        AgentEvent(
            type="message",
            room_id=room_id,
            payload=MessagePayload(
                addressed=True,
                sender="@ada:test",
                sender_name="Ada",
                message_id=row.transport_event_id,
                body=body,
                timestamp=0,
            ),
        ),
        room_seq=row.seq,
        message_key=row.transport_event_id,
    )


async def _until(stream: Any, event: str) -> dict[str, Any]:
    """The data of the next frame of this kind, skipping the others."""
    while True:
        ((name, data),) = await take(stream, 1)
        if name == event:
            return dict(data)


@pytest.fixture
async def processes(
    postgres_url: str, session_factory: SessionFactory
) -> AsyncIterator[tuple[Harness, Harness]]:
    harnesses = [
        build_harness(
            session_factory,
            signal_engine=lambda: create_async_engine(postgres_url, poolclass=NullPool),
        )
        for _ in range(2)
    ]
    shared: list[SharedConnections] = []
    for harness in harnesses:
        shared.append(
            SharedConnections(
                registry=harness.protocol.connections,
                session_factory=session_factory,
                store=AgentConnectionStore(),
                bus=harness.bus,
                lease=harness.management.lease,
            )
        )
        await harness.management.lease.renew()
    for harness in harnesses:
        await harness.bus.start()
    for harness in harnesses:
        await asyncio.wait_for(harness.bus.connected.wait(), WAIT_SECONDS)
    ledgers = [
        asyncio.create_task(harness.management.run()) for harness in harnesses
    ] + [asyncio.create_task(process.run()) for process in shared]
    try:
        yield harnesses[0], harnesses[1]
    finally:
        # The buses first, so no signal starts work after the processes
        # stopped running; then the runs, which wait for the work they started.
        for harness in harnesses:
            await harness.bus.stop()
        for task in ledgers:
            task.cancel()
        await asyncio.gather(*ledgers, return_exceptions=True)


class TestBindings:
    async def test_an_agent_placed_through_one_process_is_bound_in_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")

            await _eventually(
                lambda: there.protocol.connections.controllers.is_bound(agent_id)
            )
            binding = there.protocol.connections.controllers.binding(agent_id)
            assert binding is not None
            assert binding.controller_id == controller.controller_id

            removed = await client.delete(
                f"/gateway/management/agents/{agent_id}",
                cookies=cookies_for(owner),
            )
            assert removed.status_code == 200, removed.text

        await _eventually(
            lambda: not there.protocol.connections.controllers.is_bound(agent_id)
        )


class TestPresence:
    async def test_a_managed_agent_connected_to_one_process_reads_live_from_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(here.session_factory, agent_id)
            await connect(client, controller)

        presence = there.protocol.connections.controllers
        await _eventually(lambda: presence.is_live(agent_id))
        await _eventually(lambda: presence.live_in_room(agent_id, room_id))
        assert agents_present_in([agent_id], room_id, there.protocol.connections) == {
            agent_id
        }
        assert agent_id in there.protocol.connections.live_agent_ids()
        # The process holding the socket is the one that reports it.
        assert presence.live_connection_count() == 0
        assert there.protocol.connections.live_agents_by_transport() == {}

    async def test_an_agent_bound_to_a_controller_held_elsewhere_is_in_its_rooms(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        """The binding reaches the other process after the controller's
        socket did, and the agent is present in its rooms there at once."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        presence = there.protocol.connections.controllers
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await _eventually(lambda: presence.is_live(agent_id))
            room_id = await add_room(here.session_factory, agent_id)
            for state in ("stopped", "running"):
                changed = await client.patch(
                    f"/gateway/management/agents/{agent_id}",
                    json={"desired_state": state},
                    cookies=cookies_for(owner),
                )
                assert changed.status_code == 200, changed.text
                await _eventually(
                    lambda state=state: (
                        presence.is_live(agent_id) == (state == "running")
                    )
                )

        await _eventually(lambda: presence.live_in_room(agent_id, room_id))

    async def test_the_socket_going_is_seen_by_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        presence = there.protocol.connections.controllers
        await _eventually(lambda: presence.is_live(agent_id))

        held = here.protocol.connections.controllers
        conn = held.current_connection(controller.controller_id)
        assert conn is not None
        held.detach_stream(conn, conn.stream_token)

        await _eventually(lambda: not presence.is_live(agent_id))

    async def test_a_dead_holder_stops_counting_on_the_next_pass(
        self, processes: tuple[Harness, Harness], session_factory: SessionFactory
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        presence = there.protocol.connections.controllers
        await _eventually(lambda: presence.is_live(agent_id))
        async with session_factory() as session:
            await session.execute(
                update(SwitchCoreProcess)
                .where(SwitchCoreProcess.id == here.management.lease.process_id)
                .values(
                    beat_at=SwitchCoreProcess.beat_at - LEASE_TTL - timedelta(seconds=1)
                )
            )
            await session.commit()

        await there.management.service.signals.read_connections()

        assert not presence.is_live(agent_id)

    async def test_a_session_command_reaches_the_controller_on_the_other_process(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        await _eventually(
            lambda: there.protocol.connections.controllers.is_live(agent_id)
        )
        frame = {"command": "interrupt", "origin": {"roomId": "room"}}

        assert there.protocol.connections.relay_session_command(agent_id, frame)

        conn = here.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert conn is not None
        await _eventually(lambda: conn.session_commands == [(agent_id, frame)])

    async def test_a_warm_reaches_the_controller_on_the_other_process(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await connect(client, controller)
        await _eventually(
            lambda: there.protocol.connections.controllers.is_live(agent_id)
        )

        assert there.protocol.connections.relay_warm(agent_id, "room")

        conn = here.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert conn is not None
        await _eventually(lambda: conn.warms == {(agent_id, "room")})


class TestTheConnectionOnAnyProcess:
    async def test_the_socket_attaches_through_the_process_that_did_not_open_it(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            opened = await open_connection(client, controller)

        stream = await open_stream(there, controller, opened)
        ((name, state),) = await take(stream, 1)
        await stream.aclose()  # type: ignore[attr-defined]

        assert name == "connection_state"
        assert state["connection_id"] == opened["connection_id"]
        assert state["generation"] == opened["generation"]
        adopted = there.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert adopted is not None
        assert adopted.id == opened["connection_id"]
        # The process that opened it lets its copy go once told.
        await _eventually(
            lambda: (
                here.protocol.connections.controllers.current_connection(
                    controller.controller_id
                )
                is None
            )
        )

    async def test_a_socket_reattaching_through_the_other_process_resumes_there(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        """The socket dropped and came back through the other process: the
        connection is taken up there, each agent resuming where the beats had
        confirmed it, which were written when the socket went."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        held = here.protocol.connections.controllers
        conn = held.current_connection(controller.controller_id)
        assert conn is not None
        held.resume_from(conn, agent_id, 42)
        held.detach_stream(conn, conn.stream_token)
        await here.management.ledger.flush_all()

        stream = await open_stream(
            there,
            controller,
            {"connection_id": conn.id, "generation": conn.generation},
        )
        await take(stream, 1)
        await stream.aclose()  # type: ignore[attr-defined]

        adopted = there.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert adopted is not None
        assert adopted.id == conn.id
        assert adopted.resume_cursors[agent_id] == 42

    async def test_a_reattach_after_its_holder_died_opens_again_from_its_cursors(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        """The process holding the socket dies having written nothing since
        the open, so the row's cursors are the open's: the agent was placed
        after it and its first event confirmed only by a beat there. Taking
        the connection up elsewhere would resume past what came next; the
        controller is told to open again, and resumes from its own cursor."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        room_id = await add_room(here.session_factory, agent_id)
        conn = here.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert conn is not None
        opened = {"connection_id": conn.id, "generation": conn.generation}
        stream = await open_stream(here, controller, opened)
        await _until(stream, "agent.attached")
        first = await _ask(here, agent_id, room_id, "one")
        assert (await _until(stream, "agent.event"))["seq"] == first
        confirmed = await beat(
            here,
            controller,
            connection_id=conn.id,
            generation=conn.generation,
            cursors={agent_id: first},
        )
        assert confirmed.status_code == 200, confirmed.text
        await here.management.ledger.flush_all()
        # `here` dies now, writing nothing more; then the next event.
        second = await _ask(here, agent_id, room_id, "two")

        refused = await attach(
            there, controller, opened["connection_id"], opened["generation"]
        )
        assert refused.status_code == 404, refused.text
        async with there.client() as elsewhere:
            reopened = await open_connection(
                elsewhere, controller, cursors={agent_id: first}
            )
        resumed = await open_stream(there, controller, reopened)
        attached = await _until(resumed, "agent.attached")
        event = await _until(resumed, "agent.event")
        await resumed.aclose()  # type: ignore[attr-defined]
        await stream.aclose()  # type: ignore[attr-defined]

        assert attached["from_seq"] == first
        assert event["seq"] == second

    async def test_an_attach_naming_another_generation_is_still_refused(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            opened = await open_connection(client, controller)

        with pytest.raises(Exception) as refused:
            await open_stream(
                there,
                controller,
                {
                    "connection_id": opened["connection_id"],
                    "generation": opened["generation"] + 1,
                },
            )

        assert getattr(refused.value, "status_code", None) == 404
        assert (
            there.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            is None
        )

    async def test_opening_through_the_other_process_takes_the_connection_over(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            await connect(client, controller)
        loser = here.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert loser is not None

        async with there.client() as elsewhere:
            await open_connection(elsewhere, controller)

        await _eventually(lambda: loser.closure is not None)
        assert loser.closure is not None
        assert loser.closure.code == "taken_over"
        assert (
            here.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            is None
        )


class TestTakenOverOnlyByANewerConnection:
    """`taken_over` is terminal for a controller: it exits and nothing
    restarts it. So it is the answer only for a connection older than the one
    the controller's row names, never for the current one reaching a process
    whose memory of it is a moment old."""

    async def test_a_reattach_through_the_opener_after_the_other_held_it(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            opened = await open_connection(client, controller)
        stream = await open_stream(there, controller, opened)
        await take(stream, 1)
        presence = here.protocol.connections.controllers
        await _eventually(
            lambda: presence.current_connection(controller.controller_id) is None
        )
        await stream.aclose()  # type: ignore[attr-defined]  # the socket drops
        await there.management.ledger.flush_all()

        answer = await attach(
            here, controller, opened["connection_id"], opened["generation"]
        )

        assert answer.status_code == 200, answer.text
        held = presence.current_connection(controller.controller_id)
        assert held is not None
        assert held.id == opened["connection_id"]
        await _eventually(
            lambda: (
                there.protocol.connections.controllers.current_connection(
                    controller.controller_id
                )
                is None
            )
        )

    async def test_a_reattach_through_the_opener_before_it_heard_of_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        """The opener has not yet read that the other process took the
        connection up when the socket comes back through it; reading that
        later must not close the connection the socket is on."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            opened = await open_connection(client, controller)
        await here.bus.stop()  # `here` hears nothing from `there`
        stream = await open_stream(there, controller, opened)
        await take(stream, 1)
        await stream.aclose()  # type: ignore[attr-defined]  # the socket drops
        await there.management.ledger.flush_all()

        answer = await attach(
            here, controller, opened["connection_id"], opened["generation"]
        )
        assert answer.status_code == 200, answer.text
        presence = here.protocol.connections.controllers
        held = presence.current_connection(controller.controller_id)
        assert held is not None
        await here.management.service.signals._read_connection(
            TENANT_ZERO_ID, controller.controller_id
        )

        assert held.closure is None
        assert presence.current_connection(controller.controller_id) is held

    async def test_a_read_of_the_row_during_an_open_leaves_the_new_connection(
        self,
        processes: tuple[Harness, Harness],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """One process is enough: a re-check of the controller's row runs
        while the open is being recorded."""
        here, _ = processes
        owner = await add_member(here.session_factory, "ada")
        service = here.management.service
        store = service.controllers
        record_opened = store.record_opened

        async def with_a_read_alongside(
            session: AsyncSession, tenant_id: str, controller_id: str, **kwargs: Any
        ) -> None:
            await service.signals._read_connection(tenant_id, controller_id)
            await record_opened(session, tenant_id, controller_id, **kwargs)

        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            await connect(client, controller)
            monkeypatch.setattr(store, "record_opened", with_a_read_alongside)
            second = await open_connection(client, controller)

        answer = await attach(
            here, controller, second["connection_id"], second["generation"]
        )
        assert answer.status_code == 200, answer.text

    async def test_a_connection_the_controller_replaced_is_still_taken_over(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            first = await open_connection(client, controller)
        async with there.client() as elsewhere:
            await open_connection(elsewhere, controller)
        presence = here.protocol.connections.controllers
        await _eventually(
            lambda: presence.current_connection(controller.controller_id) is None
        )

        answer = await attach(
            here, controller, first["connection_id"], first["generation"]
        )

        assert answer.status_code == 409
        assert answer.json()["error"]["code"] == "taken_over"


async def _controller_row(harness: Harness, controller_id: str) -> AgentController:
    async with harness.session_factory() as session:
        row = await session.scalar(
            select(AgentController).where(AgentController.id == controller_id)
        )
    assert row is not None
    return row


class TestTheRowNamesTheConnectionOpenedLast:
    """A socket attaching is written as connected only on the connection the
    controller opened last, held by the process writing it: a socket on an
    earlier one must not be written over the later one, whichever lands
    first."""

    async def test_a_late_connected_write_leaves_the_newer_connection_standing(
        self,
        processes: tuple[Harness, Harness],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The first connection's socket attached here, and its write is
        still on its way when the controller opens a second connection through
        the other process and that socket attaches there."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            await open_connection(client, controller)
        store = here.management.service.controllers
        record_connected = store.record_connected
        writing = asyncio.Event()
        written = asyncio.Event()

        async def held_back(
            session: AsyncSession, tenant_id: str, controller_id: str, **kwargs: Any
        ) -> bool:
            writing.set()
            await written.wait()
            return await record_connected(session, tenant_id, controller_id, **kwargs)

        monkeypatch.setattr(store, "record_connected", held_back)
        presence = here.protocol.connections.controllers
        first = presence.current_connection(controller.controller_id)
        assert first is not None
        presence.attach_stream(first)
        await asyncio.wait_for(writing.wait(), WAIT_SECONDS)

        async with there.client() as elsewhere:
            second = await open_connection(elsewhere, controller)
        stream = await open_stream(there, controller, second)
        await take(stream, 1)
        await there.management.ledger.flush_all()
        written.set()
        await here.management.ledger.flush_all()
        await stream.aclose()  # type: ignore[attr-defined]

        row = await _controller_row(here, controller.controller_id)
        assert row.connection_id == second["connection_id"]
        assert row.connection_process_id == there.management.lease.process_id
        assert row.disconnected_at is None

    async def test_an_attach_overtaken_while_it_read_the_row_is_refused(
        self,
        processes: tuple[Harness, Harness],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The controller opens a second connection through the other process,
        whose socket attaches there, while an attach of the first through this
        process is between reading the row and attaching: it is refused as
        taken over, and this process still knows the other holds the socket."""
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            first = await open_connection(client, controller)
        service = here.management.service
        connection_state = service.connection_state

        async def overtaken(session: AsyncSession, principal: Any) -> dict[str, Any]:
            async with there.client() as elsewhere:
                await open_connection(elsewhere, controller)
            other = there.protocol.connections.controllers
            second = other.current_connection(controller.controller_id)
            assert second is not None
            other.attach_stream(second)
            await there.management.ledger.flush_all()
            await service.signals._read_connection(
                TENANT_ZERO_ID, controller.controller_id
            )
            return await connection_state(session, principal)

        monkeypatch.setattr(service, "connection_state", overtaken)

        answer = await attach(
            here, controller, first["connection_id"], first["generation"]
        )

        assert answer.status_code == 409, answer.text
        assert answer.json()["error"]["code"] == "taken_over"
        assert (
            here.protocol.connections.controllers.holder_elsewhere(
                controller.controller_id
            )
            == there.management.lease.process_id
        )


class TestOwnerNotices:
    """A machine's owner hears that it changed, on whichever process holds
    their Console's socket."""

    async def _heard(self, subscription: Any, change: UserChange) -> None:
        heard: list[UserChange] = []

        def check() -> bool:
            heard.extend(subscription.drain())
            return change in heard

        await _eventually(check)

    async def test_enrolling_through_one_process_tells_the_owner_on_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        subscription = there.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
        await self._heard(subscription, UserChange(MACHINE, controller.controller_id))

    async def test_a_socket_attaching_and_going_tell_the_owner_on_the_other(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        subscription = there.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            machine = UserChange(MACHINE, controller.controller_id)
            await self._heard(subscription, machine)

            await connect(client, controller)
            await self._heard(subscription, machine)

        held = here.protocol.connections.controllers
        conn = held.current_connection(controller.controller_id)
        assert conn is not None
        held.detach_stream(conn, conn.stream_token)
        await here.management.ledger.flush_all()
        await self._heard(subscription, machine)

    async def test_nobody_else_hears_of_it(
        self, processes: tuple[Harness, Harness]
    ) -> None:
        here, there = processes
        owner = await add_member(here.session_factory, "ada")
        other = await add_member(here.session_factory, "bob")
        theirs = there.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
        bystander = there.user_changes.subscribe(TENANT_ZERO_ID, other.id)
        async with here.client() as client:
            controller = await enroll_console(here, client, owner)
            await connect(client, controller)
        await self._heard(theirs, UserChange(MACHINE, controller.controller_id))
        assert bystander.drain() == []
