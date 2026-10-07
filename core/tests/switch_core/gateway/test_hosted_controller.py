import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.models import (
    HostedMachine,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineStore,
    lock_launches,
)
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_controller import router
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import make_owner
from tests.switch_core.hosted_machine_helpers import LinkingControllers, seed_machine

TOKEN = "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS"
HEADERS = {"Authorization": "Bearer " + TOKEN}
FIXTURES = Path(__file__).parent.parent / "fixtures" / "hosted_machines"
MACHINE_ITEM_KEYS = {
    "machine_id",
    "slot_id",
    "generation",
    "state",
    "desired_state",
    "revision",
    "data_volume_id",
    "retain_until",
    "bundle_revision",
}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
async def controller_app(session_factory):
    """A queued machine for a workspace member, behind the controller routes."""
    owner = await make_owner(session_factory)
    async with session_factory() as session:
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner, role="member")
        )
        machine = await seed_machine(
            session,
            owner_id=owner,
            slot_id="slot-a",
            state="queued",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        machine_id = machine.id
        await session.commit()
    config = SimpleNamespace(
        hosted_idle_stop_minutes=0,
        hosted_disk_retention_days=7,
        controller_status_interval_seconds=60,
    )
    settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        machine_slots=["slot-a", "slot-b"],
        github_private_key_path="/tmp/synthetic-signing-key.pem",
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.include_router(router)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: config
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, machine_id, owner, config, session_factory, settings


async def machine_of(factory, machine_id: str) -> HostedMachine:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        return machine


async def update_machine(factory, machine_id: str, **values) -> None:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


async def list_machines(client) -> list[dict]:
    response = await client.get("/hosted-controller/machines", headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()["machines"]


async def observe(client, machine_id: str, **body) -> dict:
    response = await client.post(
        f"/hosted-controller/machines/{machine_id}/observation",
        headers=HEADERS,
        json=body,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_controller_requires_its_own_credential(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    for method, path, body in (
        ("GET", "/hosted-controller/machines", None),
        ("POST", f"/hosted-controller/machines/{machine.id}/prepare", {}),
        (
            "POST",
            f"/hosted-controller/machines/{machine.id}/observation",
            {"state": "running", "revision": 1},
        ),
    ):
        for token in (None, "Bearer wrong"):
            response = await client.request(
                method,
                path,
                headers={} if token is None else {"Authorization": token},
                json=body,
            )
            assert response.status_code == 401
    assert (await machine_of(factory, machine_id)).state == "queued"


async def test_machines_lists_every_live_machine_with_the_contract_keys(
    controller_app,
):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    async with factory() as session:
        gone = await seed_machine(
            session,
            owner_id=machine.owner_id,
            slot_id="slot-b",
            state="deleted",
            desired_state="deleted",
            stop_reason=None,
            revision=3,
            generation=1,
        )
        await session.commit()
    listed = await list_machines(client)
    assert [item["machine_id"] for item in listed] == [machine.id]
    assert gone.id not in {item["machine_id"] for item in listed}
    assert set(listed[0]) == MACHINE_ITEM_KEYS
    assert listed[0] == {
        "machine_id": machine.id,
        "slot_id": "slot-a",
        "generation": 1,
        "state": "queued",
        "desired_state": "running",
        "revision": 1,
        "data_volume_id": None,
        "retain_until": None,
        "bundle_revision": None,
    }


async def test_queued_machine_times_out_with_an_actionable_error(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory, machine.id, updated_at=datetime.now(UTC) - timedelta(minutes=11)
    )
    [item] = await list_machines(client)
    assert item["state"] == "error"
    saved = await machine_of(factory, machine_id)
    assert saved.error_code == "machine_connect_timeout"
    assert "10 minutes" in saved.error
    assert "Retry" in saved.error


async def test_recent_queued_machine_is_left_alone(controller_app):
    client, machine_id, *_ = controller_app
    [item] = await list_machines(client)
    assert item["state"] == "queued"


async def test_running_machine_that_never_connects_times_out(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        running_observed_at=datetime.now(UTC) - timedelta(minutes=11),
    )
    [item] = await list_machines(client)
    assert item["state"] == "error"
    saved = await machine_of(factory, machine_id)
    assert saved.error_code == "machine_connect_timeout"
    assert "10 minutes" in saved.error


async def test_connect_timeout_counts_from_the_running_observation(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        updated_at=datetime.now(UTC) - timedelta(minutes=30),
        running_observed_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(client)
    assert item["state"] == "provisioning"


async def test_provisioning_machine_never_observed_running_times_out(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    before = datetime.now(UTC)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        updated_at=before - timedelta(minutes=11),
    )
    [item] = await list_machines(client)
    assert item["state"] == "error"
    saved = await machine_of(factory, machine_id)
    assert saved.error_code == "machine_connect_timeout"
    assert (
        saved.error
        == "The cloud machine did not start within 10 minutes. Retry it in Switch Console, or contact your administrator if it still cannot start."
    )
    assert saved.updated_at >= before


async def test_recent_provisioning_machine_is_left_alone(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="provisioning",
        updated_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    [item] = await list_machines(client)
    assert item["state"] == "provisioning"


async def test_retention_sweep_deletes_an_expired_retained_machine(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    expired = datetime.now(UTC) - timedelta(seconds=1)
    await update_machine(
        factory,
        machine.id,
        state="retained",
        desired_state="retained",
        retain_until=expired,
        revision=3,
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "deleted"
    assert item["revision"] == 4
    assert item["retain_until"] == expired.isoformat()


async def test_retention_sweep_keeps_a_machine_inside_its_window(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    until = datetime.now(UTC) + timedelta(days=3)
    await update_machine(
        factory,
        machine.id,
        state="retained",
        desired_state="retained",
        retain_until=until,
        revision=3,
    )
    [item] = await list_machines(client)
    assert item["desired_state"] == "retained"
    assert item["revision"] == 3
    assert item["retain_until"] == until.isoformat()


async def test_prepare_refuses_unknown_and_deleted_machines(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    missing = await client.post(
        f"/hosted-controller/machines/{uuid4()}/prepare", headers=HEADERS, json={}
    )
    assert missing.status_code == 404
    machine = await machine_of(factory, machine_id)
    await update_machine(factory, machine.id, desired_state="deleted")
    deleted = await client.post(
        f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS, json={}
    )
    assert deleted.status_code == 409
    assert deleted.json() == {"detail": "machine is deleted"}
    assert (await machine_of(factory, machine_id)).controller_id is None


async def test_prepare_for_a_departed_owner_errors_the_machine(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    async with factory() as session:
        await session.delete(
            await session.get(TenantMember, (require_tenant_id(), machine.owner_id))
        )
        await session.commit()
    response = await client.post(
        f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS, json={}
    )
    assert response.status_code == 409
    saved = await machine_of(factory, machine_id)
    assert saved.state == "error"
    assert "workspace member" in saved.error
    assert saved.controller_id is None


async def test_controller_observation_fixture_is_accepted(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    body = fixture("controller_observation.json")
    await update_machine(
        factory, machine.id, state="provisioning", revision=body["revision"]
    )
    response = await client.post(
        f"/hosted-controller/machines/{machine.id}/observation",
        headers=HEADERS,
        json=body,
    )
    assert response.status_code == 200, response.text
    item = response.json()
    assert set(item) == MACHINE_ITEM_KEYS
    assert item["state"] == "provisioning"
    assert item["data_volume_id"] == body["data_volume_id"]
    saved = await machine_of(factory, machine_id)
    assert saved.instance_id == body["instance_id"]
    assert saved.instance_type == body["instance_type"]
    assert saved.running_observed_at is not None


async def test_observation_rejects_unknown_fields_and_codes(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    path = f"/hosted-controller/machines/{machine.id}/observation"
    for body in (
        {"state": "running", "revision": 1, "surprise": True},
        {"state": "error", "revision": 1, "error_code": "worker_needs_attention"},
        {"state": "sleeping", "revision": 1},
        {"state": "running", "revision": 0},
    ):
        assert (await client.post(path, headers=HEADERS, json=body)).status_code == 422
    missing = await client.post(
        f"/hosted-controller/machines/{uuid4()}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": 1},
    )
    assert missing.status_code == 404


async def test_stale_observation_is_ignored_unless_it_carries_an_error(
    controller_app,
):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="stopping",
        desired_state="stopped",
        stop_reason="owner",
        revision=2,
    )
    ignored = await observe(
        client, machine.id, state="running", revision=1, data_volume_id="vol-stale"
    )
    assert ignored["state"] == "stopping"
    assert ignored["desired_state"] == "stopped"
    assert ignored["data_volume_id"] is None
    ahead = await observe(client, machine.id, state="stopped", revision=3)
    assert ahead["state"] == "stopping"
    recorded = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance could not be stopped.",
        error_code="machine_needs_attention",
    )
    assert recorded["state"] == "error"
    saved = await machine_of(factory, machine_id)
    assert saved.error == "The instance could not be stopped."
    assert saved.error_code == "machine_needs_attention"


@pytest.mark.parametrize("state", ["queued", "provisioning"])
async def test_stale_error_does_not_overwrite_a_newer_retry(controller_app, state):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(factory, machine.id, state=state, revision=2)
    item = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
    )
    assert item["state"] == state
    saved = await machine_of(factory, machine_id)
    assert saved.state == state
    assert saved.error is None
    assert saved.error_code is None


async def test_stale_error_is_recorded_on_a_ready_machine(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(factory, machine.id, state="ready", revision=2)
    item = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
    )
    assert item["state"] == "error"
    assert (
        await machine_of(factory, machine_id)
    ).error == "The instance failed its status checks."


async def test_running_observation_waits_for_a_heartbeat(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(factory, machine.id, state="provisioning")
    first = await observe(client, machine.id, state="running", revision=1)
    assert first["state"] == "provisioning"
    observed = (await machine_of(factory, machine_id)).running_observed_at
    assert observed is not None
    again = await observe(client, machine.id, state="running", revision=1)
    assert again["state"] == "provisioning"
    assert (await machine_of(factory, machine_id)).running_observed_at == observed
    await update_machine(factory, machine.id, state="ready")
    assert (await observe(client, machine.id, state="running", revision=1))[
        "state"
    ] == "ready"
    assert (await observe(client, machine.id, state="provisioning", revision=1))[
        "state"
    ] == "ready"


@pytest.mark.parametrize(
    "state", ["stopping", "stopped", "deleting", "deleted", "retained"]
)
async def test_lifecycle_observations_are_copied(controller_app, state):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(factory, machine.id, state="ready", error_code="disk_full")
    item = await observe(client, machine.id, state=state, revision=1)
    assert item["state"] == state
    assert (await machine_of(factory, machine_id)).error_code is None


async def test_error_observation_is_kept_until_retry(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(factory, machine.id, state="provisioning")
    errored = await observe(
        client,
        machine.id,
        state="error",
        revision=1,
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
    )
    assert errored["state"] == "error"
    for state in ("running", "provisioning", "stopped"):
        assert (await observe(client, machine.id, state=state, revision=1))[
            "state"
        ] == "error"
    saved = await machine_of(factory, machine_id)
    assert saved.error == "The instance failed its status checks."
    assert saved.error_code == "machine_needs_attention"
    defaulted = await observe(client, machine.id, state="error", revision=1)
    assert defaulted["state"] == "error"
    saved = await machine_of(factory, machine_id)
    assert "Retry" in saved.error
    assert saved.error_code is None


@pytest.mark.parametrize("state", ["retained", "deleting", "deleted"])
async def test_retiring_an_errored_machine_replaces_its_error(controller_app, state):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=datetime.now(UTC) + timedelta(days=7),
        revision=2,
    )
    item = await observe(client, machine.id, state=state, revision=2)
    assert item["state"] == state
    saved = await machine_of(factory, machine_id)
    assert saved.error is None
    assert saved.error_code is None


async def test_errored_machine_retained_after_its_last_agent_expires(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=datetime.now(UTC) - timedelta(seconds=1),
        revision=2,
    )
    await observe(client, machine.id, state="retained", revision=2)
    [item] = await list_machines(client)
    assert item["state"] == "retained"
    assert item["desired_state"] == "deleted"
    assert item["revision"] == 3


async def test_retention_sweep_deletes_an_expired_errored_machine(controller_app):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=datetime.now(UTC) - timedelta(seconds=1),
        revision=2,
    )
    [item] = await list_machines(client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "deleted",
        3,
    )
    item = await observe(client, machine.id, state="deleting", revision=3)
    assert item["state"] == "deleting"
    saved = await machine_of(factory, machine_id)
    assert (saved.error, saved.error_code) == (None, None)


async def test_retention_sweep_keeps_an_errored_machine_inside_its_window(
    controller_app,
):
    client, machine_id, _, _, factory, _ = controller_app
    machine = await machine_of(factory, machine_id)
    until = datetime.now(UTC) + timedelta(days=3)
    await update_machine(
        factory,
        machine.id,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        desired_state="retained",
        retain_until=until,
        revision=2,
    )
    [item] = await list_machines(client)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "retained",
        2,
    )
    assert item["retain_until"] == until.isoformat()


def assert_retained_for_a_week(item: dict, before: datetime) -> None:
    retain_until = datetime.fromisoformat(item["retain_until"])
    assert before + timedelta(days=7) <= retain_until
    assert retain_until <= datetime.now(UTC) + timedelta(days=7)


IDLE_SLEEPING = {"state": "stopped", "desired_state": "stopped", "stop_reason": "idle"}


async def _empty_machine(controller_app, **values) -> tuple[str, str]:
    """Another owner's machine that never hosted an agent, quiet for 31 minutes."""
    factory = controller_app[4]
    async with factory() as session:
        owner = User(
            name="empty", email="empty@example.com", role="user", password_hash="x"
        )
        session.add(owner)
        await session.flush()
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            slot_id="slot-b",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        machine.active_at = datetime.now(UTC) - timedelta(minutes=31)
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()
        return machine.id, owner.id


async def _listed(client, machine_id: str) -> dict:
    return {item["machine_id"]: item for item in await list_machines(client)}[
        machine_id
    ]


async def test_an_idle_sleeping_machine_that_hosts_no_agent_keeps_its_disk(
    controller_app,
):
    client, *_ = controller_app
    machine_id, _ = await _empty_machine(controller_app, **IDLE_SLEEPING)
    before = datetime.now(UTC)
    item = await _listed(client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("retained", 2)
    assert_retained_for_a_week(item, before)
    await observe(client, machine_id, state="retained", revision=2)
    assert (await _listed(client, machine_id))["desired_state"] == "retained"


async def test_owner_stopped_empty_machine_is_left_alone(controller_app):
    client, *_ = controller_app
    machine_id, _ = await _empty_machine(
        controller_app, state="stopped", desired_state="stopped", stop_reason="owner"
    )
    item = await _listed(client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("stopped", 1)


async def test_errored_machine_that_hosts_no_agent_keeps_its_disk(controller_app):
    client, _, _, config, _, _ = controller_app
    config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(
        controller_app,
        state="error",
        error="The instance failed its status checks.",
        error_code="machine_needs_attention",
        updated_at=datetime.now(UTC) - timedelta(minutes=31),
    )
    before = datetime.now(UTC)
    item = await _listed(client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "retained",
        2,
    )
    assert_retained_for_a_week(item, before)
    await observe(client, machine_id, state="retained", revision=2)
    item = await _listed(client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "retained",
        "retained",
        2,
    )


async def test_recently_errored_empty_machine_is_left_alone(controller_app):
    client, _, _, config, _, _ = controller_app
    config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(
        controller_app,
        state="error",
        error="The instance failed its status checks.",
        updated_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    item = await _listed(client, machine_id)
    assert (item["state"], item["desired_state"], item["revision"]) == (
        "error",
        "running",
        1,
    )


async def _claim(factory, owner_id: str) -> HostedMachine:
    async with factory() as session:
        await lock_launches(session)
        machine = await HostedMachineStore().claim(
            session,
            owner_id=owner_id,
            slots=["slot-a", "slot-b"],
            capacity=2,
            now=datetime.now(UTC),
            controllers=LinkingControllers(),
        )
        await session.commit()
        return machine


async def test_released_machine_is_revived_or_replaced_by_a_claim(controller_app):
    client, _, _, config, factory, _ = controller_app
    machine_id, owner_id = await _empty_machine(controller_app, **IDLE_SLEEPING)
    assert (await _listed(client, machine_id))["desired_state"] == "retained"
    revived = await _claim(factory, owner_id)
    assert (revived.id, revived.desired_state, revived.retain_until) == (
        machine_id,
        "running",
        None,
    )
    await update_machine(factory, machine_id, state="deleted", desired_state="deleted")
    replaced = await _claim(factory, owner_id)
    assert replaced.id != machine_id
    assert (replaced.slot_id, replaced.desired_state) == ("slot-b", "running")


async def test_idle_stop_is_off_when_the_setting_is_zero(controller_app):
    client, *_ = controller_app
    machine_id, _ = await _empty_machine(controller_app)
    item = await _listed(client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("running", 1)


async def test_only_a_ready_running_machine_is_put_to_sleep(controller_app):
    client, _, _, config, _, _ = controller_app
    config.hosted_idle_stop_minutes = 30
    machine_id, _ = await _empty_machine(controller_app, state="provisioning")
    item = await _listed(client, machine_id)
    assert (item["desired_state"], item["revision"]) == ("running", 1)
