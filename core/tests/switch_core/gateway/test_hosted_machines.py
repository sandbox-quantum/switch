"""The owner's cloud machine: its summary, and stopping, starting and retrying it."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from switch_core.db.models import HostedWakeMailbox
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.hosted_machines import router as machine_router
from tests.switch_core.connections.github_seed import github_vendor  # noqa: F401
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    controller_app,
    machine_of,
    observe,
)
from tests.switch_core.gateway.test_hosted_mailbox import (  # noqa: F401
    address,
    addressed,
    attach,
    attached_conn,
    mailbox_app,
    rows,
    set_launch,
)
from tests.switch_core.gateway.test_hosted_supervisor import (  # noqa: F401
    heartbeat_body,
    supervisor,
)
from tests.switch_core.gateway.test_hosted_workers import (  # noqa: F401
    _launch,
    _machine,
    set_machine,
    worker_app,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "hosted_machines"
HEARTBEAT = {
    "disk": {
        "path": "/data",
        "total_bytes": 214748364800,
        "used_bytes": 10737418240,
        "available_bytes": 204010946560,
    },
    "memory": {"total_bytes": 17179869184, "available_bytes": 12884901888},
}


async def _lifecycle(app, action: str, revision: int):
    return await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": action, "revision": revision},
    )


async def test_summary_has_the_contract_shape(mailbox_app):  # noqa: F811
    app = mailbox_app
    expected = json.loads((FIXTURES / "machine_summary_sleeping.json").read_text())
    await set_machine(
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
    assert {
        key: value
        for key, value in summary.items()
        if key not in ("machine_id", "heartbeat_at", "agents")
    } == {
        key: value
        for key, value in expected.items()
        if key not in ("machine_id", "heartbeat_at", "agents")
    }
    assert summary["machine_id"] == app.machine_id
    assert summary["agents"] == [app.request_id]
    assert datetime.fromisoformat(summary["heartbeat_at"]) == datetime(
        2026, 1, 1, tzinfo=UTC
    )
    single = await app.client.get(f"/hosted-machines/{app.machine_id}")
    assert single.json() == summary


async def test_a_machine_without_a_heartbeat_reports_no_usage(mailbox_app):  # noqa: F811
    app = mailbox_app
    summary = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert (summary["disk"], summary["memory"], summary["heartbeat_at"]) == (
        None,
        None,
        None,
    )
    assert summary["sleeping"] is False
    await set_launch(app, state="deleted", desired_state="deleted")
    summary = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert summary["agents"] == []


async def test_other_owners_machines_read_as_missing(mailbox_app):  # noqa: F811
    app = mailbox_app
    fastapi_app = app.client._transport.app
    fastapi_app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id="someone-else"
    )
    assert (await app.client.get("/hosted-machines")).json() == {"machines": []}
    assert (
        await app.client.get(f"/hosted-machines/{app.machine_id}")
    ).status_code == 404
    assert (await _lifecycle(app, "stop", 1)).status_code == 404
    assert (await _machine(app.factory, app.machine_id)).desired_state == "running"


async def test_stop_cancels_the_mailbox_and_start_resumes(mailbox_app):  # noqa: F811
    app = mailbox_app
    first, second = app.rooms
    response, _ = await attach(app)
    conn = attached_conn(app)
    await address(app, addressed(first, "$m1"))
    async with app.factory() as session:
        session.add(
            HostedWakeMailbox(
                agent_id=app.agent_id,
                room_id=second,
                message_id="$n1",
                launch_id=app.request_id,
                thread_id="$thread-x",
                event={},
                addressed_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=24),
            )
        )
        await session.commit()

    stopped = await _lifecycle(app, "stop", 1)
    assert stopped.status_code == 200, stopped.text
    machine = stopped.json()["machine"]
    assert (
        machine["desired_state"],
        machine["stop_reason"],
        machine["sleeping"],
        machine["revision"],
    ) == ("stopped", "owner", False, 2)
    assert await rows(app) == {
        (first, "$m1"): "cancel_requested",
        (second, "$n1"): "cancelled",
    }
    assert [(room, thread) for room, thread, _ in app.sent] == [(second, "$thread-x")]
    assert "stopped before I processed" in app.sent[0][2]
    cancels = [
        data for event, data in conn.worker_frames.drain() if event == "mailbox_cancel"
    ]
    assert [(e["room_id"], e["message_id"]) for e in cancels[0]["entries"]] == [
        (first, "$m1")
    ]
    launch = await _launch(app.factory, app.request_id)
    assert launch.desired_state == "running"

    assert (await _lifecycle(app, "start", 1)).status_code == 409
    started = await _lifecycle(app, "start", 2)
    assert started.status_code == 200, started.text
    machine = started.json()["machine"]
    assert (machine["desired_state"], machine["stop_reason"], machine["revision"]) == (
        "running",
        None,
        3,
    )


async def test_revision_leniency_only_while_idle_sleeping(mailbox_app):  # noqa: F811
    app = mailbox_app
    await set_machine(
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


async def test_retry_only_from_error(mailbox_app):  # noqa: F811
    app = mailbox_app
    assert (await _lifecycle(app, "retry", 1)).status_code == 409
    await set_machine(
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


async def test_retry_requeues_the_retire_of_a_machine_in_error(mailbox_app):  # noqa: F811
    app = mailbox_app
    await set_machine(
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
async def test_a_retired_machine_refuses_lifecycle(mailbox_app, values, action):  # noqa: F811
    app = mailbox_app
    await set_machine(app.factory, app.machine_id, **values)
    refused = await _lifecycle(app, action, 1)
    assert refused.status_code == 409


async def test_stop_then_start_before_the_stop_lands_waits_for_a_fresh_heartbeat(
    supervisor,  # noqa: F811
):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    client._transport.app.include_router(machine_router)
    heartbeat = f"/hosted/machines/{machine_id}/heartbeat"
    await observe(client, machine_id, state="running", revision=1)
    await client.post(heartbeat, headers=headers, json=heartbeat_body())
    assert (await machine_of(factory, request_id)).state == "ready"

    lifecycle = f"/hosted-machines/{machine_id}/lifecycle"
    stopped = await client.post(lifecycle, json={"action": "stop", "revision": 1})
    assert stopped.status_code == 200, stopped.text
    started = await client.post(lifecycle, json={"action": "start", "revision": 2})
    assert started.status_code == 200, started.text
    assert (
        started.json()["machine"]["state"],
        started.json()["machine"]["revision"],
    ) == (
        "provisioning",
        3,
    )

    await observe(client, machine_id, state="running", revision=3)
    observed = await machine_of(factory, request_id)
    assert (observed.state, observed.running_observed_at is not None) == (
        "provisioning",
        True,
    )
    await client.post(heartbeat, headers=headers, json=heartbeat_body())
    assert (await machine_of(factory, request_id)).state == "ready"
