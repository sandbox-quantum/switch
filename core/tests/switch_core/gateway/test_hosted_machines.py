"""The owner's cloud machine: its summary, ensuring it, and stopping, starting
and retrying it."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from switch_core.db.models import TENANT_ZERO_ID, CloudMachine
from switch_core.db.stores.hosted_machine_store import MACHINES_FULL
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.hosted_machines import WORKSPACE_CONNECT_TIMEOUT
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    ControllerApp,
    controller_app,
    enrolled,
    join_workspace,
    machine_of,
    observe,
    report_status,
    update_machine,
    workspace_of,
)
from tests.switch_core.hosted_machine_helpers import add_tenant

FIXTURES = Path(__file__).parent.parent / "fixtures" / "hosted_machines"
HEARTBEAT = {
    "disk": {"total_bytes": 214748364800, "available_bytes": 204010946560},
    "memory": {"total_bytes": 17179869184, "available_bytes": 12884901888},
    "controllers": {},
}


async def _lifecycle(app: ControllerApp, action: str, revision: int):
    return await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": action, "revision": revision},
    )


async def test_summary_has_the_contract_shape(controller_app):  # noqa: F811
    app = controller_app
    controller_id, agent_ids = await enrolled(app, agents=1)
    expected = json.loads((FIXTURES / "machine_summary_sleeping.json").read_text())
    await update_machine(
        app.factory,
        app.machine_id,
        state="stopped",
        desired_state="stopped",
        stop_reason="idle",
        revision=expected["revision"],
        instance_type="c7i.2xlarge",
        heartbeat=HEARTBEAT,
        heartbeat_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    listed = await app.client.get("/hosted-machines")
    assert listed.status_code == 200, listed.text
    (summary,) = listed.json()["machines"]
    assert set(summary) == set(expected)
    assert set(summary["disk"]) == set(expected["disk"])
    assert set(summary["memory"]) == set(expected["memory"])
    varying = ("machine_id", "heartbeat_at", "agents", "controller_id")
    assert {key: value for key, value in summary.items() if key not in varying} == {
        key: value for key, value in expected.items() if key not in varying
    }
    assert summary["machine_id"] == app.machine_id
    assert summary["agents"] == agent_ids
    assert summary["controller_id"] == controller_id
    assert datetime.fromisoformat(summary["heartbeat_at"]) == datetime(
        2026, 1, 1, tzinfo=UTC
    )
    single = await app.client.get(f"/hosted-machines/{app.machine_id}")
    assert single.json() == summary


async def test_a_machine_that_never_enrolled_reports_no_usage_or_agents(
    controller_app,  # noqa: F811
):
    app = controller_app
    summary = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert (
        summary["disk"],
        summary["memory"],
        summary["heartbeat_at"],
        summary["agents"],
        summary["controller_id"],
        summary["sleeping"],
    ) == (None, None, None, [], None, False)


async def test_the_summary_lists_the_agents_placed_on_its_controller(
    controller_app,  # noqa: F811
):
    app = controller_app
    controller_id, agent_ids = await enrolled(app, agents=2)
    await report_status(
        app,
        controller_id,
        disk_free_bytes=10,
        disk_total_bytes=100,
        mem_free_bytes=5,
        mem_total_bytes=50,
        sessions_running=0,
    )
    summary = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert summary["agents"] == sorted(agent_ids)
    assert summary["controller_id"] == controller_id
    assert summary["disk"] == {"total_bytes": 100, "available_bytes": 10}
    assert summary["memory"] == {"total_bytes": 50, "available_bytes": 5}
    assert summary["heartbeat_at"] is not None


async def test_other_owners_machines_read_as_missing(controller_app):  # noqa: F811
    app = controller_app
    fastapi_app = app.client._transport.app
    fastapi_app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id="someone-else"
    )
    assert (await app.client.get("/hosted-machines")).json() == {"machines": []}
    assert (
        await app.client.get(f"/hosted-machines/{app.machine_id}")
    ).status_code == 404
    assert (await _lifecycle(app, "stop", 1)).status_code == 404
    assert (await machine_of(app.factory, app.machine_id)).desired_state == "running"


async def test_stop_then_start(controller_app):  # noqa: F811
    app = controller_app
    stopped = await _lifecycle(app, "stop", 1)
    assert stopped.status_code == 200, stopped.text
    machine = stopped.json()["machine"]
    assert (
        machine["desired_state"],
        machine["stop_reason"],
        machine["sleeping"],
        machine["revision"],
    ) == ("stopped", "owner", False, 2)

    assert (await _lifecycle(app, "start", 1)).status_code == 409
    started = await _lifecycle(app, "start", 2)
    assert started.status_code == 200, started.text
    machine = started.json()["machine"]
    assert (machine["desired_state"], machine["stop_reason"], machine["revision"]) == (
        "running",
        None,
        3,
    )


async def test_revision_leniency_only_while_idle_sleeping(controller_app):  # noqa: F811
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        desired_state="stopped",
        stop_reason="idle",
        state="stopped",
        revision=5,
    )
    stale = await _lifecycle(app, "start", 3)
    assert stale.status_code == 409
    assert stale.json() == {"detail": "revision mismatch"}
    started = await _lifecycle(app, "start", 4)
    assert started.status_code == 200, started.text
    assert started.json()["machine"]["revision"] == 6
    assert (await _lifecycle(app, "stop", 5)).json() == {"detail": "revision mismatch"}


async def test_retry_only_from_error(controller_app):  # noqa: F811
    app = controller_app
    assert (await _lifecycle(app, "retry", 1)).status_code == 409
    await update_machine(
        app.factory,
        app.machine_id,
        state="error",
        error="The instance could not start.",
        error_code="instance_failed",
    )
    retried = await _lifecycle(app, "retry", 1)
    assert retried.status_code == 200, retried.text
    machine = retried.json()["machine"]
    assert (machine["state"], machine["error"], machine["error_code"]) == (
        "queued",
        None,
        None,
    )
    assert machine["revision"] == 2


async def test_retry_requeues_the_retire_of_a_machine_in_error(controller_app):  # noqa: F811
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        state="error",
        desired_state="retained",
        error="The instance could not stop.",
        error_code="instance_failed",
    )
    for action in ("stop", "start"):
        assert (await _lifecycle(app, action, 1)).status_code == 409
    retried = await _lifecycle(app, "retry", 1)
    assert retried.status_code == 200, retried.text
    machine = retried.json()["machine"]
    assert (
        machine["state"],
        machine["desired_state"],
        machine["error"],
        machine["revision"],
    ) == ("queued", "retained", None, 2)


@pytest.mark.parametrize(
    "values",
    [
        {"desired_state": "retained"},
        {"state": "retained", "desired_state": "retained"},
        {"state": "deleting", "desired_state": "deleted"},
        {"state": "error", "desired_state": "deleted"},
    ],
)
@pytest.mark.parametrize("action", ["stop", "start", "retry"])
async def test_a_retired_machine_refuses_lifecycle(controller_app, values, action):  # noqa: F811
    app = controller_app
    await update_machine(app.factory, app.machine_id, **values)
    refused = await _lifecycle(app, action, 1)
    assert refused.status_code == 409


async def test_stop_then_start_before_the_stop_lands_waits_for_a_fresh_status_report(
    controller_app,  # noqa: F811
):
    app = controller_app
    controller_id, _ = await enrolled(app, agents=1)
    await observe(app.client, app.machine_id, state="running", revision=1)
    await report_status(app, controller_id, sessions_running=0)
    assert (await machine_of(app.factory, app.machine_id)).state == "ready"

    stopped = await _lifecycle(app, "stop", 1)
    assert stopped.status_code == 200, stopped.text
    started = await _lifecycle(app, "start", 2)
    assert started.status_code == 200, started.text
    assert (
        started.json()["machine"]["state"],
        started.json()["machine"]["revision"],
    ) == ("provisioning", 3)

    await report_status(app, controller_id, sessions_running=0)
    assert (await machine_of(app.factory, app.machine_id)).state == "provisioning"
    await observe(app.client, app.machine_id, state="running", revision=3)
    observed = await machine_of(app.factory, app.machine_id)
    assert (observed.state, observed.running_observed_at is not None) == (
        "provisioning",
        True,
    )
    await report_status(app, controller_id, sessions_running=0)
    assert (await machine_of(app.factory, app.machine_id)).state == "ready"


async def _ensure(app: ControllerApp):
    return await app.client.post("/hosted-machines/ensure")


async def test_ensure_returns_the_owner_s_machine_and_claims_one_when_missing(
    controller_app,  # noqa: F811
):
    app = controller_app
    reused = await _ensure(app)
    assert reused.status_code == 200, reused.text
    assert (reused.json()["machine_id"], reused.json()["state"]) == (
        app.machine_id,
        "queued",
    )
    await update_machine(
        app.factory, app.machine_id, state="deleted", desired_state="deleted"
    )
    claimed = await _ensure(app)
    assert claimed.status_code == 200, claimed.text
    body = claimed.json()
    assert body["machine_id"] != app.machine_id
    assert (body["state"], body["desired_state"], body["agents"]) == (
        "queued",
        "running",
        [],
    )
    async with app.factory() as session:
        machine = await session.get(CloudMachine, body["machine_id"])
        assert machine is not None
    assert (await workspace_of(app.factory, body["machine_id"])).owner_id == (
        app.owner_id
    )


async def test_ensure_wakes_a_sleeping_machine_but_not_one_its_owner_stopped(
    controller_app,  # noqa: F811
):
    app = controller_app
    await update_machine(
        app.factory,
        app.machine_id,
        state="stopped",
        desired_state="stopped",
        stop_reason="idle",
        revision=2,
    )
    woken = (await _ensure(app)).json()
    assert (woken["desired_state"], woken["stop_reason"], woken["revision"]) == (
        "running",
        None,
        3,
    )
    await update_machine(
        app.factory, app.machine_id, desired_state="stopped", stop_reason="owner"
    )
    left = (await _ensure(app)).json()
    assert (left["desired_state"], left["stop_reason"], left["revision"]) == (
        "stopped",
        "owner",
        3,
    )


async def test_ensure_returns_a_machine_in_error_as_it_is(controller_app):  # noqa: F811
    app = controller_app
    await update_machine(
        app.factory, app.machine_id, state="error", error="The instance failed."
    )
    response = await _ensure(app)
    assert response.status_code == 200, response.text
    assert (response.json()["state"], response.json()["revision"]) == ("error", 1)


async def test_ensure_refuses_when_every_machine_is_in_use(controller_app):  # noqa: F811
    app = controller_app
    app.config.hosted_launch_capacity = 1
    fastapi_app = app.client._transport.app
    fastapi_app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id="someone-else"
    )
    refused = await _ensure(app)
    assert refused.status_code == 409
    assert refused.json() == {"detail": MACHINES_FULL}


@pytest.mark.parametrize(
    "disabled", ["flag", "capacity", "settings", "tenant", "no-tenant"]
)
async def test_ensure_is_unavailable_when_machines_are_not_enabled(
    controller_app,  # noqa: F811
    disabled,
):
    app = controller_app
    fastapi_app = app.client._transport.app
    if disabled == "flag":
        app.config.hosted_agents_enabled = False
    elif disabled == "capacity":
        app.config.hosted_launch_capacity = 0
    elif disabled == "settings":
        fastapi_app.state.hosted_controller_settings = None
    elif disabled == "tenant":
        fastapi_app.state.hosted_controller_settings = app.settings.model_copy(
            update={"allowed_tenant_ids": ["another-tenant"]}
        )
    else:
        fastapi_app.state.hosted_controller_settings = app.settings.model_copy(
            update={"allowed_tenant_ids": []}
        )
    response = await _ensure(app)
    assert response.status_code == 503
    assert response.json() == {"detail": "This server does not support cloud agents."}


async def test_every_workspace_may_use_machines_when_none_is_listed(
    controller_app,  # noqa: F811
):
    app = controller_app
    fastapi_app = app.client._transport.app
    fastapi_app.state.hosted_controller_settings = app.settings.model_copy(
        update={"allowed_tenant_ids": None}
    )
    async with app.factory() as session:
        await add_tenant(session, "tenant-b")
        await session.commit()
    with tenant_scope("tenant-b"):
        joined = await _ensure(app)
    assert joined.status_code == 200, joined.text
    assert joined.json()["machine_id"] == app.machine_id
    assert await tenants_of_cloud_machine(app.factory, app.machine_id) == [
        TENANT_ZERO_ID,
        "tenant-b",
    ]


async def test_a_workspace_off_the_list_is_refused_and_not_joined(
    controller_app,  # noqa: F811
):
    app = controller_app
    async with app.factory() as session:
        await add_tenant(session, "tenant-b")
        await session.commit()
    with tenant_scope("tenant-b"):
        refused = await _ensure(app)
    assert refused.status_code == 503
    assert refused.json() == {"detail": "This server does not support cloud agents."}
    assert await tenants_of_cloud_machine(app.factory, app.machine_id) == [
        TENANT_ZERO_ID
    ]
    assert (await _ensure(app)).status_code == 200


async def test_ensure_from_another_workspace_joins_the_owner_s_machine(
    controller_app,  # noqa: F811
):
    app = controller_app
    app.settings.allowed_tenant_ids = None
    await update_machine(
        app.factory,
        app.machine_id,
        state="ready",
        running_observed_at=datetime.now(UTC),
    )
    async with app.factory() as session:
        await add_tenant(session, "tenant-b")
        await session.commit()
    with tenant_scope("tenant-b"):
        joined = await _ensure(app)
        assert joined.status_code == 200, joined.text
        body = joined.json()
        assert (body["machine_id"], body["state"], body["revision"]) == (
            app.machine_id,
            "provisioning",
            2,
        )
        assert (body["agents"], body["controller_id"]) == ([], None)
        workspace = await workspace_of(app.factory, app.machine_id)
    assert workspace.id != app.workspace_id
    # Seen from the first workspace too, the machine is starting again.
    here = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert (here["state"], here["revision"]) == ("provisioning", 2)


async def test_another_workspace_sees_the_machine_ready_once_its_controller_reports(
    controller_app,  # noqa: F811
):
    app = controller_app
    here, _ = await enrolled(app, agents=1)
    there = await join_workspace(app, "tenant-b", agents=2, member=True)
    await observe(app.client, app.machine_id, state="running", revision=1)
    await report_status(app, here, sessions_running=0)
    assert (await machine_of(app.factory, app.machine_id)).state == "ready"
    mine = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert mine["state"] == "ready"
    with tenant_scope(there.tenant_id):
        theirs = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
        assert (
            theirs["state"],
            theirs["error"],
            theirs["controller_id"],
            sorted(theirs["agents"]),
        ) == ("provisioning", None, there.controller_id, sorted(there.agent_ids))
        assert (await app.client.get("/hosted-machines")).json()["machines"] == [theirs]
        await report_status(app, there.controller_id, sessions_running=0)
        theirs = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
        assert (theirs["state"], theirs["error"]) == ("ready", None)
    assert mine["agents"] != theirs["agents"]


async def test_a_workspace_whose_controller_never_connects_reads_as_in_error(
    controller_app,  # noqa: F811
):
    app = controller_app
    here, _ = await enrolled(app, agents=0)
    there = await join_workspace(app, "tenant-b", agents=0, member=True)
    await update_machine(
        app.factory,
        app.machine_id,
        state="provisioning",
        running_observed_at=datetime.now(UTC) - timedelta(minutes=11),
    )
    await report_status(app, here, sessions_running=0)
    assert (await machine_of(app.factory, app.machine_id)).state == "ready"
    with tenant_scope(there.tenant_id):
        theirs = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert (theirs["state"], theirs["error"]) == ("error", WORKSPACE_CONNECT_TIMEOUT)
    mine = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert (mine["state"], mine["error"]) == ("ready", None)


async def test_a_workspace_the_machine_does_not_serve_lists_no_machine(
    controller_app,  # noqa: F811
):
    app = controller_app
    async with app.factory() as session:
        await add_tenant(session, "tenant-b")
        await session.commit()
    with tenant_scope("tenant-b"):
        assert (await app.client.get("/hosted-machines")).json() == {"machines": []}
        assert (
            await app.client.get(f"/hosted-machines/{app.machine_id}")
        ).status_code == 404
        assert (await _lifecycle(app, "stop", 1)).status_code == 404
    assert (await machine_of(app.factory, app.machine_id)).desired_state == "running"


async def test_stopping_a_ready_machine_reads_as_ready_until_it_stops(
    controller_app,  # noqa: F811
):
    app = controller_app
    controller_id, _ = await enrolled(app, agents=0)
    await observe(app.client, app.machine_id, state="running", revision=1)
    await report_status(app, controller_id, sessions_running=0)
    stopped = await _lifecycle(app, "stop", 1)
    assert stopped.status_code == 200, stopped.text
    machine = stopped.json()["machine"]
    assert (machine["state"], machine["desired_state"], machine["revision"]) == (
        "ready",
        "stopped",
        2,
    )
    await observe(app.client, app.machine_id, state="stopping", revision=2)
    summary = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert summary["state"] == "stopping"
