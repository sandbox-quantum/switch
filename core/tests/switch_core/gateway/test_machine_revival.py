"""A user keeps one cloud machine id for life. After clean-up, their next
claim brings the same row back, so the box made for it matches the namespace
they already have. Against Postgres, with real agent management."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Literal

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import (
    AgentController,
    ApiKey,
    CloudMachine,
    ServerAuditEvent,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineConflict,
    CloudMachineStore,
    RevokeController,
    lock_claims,
    workspace_on,
)
from switch_core.gateway import cloud_controllers
from switch_core.gateway.cloud_controllers import (
    revoke_machine_controller,
    set_cloud_enrollment,
)
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _connected,
    _enroll,
    _hosted_app,
    _prepare,
    _update,
    _workspace,
)
from tests.switch_core.hosted_machine_helpers import add_tenant
from tests.switch_core.management.harness import Harness, add_member, build_harness
from tests.telemetry_records import RecordingSink, recording_telemetry


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Iterator[None]:
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


@pytest.fixture
def reported(monkeypatch: pytest.MonkeyPatch) -> RecordingSink:
    """What a controller's status reports send."""
    service, sink = recording_telemetry()
    monkeypatch.setattr(cloud_controllers, "current_telemetry", lambda: service)
    return sink


async def _claim(
    factory: async_sessionmaker[AsyncSession],
    owner: User,
    revoke: RevokeController | None = revoke_machine_controller,
    backend: Literal["vm", "box"] = "vm",
) -> CloudMachine:
    async with factory() as session:
        await lock_claims(session)
        claimed = await CloudMachineStore().claim(
            session,
            factory,
            owner_id=owner.id,
            capacity=5,
            now=datetime.now(UTC),
            revoke=revoke,
            backend=backend,
        )
        machine = claimed.machine
        await session.commit()
        return machine


async def _cleaned_up(
    factory: async_sessionmaker[AsyncSession], machine_id: str
) -> None:
    """What the retention sweep and the operator's report leave behind."""
    async with factory() as session:
        machine = await CloudMachineStore().locked(session, machine_id)
        assert machine is not None
        machine.desired_state = "deleted"
        machine.state = "deleted"
        await session.commit()


