"""Management's nudges reach the controller wherever it streams from."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.management.notifier import (
    ASSIGNMENT_CHANGED,
    CREDENTIAL_REVOKED,
    OPERATION_PENDING,
    ControllerNotifier,
)
from switch_core.management.signals import ControllerSignals
from switch_core.signals import SignalBus
from switch_core.user_changes import LocalUserChanges, SignalUserChanges
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
    open_connection,
    open_stream,
    place_agent,
    provider,
    report_status,
    take,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

DELIVERY_TIMEOUT = 10.0


def _process(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> tuple[ControllerSignals, AgentConnectionRegistry, SignalBus]:
    """One switch-core process's share of it: its own presence, notifier and bus."""
    registry = AgentConnectionRegistry()
    bus = SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=str(uuid.uuid4()),
    )
    signals = ControllerSignals(
        notifier=ControllerNotifier(),
        presence=registry.controllers,
        bus=bus,
        session_factory=session_factory,
        controllers=AgentControllerStore(),
        definitions=AgentDefinitionStore(),
        operations=AgentControllerOperationStore(),
        rooms=RoomStore(),
        processes=SwitchCoreProcessStore(),
        clock=lambda: datetime.now(UTC),
        user_changes=SignalUserChanges(local=LocalUserChanges(), bus=bus),
    )
    return signals, registry, bus


