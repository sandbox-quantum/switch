"""The enrolment code: Core keeps an encrypted copy of
a cloud machine's code only while the code can still enrol. It's cleared when
the code is used, and by the sweep once it has expired. Against Postgres.

The copy's value is never read here: only whether it's there."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import AgentControllerEnrollmentCode
from switch_core.gateway.cloud_controllers import (
    clear_spent_codes,
    set_cloud_enrollment,
)
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _claim,
    _enroll,
    _hosted_app,
    _prepare,
    _workspace,
)
from tests.switch_core.management.harness import Harness, add_member, build_harness


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Iterator[None]:
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _make_box(factory, machine_id: str) -> None:
    from switch_core.db.models import CloudMachine

    async with factory() as session:
        await session.execute(
            update(CloudMachine)
            .where(CloudMachine.id == machine_id)
            .values(backend="box")
        )
        await session.commit()


async def test_a_v1_machines_copy_is_kept_when_the_code_is_used(
    harness: Harness,
) -> None:
    """The v1/v2 switch (sweep row 19): as upstream, a v1 machine's copy stays."""
    factory = harness.session_factory
    owner = await add_member(factory, "vee")
    machine = await _claim(factory, owner)
    async with _hosted_app(factory, owner) as hosted:
        [entry] = (await _prepare(hosted, machine.id))["controllers"]
    async with harness.client() as client:
        await _enroll(client, entry["enrollment_code"])
    workspace = await _workspace(factory, machine.id)
    assert workspace.enrollment_code_encrypted is not None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_copy_is_cleared_when_the_code_is_used(harness: Harness) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine = await _claim(factory, owner)
    await _make_box(factory, machine.id)  # a v2 box's only (sweep row 19)
    async with _hosted_app(factory, owner) as hosted:
        [entry] = (await _prepare(hosted, machine.id))["controllers"]
    workspace = await _workspace(factory, machine.id)
    assert workspace.enrollment_code_encrypted is not None
    assert workspace.enrollment_code_revision is not None
    async with harness.client() as client:
        enrolled = await _enroll(client, entry["enrollment_code"])
    workspace = await _workspace(factory, machine.id)
    assert workspace.controller_id == enrolled["controller_id"]
    assert workspace.enrollment_code_encrypted is None
    assert workspace.enrollment_code_revision is None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_sweep_clears_an_expired_code_and_keeps_a_live_one(
    harness: Harness,
) -> None:
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine = await _claim(factory, owner)
    # Fifteen-minute codes are a v2 box's (a v1 machine's live 30, as upstream).
    await _make_box(factory, machine.id)
    async with _hosted_app(factory, owner) as hosted:
        await _prepare(hosted, machine.id)
    now = datetime.now(UTC)
    # A live code's copy stays: a retried prepare hands the same code over.
    assert await clear_spent_codes(factory, machine.id, now) == 0
    assert (await _workspace(factory, machine.id)).enrollment_code_encrypted
    # Fifteen minutes on, the code is dead, and so is the copy.
    later = now + timedelta(minutes=15, seconds=1)
    assert await clear_spent_codes(factory, machine.id, later) == 1
    workspace = await _workspace(factory, machine.id)
    assert workspace.enrollment_code_encrypted is None
    assert workspace.enrollment_code_revision is None
    # Nothing left to clear.
    assert await clear_spent_codes(factory, machine.id, later) == 0


async def test_the_sweep_clears_a_retired_code(harness: Harness) -> None:
    """A code whose key is gone (retired, or used elsewhere) can't enrol."""
    factory = harness.session_factory
    owner = await add_member(factory, "ada")
    machine = await _claim(factory, owner)
    async with _hosted_app(factory, owner) as hosted:
        await _prepare(hosted, machine.id)
    workspace = await _workspace(factory, machine.id)
    async with factory() as session:
        await session.execute(
            update(AgentControllerEnrollmentCode)
            .where(AgentControllerEnrollmentCode.machine_workspace_id == workspace.id)
            .values(used_at=datetime.now(UTC))
        )
        await session.commit()
    assert await clear_spent_codes(factory, machine.id, datetime.now(UTC)) == 1
    assert (await _workspace(factory, machine.id)).enrollment_code_encrypted is None
