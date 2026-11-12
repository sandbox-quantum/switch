"""A user keeps one cloud machine id for life. After clean-up, their next
claim brings the same row back, so the box made for it matches the namespace
they already have. Against Postgres, with real agent management."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

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
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineConflict,
    CloudMachineStore,
    RevokeController,
    lock_claims,
    workspace_on,
)
from switch_core.gateway.cloud_controllers import (
    revoke_machine_controller,
    set_cloud_enrollment,
)
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _enroll,
    _hosted_app,
    _prepare,
    _workspace,
)
from tests.switch_core.hosted_machine_helpers import add_tenant
from tests.switch_core.management.harness import Harness, add_member, build_harness


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Iterator[None]:
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _claim(
    factory: async_sessionmaker[AsyncSession],
    owner: User,
    revoke: RevokeController | None = revoke_machine_controller,
) -> CloudMachine:
    async with factory() as session:
        await lock_claims(session)
        machine, _workspace = await CloudMachineStore().claim(
            session,
            factory,
            owner_id=owner.id,
            capacity=5,
            now=datetime.now(UTC),
            revoke=revoke,
        )
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


async def _enrolled_machine(harness: Harness, owner: User) -> tuple[str, str]:
    """A machine whose controller enrolled: (machine id, controller id)."""
    factory = harness.session_factory
    machine = await _claim(factory, owner)
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
        machine, _workspace = await CloudMachineStore().claim(
            session,
            factory,
            owner_id=owner.id,
            capacity=5,
            now=datetime.now(UTC),
            revoke=revoke_machine_controller,
            backend="box",
        )
        await session.commit()
    assert machine.backend == "box"
    # Without box provisioning, a new machine is a v1 one, as every row before it.
    other = await add_member(factory, "bob")
    assert (await _claim(factory, other, revoke=None)).backend == "vm"
