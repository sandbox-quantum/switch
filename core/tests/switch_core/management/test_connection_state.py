"""A machine's online state, read from its connection's recorded transitions
and the lease of the process holding it.

The process holding a controller's socket writes each transition once, the
socket attaching and the socket going (and why), to the controller's row, and
never a heartbeat. Each process also renews a lease. A machine is online
while its socket is attached and its holding process's lease is fresh: so it
is the same from every process, and turns offline within seconds of the
controller stopping, its socket dropping, or the process holding it dying.
Runs against the real database.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnection,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.db.models import AgentController, SwitchCoreProcess
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.switch_core_process_store import ProcessLeaseRow
from switch_core.management.connection_ledger import ControllerConnectionLedger
from switch_core.management.process_lease import LEASE_TTL, ProcessLeases
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    beat,
    build_harness,
    connect,
    cookies_for,
    create_managed_agent,
    enroll_console,
    open_connection,
    open_stream,
    place_agent,
    provider,
    report_status,
    report_status_only,
    take,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _row(harness: Harness, controller_id: str) -> AgentController:
    async with harness.session_factory() as session:
        result = await session.execute(
            select(AgentController).where(AgentController.id == controller_id)
        )
        return result.scalar_one()


async def _listed(
    client: httpx.AsyncClient, controller: EnrolledController
) -> dict[str, Any]:
    response = await client.get(
        "/gateway/management/controllers", cookies=cookies_for(controller.owner)
    )
    assert response.status_code == 200, response.text
    [entry] = [c for c in response.json() if c["id"] == controller.controller_id]
    return dict(entry)


async def _flush(harness: Harness) -> None:
    await harness.management.ledger.flush_all()


async def _age_lease(harness: Harness, seconds: float) -> None:
    """Set this harness's process's last renewal `seconds` in the past, as a
    process that stopped renewing would leave it."""
    async with harness.session_factory() as session:
        await session.execute(
            text(
                "UPDATE switch_core_processes "
                "SET beat_at = now() - make_interval(secs => :seconds) "
                "WHERE id = :id"
            ),
            {"seconds": seconds, "id": harness.management.lease.process_id},
        )
        await session.commit()


def _current(harness: Harness, controller: EnrolledController) -> ControllerConnection:
    conn = harness.protocol.connections.controllers.current_connection(
        controller.controller_id
    )
    assert conn is not None
    return conn


class _CountingStore(AgentControllerStore):
    """Counts the transitions written, and fails the first `failures`."""

    def __init__(self, failures: int = 0) -> None:
        self.failures = failures
        self.connected = 0
        self.disconnected = 0

    def _maybe_fail(self) -> None:
        if self.failures:
            self.failures -= 1
            raise ConnectionError("the database went away")

    async def record_connected(self, *args: Any, **kwargs: Any) -> str | None:
        self._maybe_fail()
        self.connected += 1
        return await super().record_connected(*args, **kwargs)

    async def record_disconnected(self, *args: Any, **kwargs: Any) -> str | None:
        self._maybe_fail()
        self.disconnected += 1
        return await super().record_disconnected(*args, **kwargs)


class TestLeases:
    """`ProcessLeases` alone: whether a process holds its sockets."""

    now = datetime(2026, 1, 1, tzinfo=UTC)

    def _leases(self, **rows: ProcessLeaseRow) -> ProcessLeases:
        return ProcessLeases(read_at=self.now, leases=rows)

    def test_a_fresh_lease_holds(self) -> None:
        leases = self._leases(p=ProcessLeaseRow(beat_at=self.now, stopped_at=None))
        assert leases.holds("p")

    def test_a_lease_older_than_the_ttl_does_not(self) -> None:
        beat_at = self.now - LEASE_TTL
        leases = self._leases(p=ProcessLeaseRow(beat_at=beat_at, stopped_at=None))
        assert not leases.holds("p")
        assert leases.ended("p") == (beat_at, "server_lost")

    def test_a_stopped_lease_does_not(self) -> None:
        stopped_at = self.now - timedelta(seconds=1)
        leases = self._leases(
            p=ProcessLeaseRow(beat_at=self.now, stopped_at=stopped_at)
        )
        assert not leases.holds("p")
        assert leases.ended("p") == (stopped_at, "server_shutdown")

    def test_a_missing_lease_does_not(self) -> None:
        leases = self._leases()
        assert not leases.holds("p")
        assert not leases.holds(None)
        assert leases.ended("p") == (None, "server_lost")


class TestTheMachineState:
    async def test_a_machine_that_never_connected_is_unknown(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status_only(client, controller, 1)
            listed = await _listed(client, controller)
        assert listed["state"] == "unknown"
        assert listed["connection"] is None
        assert listed["last_seen_at"] is not None

    async def test_an_open_connection_with_no_socket_is_not_online(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await harness.management.start()
            await open_connection(client, controller)
            await _flush(harness)
            listed = await _listed(client, controller)
        assert listed["state"] == "unknown"

    async def test_the_socket_attaching_is_online_and_going_is_offline_at_once(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            conn = _current(harness, controller)
            # The socket `place_agent` connected goes; a new one attaches.
            presence.detach_stream(conn, conn.stream_token)
            opened = {"connection_id": conn.id, "generation": conn.generation}
            stream = await open_stream(harness, controller, opened)
            await take(stream, 2)
            await _flush(harness)
            live = presence.is_live(agent_id)
            online = await _listed(client, controller)
            await stream.aclose()  # type: ignore[attr-defined]
            await _flush(harness)
            offline = await _listed(client, controller)
        row = await _row(harness, controller.controller_id)

        assert live
        assert online["state"] == "online"
        assert online["connection"]["disconnected_at"] is None
        assert online["connection"]["disconnect_reason"] is None
        assert not presence.is_live(agent_id)
        assert offline["state"] == "offline"
        assert offline["connection"]["disconnect_reason"] == "socket_closed"
        assert offline["connection"]["disconnected_at"] is not None
        assert row.connection_id == conn.id
        assert row.connection_process_id == harness.management.lease.process_id

    async def test_a_socket_reattaching_to_its_connection_is_online_again(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            conn = _current(harness, controller)
            presence.detach_stream(conn, conn.stream_token)
            await _flush(harness)
            dropped = await _listed(client, controller)
            presence.attach_stream(conn)
            await _flush(harness)
            back = await _listed(client, controller)
        assert dropped["state"] == "offline"
        assert back["state"] == "online"
        assert back["connection"]["disconnected_at"] is None

    async def test_each_transition_is_written_once_and_no_beat_is_written(
        self, harness: Harness
    ) -> None:
        store = _CountingStore()
        presence = harness.protocol.connections.controllers
        ledger = ControllerConnectionLedger(
            process_id=harness.management.lease.process_id,
            session_factory=harness.session_factory,
            controllers=store,
            clock=harness.clock,
            user_changes=harness.user_changes,
        )
        presence.use_ledger(ledger)
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
            conn = _current(harness, controller)
            presence.attach_stream(conn)
            await ledger.flush_all()
            for _ in range(20):
                answer = beat(
                    harness,
                    controller,
                    connection_id=opened["connection_id"],
                    generation=opened["generation"],
                    cursors={},
                )
                assert answer.status_code == 200, answer.text
            queued_by_beats = ledger.pending
            await ledger.flush_all()
            after_beats = (store.connected, store.disconnected)
            presence.detach_stream(conn, conn.stream_token)
            await ledger.flush_all()
            conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
            swept = presence.sweep()
            await ledger.flush_all()
        assert queued_by_beats == 0
        assert after_beats == (1, 0)
        assert swept == [conn]
        assert (store.connected, store.disconnected) == (1, 1)
        row = await _row(harness, controller.controller_id)
        assert row.disconnect_reason == "socket_closed"

    async def test_a_lapsed_heartbeat_is_recorded_by_the_sweep(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            online = await _listed(client, controller)
            conn = _current(harness, controller)
            conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
            presence.sweep()
            await _flush(harness)
            offline = await _listed(client, controller)
        assert online["state"] == "online"
        assert offline["state"] == "offline"
        assert offline["connection"]["disconnect_reason"] == "heartbeat_lapsed"

    async def test_a_socket_the_server_closes_as_it_shuts_down_says_so(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            presence.begin_shutdown()
            conn = _current(harness, controller)
            presence.detach_stream(conn, conn.stream_token)
            await _flush(harness)
            listed = await _listed(client, controller)
        assert listed["state"] == "offline"
        assert listed["connection"]["disconnect_reason"] == "server_shutdown"

    async def test_a_takeover_records_the_old_connection_taken_over(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            first = _current(harness, controller)
            await open_connection(client, controller)
            await _flush(harness)
            between = await _listed(client, controller)
            second = _current(harness, controller)
            presence.attach_stream(second)
            await _flush(harness)
            after = await _listed(client, controller)
        row = await _row(harness, controller.controller_id)
        assert between["state"] == "offline"
        assert between["connection"]["disconnect_reason"] == "taken_over"
        assert after["state"] == "online"
        assert row.connection_id == second.id != first.id

    async def test_a_revoked_machine_is_revoked_and_its_connection_closed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            await _flush(harness)
            listed = await _listed(client, controller)
        assert revoked.status_code == 200, revoked.text
        assert listed["state"] == "revoked"
        assert listed["connection"]["disconnect_reason"] == "revoked"

    async def test_placement_needs_the_machine_connected(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            conn = _current(harness, controller)
            presence.detach_stream(conn, conn.stream_token)
            await _flush(harness)
            refused = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert refused.status_code == 409, refused.text
        assert refused.json()["error"] == {
            "code": "controller_offline",
            "message": "Cannot place the agent: the controller is not connected "
            "to Switch.",
            "retryable": False,
        }


class TestTheProcessLease:
    async def test_a_lease_renewed_within_the_ttl_keeps_the_machine_online(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            await _age_lease(harness, LEASE_TTL.total_seconds() - 3)
            still_online = await _listed(client, controller)
            await _age_lease(harness, LEASE_TTL.total_seconds() + 1)
            lapsed = await _listed(client, controller)
            await harness.management.lease.renew()
            renewed = await _listed(client, controller)
        assert still_online["state"] == "online"
        assert lapsed["state"] == "offline"
        assert lapsed["connection"]["disconnect_reason"] == "server_lost"
        assert lapsed["connection"]["disconnected_at"] is not None
        assert renewed["state"] == "online"

    async def test_a_dead_processs_machines_read_offline_from_another(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The process holding the socket died: it wrote no closing, its lease
        stops being renewed, and every other process reads the machine
        offline, with nothing written per machine."""
        holder = build_harness(session_factory)
        other = build_harness(session_factory)
        owner = await add_member(session_factory, "ada")
        async with holder.client() as client, other.client() as elsewhere:
            controller = await enroll_console(holder, client, owner)
            await connect(client, controller)
            await other.management.start()
            online = await _listed(elsewhere, controller)
            await _age_lease(holder, LEASE_TTL.total_seconds() + 1)
            await other.management.lease.renew()
            offline = await _listed(elsewhere, controller)
            async with session_factory() as session:
                await session.execute(
                    SwitchCoreProcess.__table__.delete().where(
                        SwitchCoreProcess.id == holder.management.lease.process_id
                    )
                )
                await session.commit()
            pruned = await _listed(elsewhere, controller)
        row = await _row(holder, controller.controller_id)
        assert (
            other.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            is None
        )
        assert online["state"] == "online"
        assert offline["state"] == "offline"
        assert offline["connection"]["disconnect_reason"] == "server_lost"
        assert pruned["state"] == "offline"
        assert pruned["connection"] == {
            "connected_at": online["connection"]["connected_at"],
            "disconnected_at": None,
            "disconnect_reason": "server_lost",
        }
        assert row.disconnected_at is None

    async def test_a_process_that_stops_takes_its_machines_offline(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        holder = build_harness(session_factory)
        other = build_harness(session_factory)
        owner = await add_member(session_factory, "ada")
        async with holder.client() as client, other.client() as elsewhere:
            controller = await enroll_console(holder, client, owner)
            await connect(client, controller)
            await holder.management.stop()
            listed = await _listed(elsewhere, controller)
        assert listed["state"] == "offline"
        assert listed["connection"]["disconnect_reason"] == "server_shutdown"
        assert listed["connection"]["disconnected_at"] is not None

    async def test_long_dead_leases_are_pruned(self, harness: Harness) -> None:
        dead = str(uuid.uuid4())
        async with harness.session_factory() as session:
            session.add(
                SwitchCoreProcess(
                    id=dead,
                    started_at=datetime.now(UTC) - timedelta(hours=3),
                    beat_at=datetime.now(UTC) - timedelta(hours=2),
                )
            )
            await session.commit()
        await harness.management.lease.renew()
        async with harness.session_factory() as session:
            ids = set(
                (await session.execute(select(SwitchCoreProcess.id))).scalars().all()
            )
        assert dead not in ids
        assert harness.management.lease.process_id in ids


class TestTheLedger:
    async def test_a_late_closing_of_a_replaced_connection_leaves_the_new_one(
        self, harness: Harness
    ) -> None:
        """A process that held an earlier connection and only now records its
        socket going does not overwrite the connection recorded since."""
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            earlier = _current(harness, controller)
            await connect(client, controller)
            replacement = _current(harness, controller)
            elsewhere = ControllerConnectionLedger(
                process_id=str(uuid.uuid4()),
                session_factory=harness.session_factory,
                controllers=AgentControllerStore(),
                clock=harness.clock,
                user_changes=harness.user_changes,
            )
            elsewhere.disconnected(earlier, "heartbeat_lapsed")
            await elsewhere.flush_all()
            listed = await _listed(client, controller)
        row = await _row(harness, controller.controller_id)
        assert row.connection_id == replacement.id
        assert listed["state"] == "online"
        assert listed["connection"]["disconnect_reason"] is None

    async def test_only_the_latest_transition_of_a_controller_is_written(
        self, harness: Harness
    ) -> None:
        store = _CountingStore()
        ledger = ControllerConnectionLedger(
            process_id=harness.management.lease.process_id,
            session_factory=harness.session_factory,
            controllers=store,
            clock=harness.clock,
            user_changes=harness.user_changes,
        )
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            conn = _current(harness, controller)
        ledger.disconnected(conn, "socket_closed")
        ledger.connected(conn)
        await ledger.flush_all()
        row = await _row(harness, controller.controller_id)
        assert (store.connected, store.disconnected) == (1, 0)
        assert row.disconnected_at is None

    async def test_a_failed_write_is_kept_for_the_next_flush(
        self, harness: Harness
    ) -> None:
        store = _CountingStore(failures=1)
        ledger = ControllerConnectionLedger(
            process_id=harness.management.lease.process_id,
            session_factory=harness.session_factory,
            controllers=store,
            clock=harness.clock,
            user_changes=harness.user_changes,
        )
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await connect(client, controller)
            conn = _current(harness, controller)
        ledger.disconnected(conn, "heartbeat_lapsed")
        with pytest.raises(ConnectionError):
            await ledger.flush_all()
        assert (await _row(harness, controller.controller_id)).disconnected_at is None
        await ledger.flush_all()
        row = await _row(harness, controller.controller_id)
        assert row.disconnect_reason == "heartbeat_lapsed"
        assert store.failures == 0
