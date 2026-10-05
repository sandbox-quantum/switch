from datetime import UTC, datetime, timedelta

import pytest

from switch_core.db.models import (
    HostedLaunch,
    HostedMachine,
    ProviderConnection,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import (
    HostedLaunchConflict,
    HostedLaunchStore,
    ProviderDisconnected,
    is_waking,
)
from switch_core.db.stores.hosted_machine_store import HostedMachineStore
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.tenant_context import tenant_scope
from tests.switch_core.bridges.agent.protocol.registration_harness import KEYRING

SLOTS = ["slot-a", "slot-b"]


@pytest.fixture
async def launches(session_factory):
    async with session_factory() as session:
        session.add_all(
            [
                User(
                    id="launch-owner",
                    name="Owner",
                    email="launch@example.com",
                    role="user",
                    password_hash="unused",
                ),
                User(
                    id="launch-other",
                    name="Other",
                    email="other-launch@example.com",
                    role="user",
                    password_hash="unused",
                ),
                Tenant(id="launch-other-tenant", slug="launch-other", name="Other"),
            ]
        )
        await session.flush()
        await ProviderConnectionStore().save(
            session,
            "launch-owner",
            "setup-token",
            KEYRING.encrypt("SYNTHETIC-CLAUDE"),
            datetime.now(UTC),
        )
        await session.commit()
    return HostedLaunchStore(), session_factory


async def reserve(store, factory, request_id, name, owner_capacity=3):
    async with factory() as session:
        row = await store.reserve(
            session,
            request_id=request_id,
            owner_id="launch-owner",
            name=name,
            spec={"repository_id": 123},
            capacity=1,
            owner_capacity=owner_capacity,
            slots=SLOTS,
            repository="example-org/example-repo",
            now=datetime.now(UTC),
        )
        await session.commit()
        return row.id


async def load(factory, launch_id):
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), launch_id))
        assert launch is not None and launch.machine_id is not None
        machine = await session.get(
            HostedMachine, (require_tenant_id(), launch.machine_id)
        )
        assert machine is not None
        return launch, machine


async def test_duplicate_request_survives_new_session_without_second_launch(launches):
    store, factory = launches
    assert await reserve(store, factory, "request-1", "helper") == "request-1"
    assert await reserve(store, factory, "request-1", "helper") == "request-1"
    with pytest.raises(HostedLaunchConflict, match="different"):
        await reserve(store, factory, "request-1", "different")
    with pytest.raises(HostedLaunchConflict, match="name"):
        await reserve(store, factory, "request-2", "helper")
    _, machine = await load(factory, "request-1")
    assert machine.agents_version == 2


async def test_reserve_places_the_launch_on_a_new_machine(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch, machine = await load(factory, "request-1")
    assert (launch.state, launch.agent_id, launch.repository) == (
        "queued",
        None,
        "example-org/example-repo",
    )
    assert (machine.owner_id, machine.slot_id, machine.state, machine.generation) == (
        "launch-owner",
        "slot-a",
        "queued",
        1,
    )


async def test_an_owner_s_agents_share_one_machine(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "first")
    await reserve(store, factory, "request-2", "second")
    first, machine = await load(factory, "request-1")
    second, _ = await load(factory, "request-2")
    assert first.machine_id == second.machine_id == machine.id
    assert machine.agents_version == 3


async def test_owner_limit_counts_live_launches(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "first", owner_capacity=1)
    with pytest.raises(HostedLaunchConflict, match="Remove an agent"):
        await reserve(store, factory, "request-2", "second", owner_capacity=1)
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), "request-1"))
        launch.state = "deleted"
        launch.desired_state = "deleted"
        await session.commit()
    assert (
        await reserve(store, factory, "request-2", "second", owner_capacity=1)
        == "request-2"
    )


async def test_owner_and_tenant_scope(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    async with factory() as session:
        assert await store.owned(session, "request-1", "launch-other") is None
        assert await store.owned(session, "request-1", "launch-owner") is not None
    with tenant_scope("launch-other-tenant"):
        async with factory() as session:
            assert await store.owned(session, "request-1", "launch-owner") is None
        assert await reserve(store, factory, "request-1", "helper") == "request-1"


async def address(store, factory, launch_id, machine_state=None, **state):
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), launch_id))
        if launch is not None:
            for key, value in state.items():
                setattr(launch, key, value)
            launch.active_at = datetime.now(UTC) - timedelta(hours=1)
            machine = await session.get(
                HostedMachine, (require_tenant_id(), launch.machine_id)
            )
            for key, value in (machine_state or {}).items():
                setattr(machine, key, value)
            machine.active_at = datetime.now(UTC) - timedelta(hours=1)
            await session.commit()
        result = await store.note_addressed(session, launch_id)
        await session.commit()
        return result