@pytest.fixture
async def two_processes(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[tuple[ControllerSignals, ControllerSignals]]:
    first, _, first_bus = _process(postgres_url, session_factory)
    second, _, second_bus = _process(postgres_url, session_factory)
    for bus in (first_bus, second_bus):
        await bus.start()
    for bus in (first_bus, second_bus):
        await asyncio.wait_for(bus.connected.wait(), DELIVERY_TIMEOUT)
    yield first, second
    await first_bus.stop()
    await second_bus.stop()


async def _woken(subscription: object) -> None:
    await asyncio.wait_for(subscription.wake.wait(), DELIVERY_TIMEOUT)  # type: ignore[attr-defined]


class TestAcrossProcesses:
    async def test_a_change_in_one_process_nudges_a_stream_in_another(
        self, two_processes: tuple[ControllerSignals, ControllerSignals]
    ) -> None:
        handled_here, streaming_there = two_processes
        subscription = streaming_there.notifier.subscribe("c1")

        handled_here.assignment_changed(TENANT_ZERO_ID, "c1", 7)
        handled_here.operation_pending(
            "c1", operation_id="o1", kind="provider.recheck", agent_id=None
        )
        await _woken(subscription)
        async with asyncio.timeout(DELIVERY_TIMEOUT):
            frames = subscription.drain()
            while len(frames) < 2:
                await _woken(subscription)
                frames += subscription.drain()

        assert frames == [
            (ASSIGNMENT_CHANGED, {"revision": 7}),
            (
                OPERATION_PENDING,
                {"operation_id": "o1", "kind": "provider.recheck", "agent_id": None},
            ),
        ]

    async def test_the_process_that_made_the_change_nudges_at_once(
        self, two_processes: tuple[ControllerSignals, ControllerSignals]
    ) -> None:
        handled_here, _ = two_processes
        subscription = handled_here.notifier.subscribe("c1")

        handled_here.assignment_changed(TENANT_ZERO_ID, "c1", 2)

        assert subscription.drain() == [(ASSIGNMENT_CHANGED, {"revision": 2})]

    async def test_a_revocation_reaches_the_other_process(
        self, two_processes: tuple[ControllerSignals, ControllerSignals]
    ) -> None:
        handled_here, streaming_there = two_processes
        subscription = streaming_there.notifier.subscribe("c1")

        handled_here.revoked("c1")
        await _woken(subscription)

        assert subscription.drain() == [(CREDENTIAL_REVOKED, {})]
        assert streaming_there._presence.is_revoked("c1")


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class TestResync:
    async def test_a_held_controller_is_renudged_from_the_database(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            (opening,) = await take(stream, 1)

            await harness.management.service.signals.resync()
            nudged = await take(stream, 1)
            await stream.aclose()

        assert nudged == [
            (ASSIGNMENT_CHANGED, {"revision": opening[1]["assignment_revision"]})
        ]

    async def test_a_controller_revoked_meanwhile_is_closed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 1)
            async with tenant_session(
                harness.session_factory, TENANT_ZERO_ID
            ) as session:
                await AgentControllerStore().mark_revoked(
                    session, TENANT_ZERO_ID, controller.controller_id, datetime.now(UTC)
                )
                await session.commit()

            await harness.management.service.signals.resync()
            final = await take(stream, 1)
            with pytest.raises(StopAsyncIteration):
                await anext(stream)

        assert final == [(CREDENTIAL_REVOKED, {})]


@pytest.fixture
async def processes(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[
    tuple[ControllerSignals, tuple[ControllerSignals, AgentConnectionRegistry]]
]:
    """A process that announces changes, and another with its own bindings."""
    announcing, _, announcing_bus = _process(postgres_url, session_factory)
    other, registry, other_bus = _process(postgres_url, session_factory)
    for bus in (announcing_bus, other_bus):
        await bus.start()
    for bus in (announcing_bus, other_bus):
        await asyncio.wait_for(bus.connected.wait(), DELIVERY_TIMEOUT)
    yield announcing, (other, registry)
    await announcing_bus.stop()
    await other_bus.stop()


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(DELIVERY_TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


async def _revision(
    session_factory: async_sessionmaker[AsyncSession], controller_id: str
) -> int:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        controller = await AgentControllerStore().get(
            session, TENANT_ZERO_ID, controller_id
        )
        assert controller is not None
        return controller.assignment_revision


class TestBindingsAcrossProcesses:
    """A placement changes in the process that served the request. The
    harness is that process; `processes` is a process announcing it and
    another that has to bind the agent from the tables."""

    async def test_a_placement_binds_the_agent_in_the_other_process(
        self,
        harness: Harness,
        processes: tuple[
            ControllerSignals, tuple[ControllerSignals, AgentConnectionRegistry]
        ],
    ) -> None:
        announcing, (_, there) = processes
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")

        announcing.assignment_changed(
            TENANT_ZERO_ID,
            controller.controller_id,
            await _revision(harness.session_factory, controller.controller_id),
        )
        await _eventually(lambda: there.controllers.is_bound(agent_id))

        binding = there.controllers.binding(agent_id)
        assert binding is not None
        assert (binding.controller_id, binding.controller_name, binding.running) == (
            controller.controller_id,
            "laptop",
            True,
        )

    async def test_a_move_and_a_removal_follow_in_the_other_process(
        self,
        harness: Harness,
        processes: tuple[
            ControllerSignals, tuple[ControllerSignals, AgentConnectionRegistry]
        ],
    ) -> None:
        announcing, (_, there) = processes
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            await report_status(client, second, 1, providers=[provider("claude")])
            agent_id = await place_agent(client, first, name="reviewer")
            announcing.assignment_changed(TENANT_ZERO_ID, first.controller_id, 1)
            await _eventually(lambda: there.controllers.is_bound(agent_id))

            moved = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"controller_id": second.controller_id},
                cookies=cookies_for(owner),
            )
            assert moved.status_code == 200, moved.text
        # Only the controller it left is announced: the agent is bound where
        # it went all the same, whichever controller's signal comes first.
        announcing.assignment_changed(TENANT_ZERO_ID, first.controller_id, 2)
        await _eventually(
            lambda: (
                getattr(there.controllers.binding(agent_id), "controller_id", None)
                == second.controller_id
            )
        )

        await harness.management.agent_removed(TENANT_ZERO_ID, agent_id)
        announcing.assignment_changed(TENANT_ZERO_ID, second.controller_id, 3)
        await _eventually(lambda: not there.controllers.is_bound(agent_id))

    async def test_a_rename_reaches_the_other_process(
        self,
        harness: Harness,
        processes: tuple[
            ControllerSignals, tuple[ControllerSignals, AgentConnectionRegistry]
        ],
    ) -> None:
        announcing, (_, there) = processes
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        announcing.assignment_changed(TENANT_ZERO_ID, controller.controller_id, 1)
        await _eventually(lambda: there.controllers.is_bound(agent_id))

        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            await AgentControllerStore().update_details(
                session,
                TENANT_ZERO_ID,
                controller.controller_id,
                {"name": "workstation"},
            )
            await session.commit()
        announcing.renamed(TENANT_ZERO_ID, controller.controller_id)

        await _eventually(
            lambda: (
                getattr(there.controllers.binding(agent_id), "controller_name", None)
                == "workstation"
            )
        )


class TestRecheck:
    async def test_a_missed_signal_is_caught_by_the_recheck(
        self, harness: Harness, postgres_url: str
    ) -> None:
        # Never started: no signal reaches this process.
        other, registry, _ = _process(postgres_url, harness.session_factory)
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")

        await other.recheck()
        assert registry.controllers.is_bound(agent_id)

        await harness.management.agent_removed(TENANT_ZERO_ID, agent_id)
        await other.recheck()
        assert not registry.controllers.is_bound(agent_id)

    async def test_with_nothing_changed_it_reads_no_placement(
        self, harness: Harness, postgres_url: str
    ) -> None:
        """Every process re-checks every 30 seconds, and with 10,000 managed
        agents a read of every placement on each was a large share of what the
        processes did while nothing happened."""
        other, registry, _ = _process(postgres_url, harness.session_factory)
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        await other.recheck()
        assert registry.controllers.is_bound(agent_id)
        reads = _count_placement_reads(other)

        await other.recheck()

        assert reads == []

    async def test_a_controller_renamed_with_no_signal_is_read(
        self, harness: Harness, postgres_url: str
    ) -> None:
        other, registry, _ = _process(postgres_url, harness.session_factory)
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        await other.recheck()

        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            await AgentControllerStore().update_details(
                session,
                TENANT_ZERO_ID,
                controller.controller_id,
                {"name": "workstation"},
            )
            await session.commit()
        await other.recheck()

        binding = registry.controllers.binding(agent_id)
        assert binding is not None and binding.controller_name == "workstation"

    async def test_a_held_controller_is_nudged_only_with_what_it_was_not_told(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        signals = harness.management.service.signals
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await open_connection(client, controller)
        subscription = signals.notifier.subscribe(controller.controller_id)
        opening = await _revision(harness.session_factory, controller.controller_id)

        # This process never nudged it, so the first re-check does, once.
        await signals.recheck()
        first = subscription.drain()
        await signals.recheck()
        second = subscription.drain()
        # A change whose signal never came is a newer revision.
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            revision = await AgentControllerStore().bump_assignment_revision(
                session, TENANT_ZERO_ID, controller.controller_id
            )
            await session.commit()
        await signals.recheck()
        missed = subscription.drain()

        assert first == [(ASSIGNMENT_CHANGED, {"revision": opening})]
        assert second == []
        assert missed == [(ASSIGNMENT_CHANGED, {"revision": revision})]


class TestReconcileKeepsNewerLocalChanges:
    def test_a_binding_made_after_the_read_is_left_alone(self) -> None:
        presence = AgentConnectionRegistry().controllers
        since = presence.change_mark()
        presence.bind(
            Binding(
                agent_id="a1",
                controller_id="c1",
                tenant_id=TENANT_ZERO_ID,
                controller_name="laptop",
                running=True,
            )
        )

        # The read started before the bind, so it did not see it.
        presence.reconcile([], agent_ids={"a1"}, since=since)

        assert presence.is_bound("a1")
        presence.reconcile([], agent_ids={"a1"}, since=presence.change_mark())
        assert not presence.is_bound("a1")


def _count_placement_reads(signals: ControllerSignals) -> list[str]:
    """The tenants whose placements `signals` reads in full from now on."""
    reads: list[str] = []
    store = signals._definitions
    real = store.placements

    async def counted(session: Any, tenant_id: str) -> Any:
        reads.append(tenant_id)
        return await real(session, tenant_id)

    store.placements = counted  # type: ignore[method-assign]
    return reads