async def _enrolled_machine(
    harness: Harness, owner: User, backend: Literal["vm", "box"] = "vm"
) -> tuple[str, str]:
    """A machine whose controller enrolled: (machine id, controller id). A
    box needs v2 on to be prepared."""
    factory = harness.session_factory
    machine = await _claim(factory, owner, backend=backend)
    async with _hosted_app(factory, owner) as hosted:
        [entry] = (await _prepare(hosted, machine.id))["controllers"]
    async with harness.client() as client:
        enrolled = await _enroll(client, entry["enrollment_code"])
    return machine.id, str(enrolled["controller_id"])


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_cleaned_up_machine_comes_back_with_its_id_and_nothing_old(
    harness: Harness,
) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, controller_id = await _enrolled_machine(harness, owner)
    async with factory() as session:
        before = await session.get(CloudMachine, machine_id)
        assert before is not None
        old_revision = before.revision
        controller = await session.get(AgentController, controller_id)
        assert controller is not None and controller.api_key_id is not None
        old_key = controller.api_key_id
    await _cleaned_up(factory, machine_id)

    revived = await _claim(factory, owner)

    assert revived.id == machine_id  # one id for life
    assert revived.backend == "box"  # box provisioning makes its box
    assert revived.state == "queued" and revived.desired_state == "running"
    assert revived.revision > old_revision
    assert revived.heartbeat is None and revived.error_code is None
    async with factory() as session:
        machines = list(
            await session.scalars(
                select(CloudMachine).where(CloudMachine.owner_id == owner.id)
            )
        )
        assert [m.id for m in machines] == [machine_id]  # revived, not duplicated
        controller = await session.get(
            AgentController, controller_id, populate_existing=True
        )
        assert controller is not None and controller.revoked_at is not None
        assert await session.get(ApiKey, old_key) is None  # its credential is gone
    workspace = await _workspace(factory, machine_id)
    # The revoked id stays, so the new controller's enrolment moves the
    # owner's agents across; the stored code is forgotten.
    assert workspace.controller_id == controller_id
    assert workspace.enrollment_code_encrypted is None
    async with factory() as session:
        [entry] = list(
            await session.scalars(
                select(ServerAuditEvent).where(
                    ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REVIVED
                )
            )
        )
    assert entry.actor_user_id is None
    assert entry.details == {"by": "core", "machine_id": machine_id}
    assert owner.email not in repr(entry.details)

    # The box enrols afresh: prepare hands over a new code, not the old controller.
    async with _hosted_app(factory, owner) as hosted:
        [fresh] = (await _prepare(hosted, machine_id))["controllers"]
    assert fresh["id"] is None and fresh["enrollment_code"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_paused_owner_revives_nothing(harness: Harness) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, _controller_id = await _enrolled_machine(harness, owner)
    await _cleaned_up(factory, machine_id)
    async with factory() as session:
        user = await session.get(User, owner.id)
        assert user is not None
        user.hosted_paused_at = datetime.now(UTC)
        await session.commit()
    with pytest.raises(CloudMachineConflict):
        await _claim(factory, owner)
    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None and machine.state == "deleted"


async def test_a_revived_machine_is_claimed_as_new(harness: Harness) -> None:
    """The owner had no live machine, so the claim reports `new`, as a new
    row would, for telemetry and the machine events metric."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, _controller_id = await _enrolled_machine(harness, owner)
    await _cleaned_up(factory, machine_id)
    async with factory() as session:
        await lock_claims(session)
        claimed = await CloudMachineStore().claim(
            session,
            factory,
            owner_id=owner.id,
            capacity=5,
            now=datetime.now(UTC),
            revoke=revoke_machine_controller,
        )
        await session.commit()
    assert claimed.machine.id == machine_id
    assert claimed.change == "new"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_revived_box_is_ready_as_new_and_timed_from_its_revival(
    harness: Harness, reported: RecordingSink
) -> None:
    """A revived row is a new box: its first ready counts as `new`, with its
    provisioning time from the revival, not the row's whole life."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, _controller_id = await _enrolled_machine(harness, owner)
    long_ago = datetime.now(UTC) - timedelta(days=30)
    await _update(factory, machine_id, created_at=long_ago, first_ready_at=long_ago)
    await _cleaned_up(factory, machine_id)

    revived = await _claim(factory, owner)
    assert revived.id == machine_id
    assert revived.first_ready_at is None

    async with _hosted_app(factory, owner) as hosted:
        [entry] = (await _prepare(hosted, machine_id))["controllers"]
    await _update(
        factory,
        machine_id,
        state="provisioning",
        running_observed_at=datetime.now(UTC),
    )
    async with harness.client() as client:
        enrolled = await _enroll(client, entry["enrollment_code"])
        await _connected(client, harness, owner, enrolled)

    [ready] = reported.events("cloud_machine_ready")
    assert ready["new_machine"] is True
    assert 0 <= ready["provisioning_seconds"] < 3600
    async with factory() as session:
        row = await session.get(CloudMachine, machine_id)
        assert row is not None and row.first_ready_at is not None


async def test_without_v0_a_new_row_is_made_as_before(harness: Harness) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, _controller_id = await _enrolled_machine(harness, owner)
    await _cleaned_up(factory, machine_id)
    fresh = await _claim(factory, owner, revoke=None)
    assert fresh.id != machine_id


async def test_another_owners_cleaned_up_machine_is_never_revived(
    harness: Harness,
) -> None:
    factory = harness.session_factory
    ada = await add_member(factory, "ada")
    bob = await add_member(factory, "bob")
    machine_id, _controller_id = await _enrolled_machine(harness, ada)
    await _cleaned_up(factory, machine_id)
    bobs = await _claim(factory, bob)
    assert bobs.id != machine_id
    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        assert machine.owner_id == ada.id and machine.state == "deleted"


async def test_a_workspace_the_owner_left_loses_its_row(harness: Harness) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    async with factory() as session:
        await add_tenant(session, "tenant-b")
        await session.commit()
    with tenant_scope("tenant-b"):
        async with factory() as session:
            session.add(
                TenantMember(tenant_id="tenant-b", user_id=owner.id, role="member")
            )
            await session.commit()
    machine = await _claim(factory, owner)
    with tenant_scope("tenant-b"):
        joined = await _claim(factory, owner)
    assert joined.id == machine.id
    await _cleaned_up(factory, machine.id)
    with tenant_scope("tenant-b"):
        async with factory() as session:
            await session.execute(
                delete(TenantMember).where(
                    TenantMember.tenant_id == "tenant-b",
                    TenantMember.user_id == owner.id,
                )
            )
            await session.commit()

    revived = await _claim(factory, owner)

    assert revived.id == machine.id
    with tenant_scope("tenant-b"):
        async with factory() as session:
            assert await workspace_on(session, machine.id) is None
    assert (await _workspace(factory, machine.id)).machine_id == machine.id


async def test_a_v0_claim_marks_a_new_machine_as_a_box(harness: Harness) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    async with factory() as session:
        await lock_claims(session)
        claimed = await CloudMachineStore().claim(
            session,
            factory,
            owner_id=owner.id,
            capacity=5,
            now=datetime.now(UTC),
            revoke=revoke_machine_controller,
            backend="box",
        )
        machine = claimed.machine
        await session.commit()
    assert machine.backend == "box"
    # Without box provisioning, a new machine is a v1 one, as every row before it.
    other = await add_member(factory, "bob")
    assert (await _claim(factory, other, revoke=None)).backend == "vm"


async def _expire_retention(harness: Harness, machine_id: str) -> None:
    """Run the sweep's retention step on a machine retained past its date."""
    from switch_core.db.stores.hosted_machine_store import workspaces_on
    from switch_core.gateway.hosted_controller import _sweep

    factory = harness.session_factory
    now = datetime.now(UTC)
    async with factory() as session:
        machine = await CloudMachineStore().locked(session, machine_id)
        assert machine is not None
        machine.state = "retained"
        machine.desired_state = "retained"
        machine.retain_until = now - timedelta(minutes=1)
        await session.commit()
    async with factory() as session:
        machine = await CloudMachineStore().locked(session, machine_id)
        assert machine is not None
        await _sweep(
            session,
            machine,
            await workspaces_on(factory, machine_id),
            0,
            7,
            now,
            factory,
        )
        await session.commit()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_deleted_at_retention_has_its_controller_revoked(
    harness: Harness,
) -> None:
    """A deleted box keeps its disk, which holds its controller credential and
    sealed logins: deleting the machine revokes the controller, so Core
    forgets the credential and a copy left on the disk is refused."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, controller_id = await _enrolled_machine(harness, owner, "box")
    async with factory() as session:
        controller = await session.get(AgentController, controller_id)
        assert controller is not None and controller.api_key_id is not None
        old_key = controller.api_key_id
        tenant_id = controller.tenant_id
    controllers = AgentControllerStore()
    async with tenant_session(factory, tenant_id) as scoped:
        await controllers.put_sealed_login(
            scoped,
            tenant_id,
            controller_id,
            "claude",
            {"sealed": "made-up"},
            owner.id,
        )
        await scoped.commit()

    await _expire_retention(harness, machine_id)

    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None and machine.desired_state == "deleted"
        controller = await session.get(
            AgentController, controller_id, populate_existing=True
        )
        assert controller is not None and controller.revoked_at is not None
        assert controller.revoked_by is None
        assert await session.get(ApiKey, old_key) is None
    async with tenant_session(factory, tenant_id) as scoped:
        assert await controllers.sealed_logins(scoped, tenant_id, controller_id) == []
    async with factory() as session:
        controller = await session.get(AgentController, controller_id)
        assert controller is not None
        first_revoked_at = controller.revoked_at

    # A second pass over it is a no-op: no error, not revoked again.
    await _expire_retention(harness, machine_id)
    async with factory() as session:
        controller = await session.get(
            AgentController, controller_id, populate_existing=True
        )
        assert controller is not None and controller.revoked_at == first_revoked_at


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_deleted_at_retention_with_its_controller_already_revoked(
    harness: Harness,
) -> None:
    """Already revoked (a pause, say): deleting the machine is a no-op for it,
    apart from clearing a pause's mark, as any later revoke does."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, controller_id = await _enrolled_machine(harness, owner, "box")
    async with factory() as session:
        controller = await session.get(AgentController, controller_id)
        assert controller is not None
        tenant_id = controller.tenant_id
    async with tenant_session(factory, tenant_id) as scoped:
        await harness.management.service.revoke_controllers(
            scoped, tenant_id, [controller_id], revoked_by="pause"
        )
        await scoped.commit()
    async with factory() as session:
        controller = await session.get(AgentController, controller_id)
        assert controller is not None and controller.revoked_at is not None
        revoked_at = controller.revoked_at

    await _expire_retention(harness, machine_id)

    async with factory() as session:
        controller = await session.get(
            AgentController, controller_id, populate_existing=True
        )
        assert controller is not None
        assert controller.revoked_at == revoked_at  # not revoked again
        assert controller.revoked_by is None  # the pause's mark is cleared


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_v1_machine_deleted_at_retention_keeps_its_controller_as_before(
    harness: Harness,
) -> None:
    """A v1 machine's disk goes with it, so its deletion is as before: no
    revoke here."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, controller_id = await _enrolled_machine(harness, owner)
    async with factory() as session:
        machine = await CloudMachineStore().locked(session, machine_id)
        assert machine is not None
        machine.backend = "vm"
        await session.commit()

    await _expire_retention(harness, machine_id)

    async with factory() as session:
        controller = await session.get(
            AgentController, controller_id, populate_existing=True
        )
        assert controller is not None and controller.revoked_at is None

    # Its `stopped` is not its deletion, and it lists no disk for removal.
    await _report_stopped(factory, machine_id)
    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None and machine.state == "stopped"
    assert await _box_to_remove(factory) == []


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_deleted_at_retention_and_at_zero_is_revived_on_the_next_claim(
    harness: Harness,
) -> None:
    """The real path, not a hand-set `deleted`: retention marks it deleted, the
    box scaler's `stopped` at 0 makes Core count it deleted and list its disk
    for removal, and the owner's next claim brings the same row back and
    cancels that entry, so the runbook never removes a live box's disk."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine_id, _controller_id = await _enrolled_machine(harness, owner, "box")
    await _expire_retention(harness, machine_id)
    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None and machine.desired_state == "deleted"
        assert machine.state != "deleted"  # the box scaler never reports it

    await _report_stopped(factory, machine_id)

    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None and machine.state == "deleted"
    [entry] = await _box_to_remove(factory)
    assert entry.details is not None and entry.details["machine_id"] == machine_id

    revived = await _claim(factory, owner)

    assert revived.id == machine_id
    assert revived.state == "queued" and revived.desired_state == "running"
    [still] = await _box_to_remove(factory)  # the log is append-only
    [cancel] = await _box_to_remove(
        factory, ServerAuditAction.HOSTED_BOX_TO_REMOVE_CANCELLED
    )
    assert (cancel.target_type, cancel.target_id, cancel.details) == (
        still.target_type,
        still.target_id,
        still.details,
    )
    assert cancel.occurred_at >= still.occurred_at


async def _report_stopped(
    factory: async_sessionmaker[AsyncSession], machine_id: str
) -> None:
    """The controller's `stopped` report for the machine's current revision,
    as the box scaler sends it once a box is at 0."""
    from switch_core.gateway.hosted_controller import Observation, observe

    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        revision = machine.revision
    async with factory() as session:
        await observe(
            machine_id,
            Observation(state="stopped", revision=revision),
            session,
            factory,
            # Read only for a missing box, never on a `stopped` report.
            config=None,  # type: ignore[arg-type]
            settings=None,  # type: ignore[arg-type]
        )


async def _box_to_remove(
    factory: async_sessionmaker[AsyncSession],
    action: ServerAuditAction = ServerAuditAction.HOSTED_BOX_TO_REMOVE,
) -> list[ServerAuditEvent]:
    async with factory() as session:
        return list(
            await session.scalars(
                select(ServerAuditEvent).where(ServerAuditEvent.action == action)
            )
        )
