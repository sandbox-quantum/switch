"""The owner's cloud machine: its summary, and stopping, starting and retrying it."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.models import (
    AgentController,
    HostedMachine,
    User,
    require_tenant_id,
)
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.hosted_machines import router as machine_router
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.hosted_machine_helpers import seed_machine

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


@pytest.fixture
async def machine_app(session_factory):
    """An owner's running machine, on an ec2 controller, behind the owner routes."""
    async with session_factory() as session:
        owner = User(
            name="owner", email="owner@example.com", role="user", password_hash="x"
        )
        session.add(owner)
        await session.flush()
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            slot_id="slot-a",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        controller = AgentController(owner_id=owner.id, name="Switch cloud", kind="ec2")
        session.add(controller)
        await session.flush()
        machine.controller_id = controller.id
        ids = SimpleNamespace(
            owner_id=owner.id, machine_id=machine.id, controller_id=controller.id
        )
        await session.commit()
    app = FastAPI()
    app.include_router(machine_router)

    async def session_dependency():
        async with session_factory() as session:
            yield session

    async def current_user():
        async with session_factory() as session:
            return await session.get(User, ids.owner_id)

    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[get_current_user] = current_user
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield SimpleNamespace(client=client, factory=session_factory, **vars(ids))


async def set_machine(factory, machine_id: str, **values) -> None:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        for key, value in values.items():
            setattr(machine, key, value)
        await session.commit()


async def _machine(factory, machine_id: str) -> HostedMachine:
    async with factory() as session:
        machine = await session.get(HostedMachine, (require_tenant_id(), machine_id))
        assert machine is not None
        return machine


async def _place_agent(app) -> str:
    async with app.factory() as session:
        agent = await add_agent(session, name="placed", owner_id=app.owner_id)
        await AgentDefinitionStore().create(
            session,
            agent_id=agent.id,
            owner_id=app.owner_id,
            controller_id=app.controller_id,
            desired_state="running",
            definition={},
        )
        await session.commit()
        return agent.id


async def _lifecycle(app, action: str, revision: int):
    return await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": action, "revision": revision},
    )


async def test_summary_has_the_contract_shape(machine_app):
    app = machine_app
    expected = json.loads((FIXTURES / "machine_summary_sleeping.json").read_text())
    agent_id = await _place_agent(app)
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
    varying = ("machine_id", "heartbeat_at", "agents", "controller_id")
    assert {key: value for key, value in summary.items() if key not in varying} == {
        key: value for key, value in expected.items() if key not in varying
    }
    assert summary["machine_id"] == app.machine_id
    assert summary["controller_id"] == app.controller_id
    assert summary["agents"] == [agent_id]
    assert datetime.fromisoformat(summary["heartbeat_at"]) == datetime(
        2026, 1, 1, tzinfo=UTC
    )
    single = await app.client.get(f"/hosted-machines/{app.machine_id}")
    assert single.json() == summary


async def test_a_machine_without_a_heartbeat_reports_no_usage(machine_app):
    app = machine_app
    summary = (await app.client.get(f"/hosted-machines/{app.machine_id}")).json()
    assert (summary["disk"], summary["memory"], summary["heartbeat_at"]) == (
        None,
        None,
        None,
    )
    assert summary["sleeping"] is False
    assert summary["agents"] == []


async def test_other_owners_machines_read_as_missing(machine_app):
    app = machine_app
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


async def test_stop_then_start(machine_app):
    app = machine_app
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


async def test_revision_leniency_only_while_idle_sleeping(machine_app):
    app = machine_app
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


async def test_retry_only_from_error(machine_app):
    app = machine_app
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


async def test_retry_requeues_the_retire_of_a_machine_in_error(machine_app):
    app = machine_app
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
async def test_a_retired_machine_refuses_lifecycle(machine_app, values, action):
    app = machine_app
    await set_machine(app.factory, app.machine_id, **values)
    refused = await _lifecycle(app, action, 1)
    assert refused.status_code == 409