IDLE_SLEEPING = {
    "state": "stopped",
    "desired_state": "stopped",
    "stop_reason": "idle",
    "revision": 2,
}


async def test_addressing_a_launch_on_a_sleeping_machine_wakes_the_machine(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch, machine = await address(
        store, factory, "request-1", machine_state=IDLE_SLEEPING, state="ready"
    )
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "running",
        None,
        3,
    )
    assert (launch.desired_state, launch.state, launch.revision) == (
        "running",
        "ready",
        1,
    )
    assert datetime.now(UTC) - launch.active_at < timedelta(minutes=1)
    assert datetime.now(UTC) - machine.active_at < timedelta(minutes=1)
    assert is_waking(launch, machine)


async def test_addressing_without_provider_does_not_wake_the_machine(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    async with factory() as session:
        connection = await session.get(
            ProviderConnection, (require_tenant_id(), "launch-owner", "claude")
        )
        await session.delete(connection)
        await session.commit()
    with pytest.raises(ProviderDisconnected):
        await address(
            store, factory, "request-1", machine_state=IDLE_SLEEPING, state="ready"
        )
    launch, machine = await load(factory, "request-1")
    assert (machine.desired_state, machine.revision) == ("stopped", 2)
    assert launch.revision == 1


async def test_addressing_a_ready_launch_only_marks_it_active(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    ready, machine = await address(
        store, factory, "request-1", machine_state={"state": "ready"}, state="ready"
    )
    assert (ready.desired_state, ready.state, ready.revision) == ("running", "ready", 1)
    assert machine.revision == 1
    assert datetime.now(UTC) - ready.active_at < timedelta(minutes=1)
    assert not is_waking(ready, machine)


async def test_addressing_never_wakes_a_machine_its_owner_stopped(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch, machine = await address(
        store,
        factory,
        "request-1",
        machine_state={**IDLE_SLEEPING, "stop_reason": "owner"},
        state="ready",
    )
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "stopped",
        "owner",
        2,
    )
    assert datetime.now(UTC) - launch.active_at > timedelta(minutes=59)


async def test_addressing_never_wakes_an_errored_idle_sleeping_machine(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch, machine = await address(
        store,
        factory,
        "request-1",
        machine_state={**IDLE_SLEEPING, "state": "error"},
        state="ready",
    )
    assert (
        machine.state,
        machine.desired_state,
        machine.stop_reason,
        machine.revision,
    ) == ("error", "stopped", "idle", 2)
    assert not is_waking(launch, machine)


@pytest.mark.parametrize("desired", ["stopped", "deleted"])
async def test_addressing_never_wakes_for_a_launch_its_owner_stopped(launches, desired):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch, machine = await address(
        store,
        factory,
        "request-1",
        machine_state=IDLE_SLEEPING,
        desired_state=desired,
        state="stopped",
    )
    assert (machine.desired_state, machine.revision) == ("stopped", 2)
    assert (launch.desired_state, launch.revision) == (desired, 1)
    assert datetime.now(UTC) - launch.active_at > timedelta(minutes=59)


async def test_addressing_a_missing_launch_returns_none(launches):
    store, factory = launches
    assert await address(store, factory, "no-such-launch") == (None, None)


async def test_addressing_does_not_wake_for_an_errored_launch(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch, machine = await address(
        store,
        factory,
        "request-1",
        machine_state=IDLE_SLEEPING,
        state="error",
        error="Agent crashed",
    )
    assert (machine.desired_state, machine.revision) == ("stopped", 2)
    assert (launch.state, launch.revision, launch.error) == (
        "error",
        1,
        "Agent crashed",
    )
    assert not is_waking(launch, machine)


async def test_a_queued_launch_is_waking_until_it_is_ready(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    async with factory() as session:
        launch, machine = await HostedMachineStore().locked_launch(session, "request-1")
        assert launch is not None and machine is not None
        assert is_waking(launch, machine)
        machine.state = "ready"
        assert is_waking(launch, machine)
        launch.state = "ready"
        assert not is_waking(launch, machine)
        assert not is_waking(launch, None)


async def test_a_queued_launch_on_an_errored_machine_is_not_waking(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    async with factory() as session:
        launch, machine = await HostedMachineStore().locked_launch(session, "request-1")
        assert launch is not None and machine is not None
        assert launch.state == "queued"
        machine.state = "error"
        assert not is_waking(launch, machine)
        launch.state = "provisioning"
        assert not is_waking(launch, machine)
