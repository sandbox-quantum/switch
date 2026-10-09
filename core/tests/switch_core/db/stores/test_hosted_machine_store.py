import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from switch_core.db.models import (
    AgentDefinition,
    HostedMachine,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_BEING_REMOVED,
    MACHINE_NEEDS_ADMIN,
    MACHINE_NEEDS_ATTENTION,
    HostedMachineConflict,
    HostedMachineStore,
    idle_sleeping,
    lock_claims,
    machine_starting,
    owner_stopped,
)
from tests.switch_core.hosted_machine_helpers import (
    link_controller,
    place_managed_agent,
    seed_machine,
)

SLOTS = ["slot-a", "slot-b"]


@pytest.fixture
async def factory(session_factory):
    async with session_factory() as session:
        session.add_all(
            [
                User(
                    id=owner,
                    name=owner,
                    email=f"{owner}@example.com",
                    role="user",
                    password_hash="unused",
                )
                for owner in ("owner-a", "owner-b", "owner-c")
            ]
        )
        await session.commit()
    return session_factory


async def claim(factory, owner_id, slots=SLOTS, capacity=2):
    async with factory() as session:
        await lock_claims(session)
        machine = await HostedMachineStore().claim(
            session,
            owner_id=owner_id,
            slots=slots,
            capacity=capacity,
            now=datetime.now(UTC),
        )
        await session.commit()
        return machine


async def seed(factory, **fields):
    async with factory() as session:
        machine = await seed_machine(session, **fields)
        await session.commit()
        return machine


async def reload(factory, machine_id):
    async with factory() as session:
        machine = await HostedMachineStore().get(session, machine_id)
        assert machine is not None
        return machine


async def test_claim_creates_a_queued_machine(factory):
    machine = await claim(factory, "owner-a")
    assert (
        machine.owner_id,
        machine.slot_id,
        machine.generation,
        machine.state,
        machine.desired_state,
        machine.revision,
        machine.controller_id,
    ) == ("owner-a", "slot-a", 1, "queued", "running", 1, None)
    assert machine_starting(machine)


async def test_a_second_claim_reuses_the_owner_s_machine(factory):
    first = await claim(factory, "owner-a")
    second = await claim(factory, "owner-a")
    assert second.id == first.id
    assert second.revision == 1
    assert second.active_at >= first.active_at


async def test_reusing_a_queued_machine_keeps_its_queued_clock(factory):
    queued = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-a",
        state="queued",
        desired_state="running",
        stop_reason=None,
        revision=1,
        generation=1,
    )
    long_ago = datetime.now(UTC) - timedelta(minutes=11)
    async with factory() as session:
        row = await HostedMachineStore().get(session, queued.id)
        row.updated_at = long_ago
        row.active_at = long_ago
        await session.commit()
    machine = await claim(factory, "owner-a")
    assert machine.id == queued.id
    assert machine.updated_at == long_ago
    assert machine.active_at > long_ago


async def test_starting_a_running_machine_only_renews_activity(factory):
    machine = await claim(factory, "owner-a")
    long_ago = datetime.now(UTC) - timedelta(minutes=11)
    machine.updated_at = long_ago
    now = datetime.now(UTC)
    HostedMachineStore().start(machine, now)
    assert (machine.updated_at, machine.active_at, machine.revision) == (
        long_ago,
        now,
        1,
    )


async def test_a_retained_machine_is_reused_on_the_same_disk(factory):
    retained = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-b",
        state="retained",
        desired_state="retained",
        stop_reason=None,
        revision=4,
        generation=2,
    )
    async with factory() as session:
        row = await HostedMachineStore().get(session, retained.id)
        row.retain_until = datetime.now(UTC) + timedelta(days=3)
        await session.commit()
    machine = await claim(factory, "owner-a")
    assert (
        machine.id,
        machine.slot_id,
        machine.generation,
        machine.desired_state,
        machine.retain_until,
        machine.revision,
    ) == (retained.id, "slot-b", 2, "running", None, 5)
    assert machine_starting(machine)


async def test_a_stopped_machine_is_started(factory):
    stopped = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-a",
        state="stopped",
        desired_state="stopped",
        stop_reason="owner",
        revision=3,
        generation=1,
    )
    assert owner_stopped(stopped) and not idle_sleeping(stopped)
    machine = await claim(factory, "owner-a")
    assert (machine.id, machine.desired_state, machine.stop_reason) == (
        stopped.id,
        "running",
        None,
    )
    assert machine.revision == 4


