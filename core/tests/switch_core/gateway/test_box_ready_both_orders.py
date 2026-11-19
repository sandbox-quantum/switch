"""A v2 box is ready once both signals are in at its revision, whichever comes
second: the scaler's `running` and its controller's status report.

The controller reports as soon as it connects, and the scaler only sees the
box running on its next pass, so the report nearly always comes first. Before,
Core waited a full report interval for the next one; now `running` itself makes
the box ready, if the report already in is from the box's own, unrevoked
controller at this revision (`cloud_controllers.ready_if_both_signals`).
Against Postgres, with real agent management."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.db.models import AgentController, CloudMachine, User
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.cloud_controllers import REPORTED_KEY
from tests.switch_core.gateway.test_cloud_controller_machines import (
    HEADERS,
    _enroll,
    _hosted_app,
    _machine,
    _new_revision,
    _prepare,
    _update,
    reported,  # noqa: F401  (fixture)
)
from tests.switch_core.gateway.test_machine_revival import _claim
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    build_harness,
    report_status,
)
from tests.telemetry_records import RecordingSink


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class Box(SimpleNamespace):
    machine_id: str
    controller: SimpleNamespace
    hosted: httpx.AsyncClient
    client: httpx.AsyncClient


async def _box(harness: Harness, owner: User, hosted, client, backend="box") -> Box:
    """A box machine whose controller enrolled and has a token, but hasn't
    reported yet, and which the scaler hasn't seen running."""
    machine = await _claim(harness.session_factory, owner, backend=backend)
    [entry] = (await _prepare(hosted, machine.id))["controllers"]
    enrolled = await _enroll(client, entry["enrollment_code"])
    token = await client.post(
        f"/v1/management/controllers/{enrolled['controller_id']}/token",
        json={"credential": enrolled["credential"]},
    )
    assert token.status_code == 200, token.text
    controller = SimpleNamespace(
        controller_id=enrolled["controller_id"],
        credential=enrolled["credential"],
        access_token=token.json()["access_token"],
        owner=owner,
        harness=harness,
        headers=bearer(token.json()["access_token"]),
    )
    return Box(
        machine_id=machine.id, controller=controller, hosted=hosted, client=client
    )


async def _running(box: Box) -> None:
    machine = await _machine(box.controller.harness.session_factory, box.machine_id)
    answer = await box.hosted.post(
        f"/hosted-controller/machines/{box.machine_id}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": machine.revision},
    )
    assert answer.status_code == 200, answer.text


async def _report(box: Box, seq: int) -> None:
    answer = await report_status(box.client, box.controller, seq)  # type: ignore[arg-type]
    assert answer.status_code == 200, answer.text


async def _state(harness: Harness, box: Box) -> CloudMachine:
    return await _machine(harness.session_factory, box.machine_id)


@pytest.mark.usefixtures("hosted_v2_on")
async def test_report_first_then_running_is_ready_on_running(
    harness: Harness,
    reported: RecordingSink,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        assert (await _state(harness, box)).state != "ready"  # the report alone
        await _running(box)
        ready = await _state(harness, box)
    assert ready.state == "ready"
    assert ready.first_ready_at is not None
    (event,) = reported.events("cloud_machine_ready")
    assert event["new_machine"] is True


@pytest.mark.usefixtures("hosted_v2_on")
async def test_running_first_then_report_is_ready_on_the_report(
    harness: Harness,
    reported: RecordingSink,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _running(box)
        assert (await _state(harness, box)).state == "provisioning"  # running alone
        await _report(box, 1)
        ready = await _state(harness, box)
    assert ready.state == "ready"
    assert len(reported.events("cloud_machine_ready")) == 1


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_late_running_after_ready_changes_nothing(
    harness: Harness,
    reported: RecordingSink,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        await _running(box)
        first = await _state(harness, box)
        await _running(box)
        await _report(box, 2)
        again = await _state(harness, box)
    assert again.state == "ready"
    assert again.first_ready_at == first.first_ready_at
    assert len(reported.events("cloud_machine_ready")) == 1


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_report_from_before_a_revision_bump_doesnt_count(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        await _new_revision(harness.session_factory, box.machine_id)
        await _running(box)
        assert (await _state(harness, box)).state == "provisioning"
        # A report at the new revision then makes it ready.
        await _report(box, 2)
        assert (await _state(harness, box)).state == "ready"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_controller_revoked_after_reporting_doesnt_count(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client)
        await _report(box, 1)
        factory = harness.session_factory
        async with factory() as session:
            row = await session.get(AgentController, box.controller.controller_id)
            assert row is not None
            tenant_id = row.tenant_id
        async with tenant_session(factory, tenant_id) as scoped:
            await harness.management.service.revoke_controllers(
                scoped, tenant_id, [box.controller.controller_id]
            )
            await scoped.commit()
        await _running(box)
        assert (await _state(harness, box)).state == "provisioning"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_report_recorded_for_another_controller_doesnt_count(
    harness: Harness,
) -> None:
    """The recorded report names a real, live controller that isn't this
    workspace's on this machine (another person's box's): `running` doesn't
    make it ready."""
    ada = await add_member(harness.session_factory, "ada")
    bob = await add_member(harness.session_factory, "bob")
    async with harness.client() as client:
        async with _hosted_app(harness.session_factory, bob) as hosted:
            other = await _box(harness, bob, hosted, client)
        async with _hosted_app(harness.session_factory, ada) as hosted:
            box = await _box(harness, ada, hosted, client)
            await _report(box, 1)
            machine = await _state(harness, box)
            assert machine.heartbeat is not None
            recorded = machine.heartbeat[REPORTED_KEY]
            assert recorded["controller_id"] == box.controller.controller_id
            await _update(
                harness.session_factory,
                box.machine_id,
                heartbeat={
                    **machine.heartbeat,
                    REPORTED_KEY: {
                        **recorded,
                        "controller_id": other.controller.controller_id,
                    },
                },
            )
            await _running(box)
            assert (await _state(harness, box)).state == "provisioning"


async def test_with_v2_off_only_a_report_makes_a_machine_ready(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With v2 off, as before v2: `running` never makes a machine ready, and
    no report is recorded in the heartbeat."""
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    owner = await add_member(harness.session_factory, "ada")
    async with (
        _hosted_app(harness.session_factory, owner) as hosted,
        harness.client() as client,
    ):
        box = await _box(harness, owner, hosted, client, backend="vm")
        await _report(box, 1)
        await _running(box)
        machine = await _state(harness, box)
        assert machine.state == "provisioning"
        assert REPORTED_KEY not in (machine.heartbeat or {})
        await _report(box, 2)
        assert (await _state(harness, box)).state == "ready"
