import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentDefinition,
    CloudMachine,
    User,
)
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_BEING_REMOVED,
    MACHINE_NEEDS_ADMIN,
    MACHINE_NEEDS_ATTENTION,
    MACHINE_WORKSPACES_FULL,
    MACHINES_FULL,
    MAX_MACHINE_WORKSPACES,
    CloudMachineConflict,
    CloudMachineStore,
    WorkspaceOnMachine,
    ever_hosted,
    idle_sleeping,
    lock_claims,
    machine_starting,
    managed_agent_ids,
    owner_stopped,
    workspace_on,
    workspaces_on,
)
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.tenant_context import tenant_scope
from tests.switch_core.hosted_machine_helpers import (
    add_tenant,
    add_workspace,
    link_controller,
    place_managed_agent,
    seed_machine,
)

TENANT_B = "tenant-b"
OTHER_WORKSPACES = [f"workspace-{index}" for index in range(MAX_MACHINE_WORKSPACES)]


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
        for tenant_id in (TENANT_B, *OTHER_WORKSPACES):
            await add_tenant(session, tenant_id)
        await session.commit()
    return session_factory


async def claim_both(factory, owner_id, capacity=2):
    """The owner's machine claimed with the bound workspace, and that workspace's row on it."""
    async with factory() as session:
        await lock_claims(session)
        found = await CloudMachineStore().claim(
            session,
            factory,
            owner_id=owner_id,
            capacity=capacity,
            now=datetime.now(UTC),
        )
        await session.commit()
        return found


async def claim(factory, owner_id, capacity=2):
    machine, _workspace = await claim_both(factory, owner_id, capacity)
    return machine


async def claim_in(factory, tenant_id, owner_id, capacity=2):
    with tenant_scope(tenant_id):
        return await claim_both(factory, owner_id, capacity)


async def seed(factory, **fields):
    async with factory() as session:
        machine = await seed_machine(session, **fields)
        await session.commit()
        return machine


async def reload(factory, machine_id):
    async with factory() as session:
        machine = await CloudMachineStore().get(session, machine_id)
        assert machine is not None
        return machine


async def test_claim_creates_a_queued_machine(factory):
    machine, workspace = await claim_both(factory, "owner-a")
    assert (
        machine.owner_id,
        machine.state,
        machine.desired_state,
        machine.revision,
    ) == ("owner-a", "queued", "running", 1)
    assert machine_starting(machine)
    assert (
        workspace.tenant_id,
        workspace.machine_id,
        workspace.owner_id,
        workspace.controller_id,
    ) == (TENANT_ZERO_ID, machine.id, "owner-a", None)


async def test_a_second_claim_reuses_the_owner_s_machine(factory):
    first, here = await claim_both(factory, "owner-a")
    second, again = await claim_both(factory, "owner-a")
    assert (second.id, again.id) == (first.id, here.id)
    assert second.revision == 1
    assert second.active_at >= first.active_at
    assert await tenants_of_cloud_machine(factory, first.id) == [TENANT_ZERO_ID]


async def test_reusing_a_queued_machine_keeps_its_queued_clock(factory):
    queued = await seed(
        factory,
        owner_id="owner-a",
        state="queued",
        desired_state="running",
        stop_reason=None,
        revision=1,
    )
    long_ago = datetime.now(UTC) - timedelta(minutes=11)
    async with factory() as session:
        row = await CloudMachineStore().get(session, queued.id)
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
    CloudMachineStore().start(machine, now)
    assert (machine.updated_at, machine.active_at, machine.revision) == (
        long_ago,
        now,
        1,
    )


async def test_a_retained_machine_is_reused_on_the_same_disk(factory):
    retained = await seed(
        factory,
        owner_id="owner-a",
        state="retained",
        desired_state="retained",
        stop_reason=None,
        revision=4,
    )
    async with factory() as session:
        row = await CloudMachineStore().get(session, retained.id)
        row.retain_until = datetime.now(UTC) + timedelta(days=3)
        await session.commit()
    machine = await claim(factory, "owner-a")
    assert (
        machine.id,
        machine.desired_state,
        machine.retain_until,
        machine.revision,
    ) == (retained.id, "running", None, 5)
    assert machine_starting(machine)


async def test_a_stopped_machine_is_started(factory):
    stopped = await seed(
        factory,
        owner_id="owner-a",
        state="stopped",
        desired_state="stopped",
        stop_reason="owner",
        revision=3,
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
        state=state,
        desired_state=desired_state,
        stop_reason=None,
        revision=2,
    )
    async with factory() as session:
        row = await CloudMachineStore().get(session, seeded.id)
        assert row is not None
        row.error_code = error_code
        if retain_for is not None:
            row.retain_until = datetime.now(UTC) + retain_for
        await session.commit()
    with pytest.raises(CloudMachineConflict) as raised:
        await claim(factory, "owner-a")
    assert str(raised.value) == detail


