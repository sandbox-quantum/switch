"""A hosted agents v2 box runs one agent controller, so it serves one workspace,
for now: a second workspace's claim is refused up front, with the first
workspace's name for its own member, and a box serving only workspaces its
owner has left is retired rather than handed on. Against Postgres."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    CloudMachine,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.hosted_machine_store import (
    BOX_ONE_WORKSPACE,
    BOX_ONE_WORKSPACE_CODE,
    BOX_RETIRING,
    BoxRetired,
    BoxServesAnotherWorkspace,
    CloudMachineStore,
    lock_claims,
    workspace_on,
)
from switch_core.gateway import hosted_machines
from switch_core.tenant_context import tenant_scope
from tests.switch_core.hosted_machine_helpers import add_tenant, add_workspace
from tests.switch_core.management.harness import Harness, add_member, build_harness

TENANT_B = "tenant-b"


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _claim(
    factory: async_sessionmaker[AsyncSession],
    owner: User,
    *,
    commit_refusal: bool = False,
) -> CloudMachine:
    """The owner's box claimed in the bound workspace. A refusal is raised;
    with `commit_refusal`, what the claim changed is committed first, as the
    ensure route does for `BoxRetired`."""
    async with factory() as session:
        await lock_claims(session)
        try:
            claimed = await CloudMachineStore().claim(
                session,
                factory,
                owner_id=owner.id,
                capacity=5,
                now=datetime.now(UTC),
                backend="box",
            )
        except BoxRetired:
            if commit_refusal:
                await session.commit()
            raise
        await session.commit()
        return claimed.machine


async def _member_of(
    factory: async_sessionmaker[AsyncSession], owner: User, tenant_id: str
) -> None:
    async with factory() as session:
        if await session.get(Tenant, tenant_id) is None:
            await add_tenant(session, tenant_id)
            await session.commit()
    with tenant_scope(tenant_id):
        async with factory() as session:
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=owner.id, role="member")
            )
            await session.commit()


async def _leave(
    factory: async_sessionmaker[AsyncSession], owner: User, tenant_id: str
) -> None:
    with tenant_scope(tenant_id):
        async with factory() as session:
            await session.execute(
                delete(TenantMember).where(
                    TenantMember.tenant_id == tenant_id,
                    TenantMember.user_id == owner.id,
                )
            )
            await session.commit()


async def _machine(
    factory: async_sessionmaker[AsyncSession], machine_id: str
) -> CloudMachine:
    async with factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        return machine


async def _zero_name(factory: async_sessionmaker[AsyncSession]) -> str:
    async with factory() as session:
        tenant = await session.get(Tenant, TENANT_ZERO_ID)
        assert tenant is not None
        return tenant.name


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_second_workspace_is_refused_up_front_with_the_first_ones_name(
    harness: Harness,
) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    await _member_of(factory, owner, TENANT_B)
    box = await _claim(factory, owner)
    before = await _machine(factory, box.id)

    with tenant_scope(TENANT_B), pytest.raises(BoxServesAnotherWorkspace) as refused:
        await _claim(factory, owner)

    assert str(refused.value) == BOX_ONE_WORKSPACE
    assert refused.value.code == BOX_ONE_WORKSPACE_CODE
    assert refused.value.workspace_name == await _zero_name(factory)
    # Nothing moved: no revision bump, no wait, no row in tenant-b.
    after = await _machine(factory, box.id)
    assert (after.revision, after.state, after.desired_state) == (
        before.revision,
        before.state,
        before.desired_state,
    )
    with tenant_scope(TENANT_B):
        async with factory() as session:
            assert await workspace_on(session, box.id) is None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_first_workspace_is_unaffected(harness: Harness) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    await _member_of(factory, owner, TENANT_B)
    box = await _claim(factory, owner)
    with tenant_scope(TENANT_B), pytest.raises(BoxServesAnotherWorkspace):
        await _claim(factory, owner)

    again = await _claim(factory, owner)

    assert again.id == box.id
    assert again.desired_state == "running"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_already_serving_two_workspaces_keeps_serving_both(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    """Rows from before the rule: a claim from either workspace isn't a join,
    so neither is refused."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    await _member_of(factory, owner, TENANT_B)
    box = await _claim(factory, owner)
    with tenant_scope(TENANT_B):
        async with factory() as session:
            machine = await session.get(CloudMachine, box.id)
            assert machine is not None
            await add_workspace(session, machine, created_at=datetime.now(UTC))
            await session.commit()

    with tenant_scope(TENANT_B):
        there = await _claim(factory, owner)
    here = await _claim(factory, owner)

    assert there.id == here.id == box.id
    # Said each time, with the count, for knowing whether any exist.
    said = [
        r.getMessage()
        for r in caplog.records
        if "serving 2 workspaces" in r.getMessage()
    ]
    assert len(said) == 2