@pytest.mark.parametrize(
    ("state", "desired_state", "error_code", "retain_for", "detail"),
    [
        ("error", "running", None, None, MACHINE_NEEDS_ATTENTION),
        (
            "error",
            "running",
            "machine_connect_timeout",
            None,
            MACHINE_NEEDS_ATTENTION,
        ),
        ("error", "running", "machine_needs_attention", None, MACHINE_NEEDS_ADMIN),
        ("error", "deleted", "machine_needs_attention", None, MACHINE_NEEDS_ADMIN),
        (
            "error",
            "retained",
            "machine_needs_attention",
            timedelta(0),
            MACHINE_NEEDS_ADMIN,
        ),
        ("error", "deleted", None, None, MACHINE_BEING_REMOVED),
        ("deleting", "deleted", None, None, MACHINE_BEING_REMOVED),
        ("retained", "deleted", None, None, MACHINE_BEING_REMOVED),
        (
            "error",
            "retained",
            "machine_connect_timeout",
            timedelta(0),
            MACHINE_BEING_REMOVED,
        ),
    ],
)
async def test_a_machine_that_cannot_take_agents_refuses_the_claim(
    factory, state, desired_state, error_code, retain_for, detail
):
    seeded = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-a",
        state=state,
        desired_state=desired_state,
        stop_reason=None,
        revision=2,
        generation=1,
    )
    async with factory() as session:
        row = await HostedMachineStore().get(session, seeded.id)
        assert row is not None
        row.error_code = error_code
        if retain_for is not None:
            row.retain_until = datetime.now(UTC) + retain_for
        await session.commit()
    with pytest.raises(HostedMachineConflict) as raised:
        await claim(factory, "owner-a")
    assert str(raised.value) == detail


async def test_a_retained_machine_in_error_still_retaining_refuses_as_in_error(
    factory,
):
    seeded = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-a",
        state="error",
        desired_state="retained",
        stop_reason=None,
        revision=2,
        generation=1,
    )
    async with factory() as session:
        row = await HostedMachineStore().get(session, seeded.id)
        assert row is not None
        row.retain_until = datetime.now(UTC) + timedelta(days=3)
        await session.commit()
    with pytest.raises(HostedMachineConflict) as raised:
        await claim(factory, "owner-a")
    assert str(raised.value) == MACHINE_NEEDS_ATTENTION


async def test_no_free_slot_refuses_the_claim(factory):
    await claim(factory, "owner-b", slots=["slot-a"])
    with pytest.raises(HostedMachineConflict) as raised:
        await claim(factory, "owner-a", slots=["slot-a"], capacity=5)
    assert str(raised.value) == "no machine slot available"


async def test_capacity_caps_live_machines(factory):
    await claim(factory, "owner-b", capacity=1)
    with pytest.raises(HostedMachineConflict, match="no machine slot available"):
        await claim(factory, "owner-a", capacity=1)


async def test_a_reused_slot_gets_the_next_generation(factory):
    for generation in (1, 3):
        await seed(
            factory,
            owner_id="owner-a",
            slot_id="slot-a",
            state="deleted",
            desired_state="deleted",
            stop_reason=None,
            revision=1,
            generation=generation,
        )
    machine = await claim(factory, "owner-a")
    assert (machine.slot_id, machine.generation) == ("slot-a", 4)
    other = await claim(factory, "owner-b")
    assert (other.slot_id, other.generation) == ("slot-b", 1)


async def test_concurrent_claims_cannot_exceed_slots(factory):
    results = await asyncio.gather(
        claim(factory, "owner-a", slots=["slot-a"]),
        claim(factory, "owner-b", slots=["slot-a"]),
        return_exceptions=True,
    )
    assert sum(isinstance(value, HostedMachine) for value in results) == 1
    assert sum(isinstance(value, HostedMachineConflict) for value in results) == 1


async def test_start_stop_and_retry(factory):
    machine = await claim(factory, "owner-a")
    store = HostedMachineStore()
    now = datetime.now(UTC)
    store.start(machine, now)
    assert machine.revision == 1
    store.stop(machine, "idle", now)
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "stopped",
        "idle",
        2,
    )
    assert idle_sleeping(machine)
    store.start(machine, now)
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "running",
        None,
        3,
    )
    machine.state = "error"
    machine.error = "Instance failed"
    machine.error_code = "machine_needs_attention"
    machine.running_observed_at = now
    store.retry(machine, now)
    assert (
        machine.state,
        machine.error,
        machine.error_code,
        machine.revision,
        machine.running_observed_at,
    ) == ("queued", None, None, 4, None)


async def test_starting_a_ready_machine_again_waits_for_it_to_reconnect(factory):
    machine = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-a",
        state="ready",
        desired_state="running",
        stop_reason=None,
        revision=2,
        generation=1,
    )
    store = HostedMachineStore()
    now = datetime.now(UTC)
    machine.running_observed_at = now
    store.start(machine, now)
    assert (machine.state, machine.revision, machine.running_observed_at) == (
        "ready",
        2,
        now,
    )
    store.stop(machine, "owner", now)
    store.start(machine, now)
    assert (
        machine.state,
        machine.desired_state,
        machine.revision,
        machine.running_observed_at,
    ) == ("provisioning", "running", 4, None)