async def test_a_retained_machine_in_error_still_retaining_refuses_as_in_error(
    factory,
):
    seeded = await seed(
        factory,
        owner_id="owner-a",
        state="error",
        desired_state="retained",
        stop_reason=None,
        revision=2,
    )
    async with factory() as session:
        row = await CloudMachineStore().get(session, seeded.id)
        assert row is not None
        row.retain_until = datetime.now(UTC) + timedelta(days=3)
        await session.commit()
    with pytest.raises(CloudMachineConflict) as raised:
        await claim(factory, "owner-a")
    assert str(raised.value) == MACHINE_NEEDS_ATTENTION


async def test_capacity_caps_live_machines(factory):
    await claim(factory, "owner-b", capacity=1)
    with pytest.raises(CloudMachineConflict) as raised:
        await claim(factory, "owner-a", capacity=1)
    assert str(raised.value) == MACHINES_FULL


async def test_deleted_machines_do_not_count_towards_capacity(factory):
    await seed(
        factory,
        owner_id="owner-b",
        state="deleted",
        desired_state="deleted",
        stop_reason=None,
        revision=1,
    )
    machine = await claim(factory, "owner-a", capacity=1)
    assert machine.state == "queued"


async def test_concurrent_claims_cannot_exceed_capacity(factory):
    results = await asyncio.gather(
        claim(factory, "owner-a", capacity=1),
        claim(factory, "owner-b", capacity=1),
        return_exceptions=True,
    )
    assert sum(isinstance(value, CloudMachine) for value in results) == 1
    assert sum(isinstance(value, CloudMachineConflict) for value in results) == 1


async def test_start_stop_and_retry(factory):
    machine = await claim(factory, "owner-a")
    store = CloudMachineStore()
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
        state="ready",
        desired_state="running",
        stop_reason=None,
        revision=2,
    )
    store = CloudMachineStore()
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
        state="ready",
        desired_state="retained",
        stop_reason=None,
        revision=3,
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
        state="ready",
        desired_state="running",
        stop_reason=None,
        revision=2,
    )


def counted(workspaces: list[WorkspaceOnMachine]) -> list[tuple[str, str | None, int]]:
    return [
        (workspace.tenant_id, workspace.controller_id, workspace.agent_count)
        for workspace in workspaces
    ]


async def test_retain_if_empty_retains_only_once_no_agent_is_placed(factory):
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        controller = await link_controller(session, machine)
        definition = await place_managed_agent(
            session, owner_id="owner-a", controller_id=controller.id, name="helper"
        )
        await session.commit()
    now = datetime.now(UTC)
    workspaces = await workspaces_on(factory, machine.id)
    assert counted(workspaces) == [(TENANT_ZERO_ID, controller.id, 1)]
    assert not await store.retain_if_empty(
        machine, workspaces, retention_days=7, now=now
    )
    assert (machine.desired_state, machine.revision) == ("running", 2)
    async with factory() as session:
        row = await session.get(AgentDefinition, definition.id)
        row.controller_id = None
        await session.commit()
    workspaces = await workspaces_on(factory, machine.id)
    assert counted(workspaces) == [(TENANT_ZERO_ID, controller.id, 0)]
    assert await store.retain_if_empty(machine, workspaces, retention_days=7, now=now)
    assert (
        machine.desired_state,
        machine.stop_reason,
        machine.revision,
        machine.retain_until,
    ) == ("retained", None, 3, now + timedelta(days=7))


