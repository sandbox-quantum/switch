"""`switch-cloud-machine`, as an operator runs it: on the restricted role
row-level security applies to, bound to no workspace. `owner` only arranges
fixtures and reads results."""

from __future__ import annotations

import argparse
import json
import uuid

import pytest
from sqlalchemy import select

from switch_core.cloud_machine_admin import (
    CloudMachineAdminError,
    _run,
    find_machines,
    machine_status,
    release_machine,
    stop_machine,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    CloudMachine,
    ServerAuditEvent,
    User,
)
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.hosted_machine_helpers import seed_machine

pytestmark = pytest.mark.no_ambient_tenant


async def _owner_with_machine(
    rls_harness: RLSHarness, *, state: str, desired_state: str, stop_reason: str | None
) -> tuple[str, str]:
    owner_id = f"owner-{uuid.uuid4().hex[:8]}"
    async with rls_harness.owner() as session:
        session.add(
            User(
                id=owner_id,
                name="Ada",
                email=f"{owner_id}@Example.com",
                role="user",
                password_hash="unused",
            )
        )
        await session.commit()
    with tenant_scope(TENANT_ZERO_ID):
        async with rls_harness.owner() as session:
            machine = await seed_machine(
                session,
                owner_id=owner_id,
                state=state,
                desired_state=desired_state,
                stop_reason=stop_reason,
                revision=2,
            )
            await session.commit()
            return owner_id, machine.id


async def _machine(rls_harness: RLSHarness, machine_id: str) -> CloudMachine:
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        return machine


async def test_an_operator_finds_holds_and_releases_a_machine(
    rls_harness: RLSHarness,
) -> None:
    owner_id, machine_id = await _owner_with_machine(
        rls_harness, state="ready", desired_state="running", stop_reason=None
    )
    restricted = rls_harness.restricted

    [found] = await find_machines(restricted, f"{owner_id.upper()}@example.COM")
    assert found == await machine_status(restricted, machine_id)
    assert (found["machine_id"], found["owner_id"]) == (machine_id, owner_id)

    held = await stop_machine(restricted, machine_id, "suspected abuse")
    assert (held["desired_state"], held["stop_reason"], held["revision"]) == (
        "stopped",
        "admin",
        3,
    )
    released = await release_machine(restricted, machine_id)
    assert (released["desired_state"], released["stop_reason"]) == ("stopped", "owner")
    saved = await _machine(rls_harness, machine_id)
    assert (saved.desired_state, saved.stop_reason) == ("stopped", "owner")

    async with rls_harness.owner() as session:
        events = list(
            await session.scalars(
                select(ServerAuditEvent)
                .where(ServerAuditEvent.target_id == machine_id)
                .order_by(ServerAuditEvent.occurred_at)
            )
        )
    assert [(event.action, event.details) for event in events] == [
        (
            "cloud_machine.admin_stopped",
            {"owner_id": owner_id, "reason": "suspected abuse"},
        ),
        ("cloud_machine.admin_released", {"owner_id": owner_id}),
    ]
    assert all(event.actor_user_id is None for event in events)


@pytest.mark.parametrize(
    ("command", "message"),
    [
        (
            lambda factory: machine_status(factory, "not-a-uuid"),
            "not a cloud machine id",
        ),
        (
            lambda factory: machine_status(factory, str(uuid.uuid4())),
            "No cloud machine",
        ),
        (lambda factory: find_machines(factory, "nobody@example.com"), "No account"),
        (
            lambda factory: stop_machine(factory, str(uuid.uuid4()), " "),
            "--reason must say why",
        ),
    ],
)
async def test_bad_input_is_refused(rls_harness: RLSHarness, command, message) -> None:
    with pytest.raises(CloudMachineAdminError, match=message):
        await command(rls_harness.restricted)


async def test_a_machine_not_held_cannot_be_released(rls_harness: RLSHarness) -> None:
    _owner_id, machine_id = await _owner_with_machine(
        rls_harness, state="stopped", desired_state="stopped", stop_reason="owner"
    )
    with pytest.raises(CloudMachineAdminError, match="not stopped by an administrator"):
        await release_machine(rls_harness.restricted, machine_id)
    async with rls_harness.owner() as session:
        assert not list(
            await session.scalars(
                select(ServerAuditEvent).where(ServerAuditEvent.target_id == machine_id)
            )
        )


async def test_the_command_reports_errors_as_json_and_exits_non_zero(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Engine:
        async def dispose(self) -> None:
            pass

    monkeypatch.setattr(
        "switch_core.cloud_machine_admin.create_engine_from_config",
        lambda config: _Engine(),
    )
    monkeypatch.setattr(
        "switch_core.cloud_machine_admin.create_session_factory", lambda engine: None
    )
    code = await _run(
        object(),  # type: ignore[arg-type]
        argparse.Namespace(command="status", machine_id="not-a-uuid"),
    )
    assert code == 1
    assert json.loads(capsys.readouterr().err) == {
        "error": "'not-a-uuid' is not a cloud machine id (a UUID)."
    }


async def test_an_operators_hold_is_counted_as_a_stop(rls_harness: RLSHarness) -> None:
    """`stopped` with the fixed reason `admin`, beside idle and owner stops,
    so a hold shows on the hosted machine events rather than as `other`."""
    from switch_core.observability.metrics import MetricsRegistry, install, uninstall

    _owner_id, machine_id = await _owner_with_machine(
        rls_harness, state="ready", desired_state="running", stop_reason=None
    )
    registry = MetricsRegistry()
    install(registry)
    try:
        await stop_machine(rls_harness.restricted, machine_id, "suspected abuse")
        events = [
            dict(point.attributes)
            for payload in registry.collect()
            if payload.name == "switch.hosted.machine_events"
            for point in payload.numbers
        ]
    finally:
        uninstall()
    assert events == [{"event": "stopped", "reason": "admin", "backend": "vm"}]