async def test_reusing_a_retained_machine_still_ready_waits_for_it_to_reconnect(
    factory,
):
    retained = await seed(
        factory,
        owner_id="owner-a",
        slot_id="slot-a",
        state="ready",
        desired_state="retained",
        stop_reason=None,
        revision=3,
        generation=1,
    )
    machine = await claim(factory, "owner-a")
    assert (machine.id, machine.state, machine.desired_state, machine.revision) == (
        retained.id,
        "provisioning",
        "running",
        4,
    )
    assert machine_starting(machine)


async def ready_machine(session, owner_id="owner-a"):
    return await seed_machine(
        session,
        owner_id=owner_id,
        slot_id="slot-a",
        state="ready",
        desired_state="running",
        stop_reason=None,
        revision=2,
        generation=1,
    )


async def test_retain_if_empty_retains_only_once_no_agent_is_placed(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        controller = await link_controller(session, machine)
        definition = await place_managed_agent(
            session, owner_id="owner-a", controller_id=controller.id, name="helper"
        )
        now = datetime.now(UTC)
        assert await store.has_agents(session, machine)
        assert not await store.retain_if_empty(
            session, machine, retention_days=7, now=now
        )
        assert (machine.desired_state, machine.revision) == ("running", 2)
        definition.controller_id = None
        assert await store.retain_if_empty(session, machine, retention_days=7, now=now)
        assert (
            machine.desired_state,
            machine.stop_reason,
            machine.revision,
            machine.retain_until,
        ) == ("retained", None, 3, now + timedelta(days=7))
        await session.commit()


async def test_only_agents_on_the_machine_s_own_controller_count(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        other = await seed_machine(
            session,
            owner_id="owner-b",
            slot_id="slot-b",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        mine = await link_controller(session, machine)
        theirs = await link_controller(session, other)
        await place_managed_agent(
            session, owner_id="owner-b", controller_id=theirs.id, name="theirs"
        )
        assert not await store.has_agents(session, machine)
        assert await store.managed_agent_ids(session, machine) == []
        placed = [
            await place_managed_agent(
                session, owner_id="owner-a", controller_id=mine.id, name=name
            )
            for name in ("reviewer", "builder")
        ]
        assert await store.has_agents(session, machine)
        assert await store.managed_agent_ids(session, machine) == sorted(
            definition.agent_id for definition in placed
        )


async def test_a_machine_without_a_controller_has_no_agents(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        assert not await store.has_agents(session, machine)
        assert await store.managed_agent_ids(session, machine) == []
        assert not await store.ever_hosted(session, machine)


async def test_release_if_empty_expires_a_machine_whose_controller_never_enrolled(
    factory,
):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        now = datetime.now(UTC)
        assert await store.release_if_empty(session, machine, retention_days=7, now=now)
        assert (machine.desired_state, machine.revision, machine.retain_until) == (
            "retained",
            3,
            now,
        )


async def test_release_if_empty_keeps_the_disk_of_a_machine_that_enrolled(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        await link_controller(session, machine)
        assert await store.ever_hosted(session, machine)
        now = datetime.now(UTC)
        assert await store.release_if_empty(session, machine, retention_days=7, now=now)
        assert (machine.desired_state, machine.retain_until) == (
            "retained",
            now + timedelta(days=7),
        )


async def test_release_if_empty_leaves_a_machine_with_agents(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        controller = await link_controller(session, machine)
        await place_managed_agent(
            session, owner_id="owner-a", controller_id=controller.id, name="helper"
        )
        assert not await store.release_if_empty(
            session, machine, retention_days=7, now=datetime.now(UTC)
        )
        assert (machine.desired_state, machine.revision, machine.retain_until) == (
            "running",
            2,
            None,
        )


async def test_removing_the_agent_takes_it_off_the_machine(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        controller = await link_controller(session, machine)
        definition = await place_managed_agent(
            session, owner_id="owner-a", controller_id=controller.id, name="helper"
        )
        await session.commit()
    async with factory() as session:
        row = await session.get(AgentDefinition, definition.id)
        await session.delete(row)
        await session.commit()
    async with factory() as session:
        machine = await store.get(session, machine.id)
        assert machine is not None
        assert not await store.has_agents(session, machine)
        assert await store.ever_hosted(session, machine)


async def test_owned_and_live_for_owner(factory):
    store = HostedMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        await seed_machine(
            session,
            owner_id="owner-a",
            slot_id="slot-b",
            state="deleted",
            desired_state="deleted",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        await session.commit()
    async with factory() as session:
        assert (await store.owned(session, machine.id, "owner-a")).id == machine.id
        assert await store.owned(session, machine.id, "owner-b") is None
        assert (await store.live_for_owner(session, "owner-a")).id == machine.id
        assert await store.live_for_owner(session, "owner-b") is None
        assert (await store.locked(session, machine.id)).id == machine.id
        assert await store.locked(session, "missing") is None
        assert await session.get(HostedMachine, (require_tenant_id(), machine.id))