@pytest.mark.usefixtures("hosted_v2_on")
async def test_once_the_owner_left_the_first_workspace_the_box_is_retired_not_handed_on(
    harness: Harness,
) -> None:
    """The refusal holds only while the box serves a workspace its owner is in.
    Once they've left it, the box isn't joined by the next workspace (its disk
    holds the first one's): it's retired, and the claim after its removal gets
    a new box rather than reviving this one."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    await _member_of(factory, owner, TENANT_B)
    box = await _claim(factory, owner)
    await _leave(factory, owner, TENANT_ZERO_ID)

    with tenant_scope(TENANT_B), pytest.raises(BoxRetired) as retired:
        await _claim(factory, owner, commit_refusal=True)

    assert str(retired.value) == BOX_RETIRING
    machine = await _machine(factory, box.id)
    assert machine.desired_state == "deleted"
    with tenant_scope(TENANT_B):
        async with factory() as session:
            assert await workspace_on(session, box.id) is None

    # The box scaler takes it to 0 and Core counts it deleted.
    async with factory() as session:
        row = await CloudMachineStore().locked(session, box.id)
        assert row is not None
        row.state = "deleted"
        await session.commit()

    with tenant_scope(TENANT_B):
        fresh = await _claim(factory, owner)

    assert fresh.id != box.id
    assert (await _machine(factory, box.id)).state == "deleted"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_deleted_box_comes_back_only_in_the_workspace_it_served(
    harness: Harness,
) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    await _member_of(factory, owner, TENANT_B)
    box = await _claim(factory, owner)
    async with factory() as session:
        row = await CloudMachineStore().locked(session, box.id)
        assert row is not None
        row.desired_state = "deleted"
        row.state = "deleted"
        await session.commit()

    # Another workspace: a new box, never this one's disk.
    with tenant_scope(TENANT_B):
        elsewhere = await _claim(factory, owner)
    assert elsewhere.id != box.id
    assert (await _machine(factory, box.id)).state == "deleted"
    # The first workspace's row is left as it was.
    assert await _row_id(factory, box.id)


async def _row_id(factory: async_sessionmaker[AsyncSession], machine_id: str) -> str:
    async with factory() as session:
        row = await workspace_on(session, machine_id)
        assert row is not None
        return row.id


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_v1_machine_still_joins_a_second_workspace(harness: Harness) -> None:
    """The rule is a box's: a v1 machine runs a controller per workspace."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    await _member_of(factory, owner, TENANT_B)
    async with factory() as session:
        await lock_claims(session)
        first = await CloudMachineStore().claim(
            session, factory, owner_id=owner.id, capacity=5, now=datetime.now(UTC)
        )
        await session.commit()
    with tenant_scope(TENANT_B):
        async with factory() as session:
            await lock_claims(session)
            joined = await CloudMachineStore().claim(
                session, factory, owner_id=owner.id, capacity=5, now=datetime.now(UTC)
            )
            await session.commit()
    assert first.machine.backend == "vm"
    assert (joined.machine.id, joined.change) == (first.machine.id, "joined_workspace")


async def test_the_ensure_route_answers_409_with_the_code_and_the_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def refused(*_args: object) -> object:
        raise BoxServesAnotherWorkspace("Design team")

    monkeypatch.setattr(hosted_machines, "ensure_machine", refused)

    answer = await hosted_machines.ensure(
        SimpleNamespace(id="u1"),
        None,
        None,
        None,
        None,  # type: ignore[arg-type]
    )

    assert answer.status_code == 409  # type: ignore[union-attr]
    assert json.loads(answer.body) == {  # type: ignore[union-attr]
        "detail": BOX_ONE_WORKSPACE,
        "code": "box_one_workspace",
        "workspace_name": "Design team",
    }


async def test_the_ensure_route_leaves_the_name_out_when_it_is_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def refused(*_args: object) -> object:
        raise BoxServesAnotherWorkspace(None)

    monkeypatch.setattr(hosted_machines, "ensure_machine", refused)

    answer = await hosted_machines.ensure(
        SimpleNamespace(id="u1"),
        None,
        None,
        None,
        None,  # type: ignore[arg-type]
    )

    assert json.loads(answer.body) == {  # type: ignore[union-attr]
        "detail": BOX_ONE_WORKSPACE,
        "code": "box_one_workspace",
    }