async def test_only_agents_on_the_machine_s_own_controller_count(factory):
    async with factory() as session:
        machine = await ready_machine(session)
        other = await seed_machine(
            session,
            owner_id="owner-b",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        mine = await link_controller(session, machine)
        theirs = await link_controller(session, other)
        await place_managed_agent(
            session, owner_id="owner-b", controller_id=theirs.id, name="theirs"
        )
        assert await managed_agent_ids(session, mine.id) == []
        await session.commit()
    assert counted(await workspaces_on(factory, machine.id)) == [
        (TENANT_ZERO_ID, mine.id, 0)
    ]
    async with factory() as session:
        placed = [
            await place_managed_agent(
                session, owner_id="owner-a", controller_id=mine.id, name=name
            )
            for name in ("reviewer", "builder")
        ]
        assert await managed_agent_ids(session, mine.id) == sorted(
            definition.agent_id for definition in placed
        )
        await session.commit()
    assert counted(await workspaces_on(factory, machine.id)) == [
        (TENANT_ZERO_ID, mine.id, 2)
    ]


async def test_a_machine_without_a_controller_has_no_agents(factory):
    async with factory() as session:
        machine = await ready_machine(session)
        assert await managed_agent_ids(session, None) == []
        await session.commit()
    workspaces = await workspaces_on(factory, machine.id)
    assert counted(workspaces) == [(TENANT_ZERO_ID, None, 0)]
    assert not ever_hosted(workspaces)


async def test_release_if_empty_expires_a_machine_whose_controller_never_enrolled(
    factory,
):
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        await session.commit()
    now = datetime.now(UTC)
    assert await store.release_if_empty(
        machine, await workspaces_on(factory, machine.id), retention_days=7, now=now
    )
    assert (machine.desired_state, machine.revision, machine.retain_until) == (
        "retained",
        3,
        now,
    )


async def test_release_if_empty_keeps_the_disk_of_a_machine_that_enrolled(factory):
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        await link_controller(session, machine)
        await session.commit()
    workspaces = await workspaces_on(factory, machine.id)
    assert ever_hosted(workspaces)
    now = datetime.now(UTC)
    assert await store.release_if_empty(machine, workspaces, retention_days=7, now=now)
    assert (machine.desired_state, machine.retain_until) == (
        "retained",
        now + timedelta(days=7),
    )


async def test_release_if_empty_leaves_a_machine_with_agents(factory):
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        controller = await link_controller(session, machine)
        await place_managed_agent(
            session, owner_id="owner-a", controller_id=controller.id, name="helper"
        )
        await session.commit()
    assert not await store.release_if_empty(
        machine,
        await workspaces_on(factory, machine.id),
        retention_days=7,
        now=datetime.now(UTC),
    )
    assert (machine.desired_state, machine.revision, machine.retain_until) == (
        "running",
        2,
        None,
    )


async def test_removing_the_agent_takes_it_off_the_machine(factory):
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
    workspaces = await workspaces_on(factory, machine.id)
    assert counted(workspaces) == [(TENANT_ZERO_ID, controller.id, 0)]
    assert ever_hosted(workspaces)


async def test_owned_and_live_for_owner(factory):
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        await seed_machine(
            session,
            owner_id="owner-a",
            state="deleted",
            desired_state="deleted",
            stop_reason=None,
            revision=1,
        )
        await session.commit()
    async with factory() as session:
        assert (await store.owned(session, machine.id, "owner-a")).id == machine.id
        assert await store.owned(session, machine.id, "owner-b") is None
        assert (await store.live_for_owner(session, "owner-a")).id == machine.id
        assert await store.live_for_owner(session, "owner-b") is None
        assert (await store.locked(session, machine.id)).id == machine.id
        assert await store.locked(session, "missing") is None
        assert await session.get(CloudMachine, machine.id)


async def test_a_machine_is_its_owner_s_in_every_workspace(factory):
    """The machine is global: from a workspace it does not serve, it is still
    the owner's, and that workspace has no row on it."""
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        await session.commit()
    with tenant_scope(TENANT_B):
        async with factory() as session:
            assert (await store.live_for_owner(session, "owner-a")).id == machine.id
            assert (await store.owned(session, machine.id, "owner-a")).id == machine.id
            assert await workspace_on(session, machine.id) is None
        assert counted(await workspaces_on(factory, machine.id)) == [
            (TENANT_ZERO_ID, None, 0)
        ]


async def test_joining_from_another_workspace_reuses_the_machine(factory):
    first, here = await claim_both(factory, "owner-a")
    observed = datetime.now(UTC)
    async with factory() as session:
        row = await CloudMachineStore().get(session, first.id)
        row.state = "ready"
        row.running_observed_at = observed
        await session.commit()

    machine, there = await claim_in(factory, TENANT_B, "owner-a")
    assert machine.id == first.id
    assert there.id != here.id
    assert (
        there.tenant_id,
        there.machine_id,
        there.owner_id,
        there.controller_id,
    ) == (TENANT_B, machine.id, "owner-a", None)
    # Joined, it is prepared again with a controller for the new workspace.
    assert (
        machine.state,
        machine.desired_state,
        machine.revision,
        machine.running_observed_at,
    ) == ("provisioning", "running", 2, None)
    assert await tenants_of_cloud_machine(factory, machine.id) == [
        TENANT_ZERO_ID,
        TENANT_B,
    ]
    assert [workspace.id for workspace in await workspaces_on(factory, machine.id)] == [
        here.id,
        there.id,
    ]

    again, same = await claim_in(factory, TENANT_B, "owner-a")
    assert (again.id, same.id, again.revision) == (machine.id, there.id, 2)
    back, home = await claim_both(factory, "owner-a")
    assert (back.id, home.id, back.revision) == (machine.id, here.id, 2)


@pytest.mark.parametrize(
    ("state", "desired_state", "stop_reason"),
    [
        ("stopped", "stopped", "idle"),
        ("stopped", "stopped", "owner"),
        ("retained", "retained", None),
    ],
)
async def test_joining_a_machine_at_rest_starts_it_once(
    factory, state, desired_state, stop_reason
):
    seeded = await seed(
        factory,
        owner_id="owner-a",
        state=state,
        desired_state=desired_state,
        stop_reason=stop_reason,
        revision=3,
    )
    if desired_state == "retained":
        async with factory() as session:
            row = await CloudMachineStore().get(session, seeded.id)
            row.retain_until = datetime.now(UTC) + timedelta(days=3)
            await session.commit()
    machine, workspace = await claim_in(factory, TENANT_B, "owner-a")
    assert (
        machine.id,
        machine.desired_state,
        machine.stop_reason,
        machine.retain_until,
        machine.revision,
    ) == (seeded.id, "running", None, None, 4)
    assert workspace.tenant_id == TENANT_B


async def test_capacity_counts_machines_in_every_workspace(factory):
    await claim_both(factory, "owner-a", capacity=1)
    with pytest.raises(CloudMachineConflict) as raised:
        await claim_in(factory, TENANT_B, "owner-b", capacity=1)
    assert str(raised.value) == MACHINES_FULL
    # Joining takes no machine of its own.
    machine, _workspace = await claim_in(factory, TENANT_B, "owner-a", capacity=1)
    assert machine.owner_id == "owner-a"


async def test_a_machine_serves_at_most_eight_workspaces(factory):
    machine = await claim(factory, "owner-a")
    joined, refused = OTHER_WORKSPACES[:-1], OTHER_WORKSPACES[-1]
    for tenant_id in joined:
        await claim_in(factory, tenant_id, "owner-a")
    assert len(await tenants_of_cloud_machine(factory, machine.id)) == (
        MAX_MACHINE_WORKSPACES
    )
    with pytest.raises(CloudMachineConflict) as raised:
        await claim_in(factory, refused, "owner-a")
    assert str(raised.value) == MACHINE_WORKSPACES_FULL
    assert refused not in await tenants_of_cloud_machine(factory, machine.id)
    # A workspace it already serves still has it.
    again, _workspace = await claim_in(factory, joined[0], "owner-a")
    assert again.id == machine.id


async def test_a_machine_is_empty_only_once_no_workspace_has_an_agent(factory):
    store = CloudMachineStore()
    async with factory() as session:
        machine = await ready_machine(session)
        mine = await link_controller(session, machine)
        here = await place_managed_agent(
            session, owner_id="owner-a", controller_id=mine.id, name="here"
        )
        await session.commit()
    with tenant_scope(TENANT_B):
        async with factory() as session:
            await add_workspace(
                session, machine, created_at=datetime.now(UTC) + timedelta(seconds=1)
            )
            theirs = await link_controller(session, machine)
            there = [
                await place_managed_agent(
                    session, owner_id="owner-a", controller_id=theirs.id, name=name
                )
                for name in ("there-1", "there-2")
            ]
            await session.commit()
    workspaces = await workspaces_on(factory, machine.id)
    assert counted(workspaces) == [
        (TENANT_ZERO_ID, mine.id, 1),
        (TENANT_B, theirs.id, 2),
    ]
    now = datetime.now(UTC)
    assert not await store.retain_if_empty(
        machine, workspaces, retention_days=7, now=now
    )

    async with factory() as session:
        await session.delete(await session.get(AgentDefinition, here.id))
        await session.commit()
    workspaces = await workspaces_on(factory, machine.id)
    assert counted(workspaces) == [
        (TENANT_ZERO_ID, mine.id, 0),
        (TENANT_B, theirs.id, 2),
    ]
    assert not await store.retain_if_empty(
        machine, workspaces, retention_days=7, now=now
    )
    assert machine.desired_state == "running"

    with tenant_scope(TENANT_B):
        async with factory() as session:
            for definition in there:
                await session.delete(await session.get(AgentDefinition, definition.id))
            await session.commit()
    workspaces = await workspaces_on(factory, machine.id)
    assert ever_hosted(workspaces)
    assert await store.retain_if_empty(machine, workspaces, retention_days=7, now=now)
    assert (machine.desired_state, machine.retain_until) == (
        "retained",
        now + timedelta(days=7),
    )
