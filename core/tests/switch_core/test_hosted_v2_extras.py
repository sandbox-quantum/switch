"""The v1/v2 switch's extras, the parts that need no
database: with hosted agents v2 off, v2's budget metrics are refused as before
v2, budget changes are neither audited nor nudge controllers, and the
controllers' notice routes answer as if absent. Their Postgres halves are in
`test_hosted_block_refusals.py` and `test_tenant_api_routes.py`."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from switch_core import hosted_v2
from switch_core.db.models import UsageMetric
from switch_core.gateway import tenants
from switch_core.management.controller_routes import router as controller_router

NOTICE_ROUTES = ("restart-notice", "rest-notice", "reset-refused")


@pytest.fixture
def v2(monkeypatch: pytest.MonkeyPatch):
    def _set(on: bool) -> None:
        monkeypatch.setattr(hosted_v2, "_process_on", on)

    return _set


@pytest.mark.parametrize(
    "metric", [UsageMetric.AWAKE_MINUTES, UsageMetric.HOSTED_AI_CALLS]
)
def test_v2s_budget_metrics_are_refused_as_unknown(metric: UsageMetric) -> None:
    with pytest.raises(RequestValidationError) as refused:
        tenants._v1_metric(metric)
    (error,) = refused.value.errors()
    assert error["loc"] == ("body", "metric")
    assert error["type"] == "enum"


@pytest.mark.parametrize(
    "metric",
    [
        m
        for m in UsageMetric
        if m not in (UsageMetric.AWAKE_MINUTES, UsageMetric.HOSTED_AI_CALLS)
    ],
)
def test_every_v1_metric_is_still_accepted(metric: UsageMetric) -> None:
    tenants._v1_metric(metric)


async def test_v2_off_a_budget_change_is_not_audited(v2, monkeypatch) -> None:
    v2(False)
    record = AsyncMock()
    monkeypatch.setattr(tenants, "record_audit_event", record)
    await tenants._audit_budget(
        AsyncMock(),
        tenant_id="t",
        actor_id="u",
        action="budget.created",  # type: ignore[arg-type]
        budget_id="b",
        details={},
    )
    record.assert_not_awaited()


async def test_v2_on_a_budget_change_is_audited(v2, monkeypatch) -> None:
    v2(True)
    record = AsyncMock()
    monkeypatch.setattr(tenants, "record_audit_event", record)
    await tenants._audit_budget(
        AsyncMock(),
        tenant_id="t",
        actor_id="u",
        action="budget.created",  # type: ignore[arg-type]
        budget_id="b",
        details={},
    )
    record.assert_awaited_once()


@pytest.mark.parametrize("on", [False, True])
async def test_the_daily_cap_nudges_controllers_only_with_v2_on(
    v2, monkeypatch, on: bool
) -> None:
    v2(on)
    bump = AsyncMock(return_value={"c": 2})
    monkeypatch.setattr(tenants, "bump_hosted_controllers", bump)
    changed = await tenants._daily_cap_changed(
        AsyncMock(), "t", UsageMetric.HOSTED_AI_CALLS.value
    )
    assert changed == ({"c": 2} if on else {})
    assert bump.await_count == (1 if on else 0)


def _notice(route: str) -> str:
    return f"/v1/management/controllers/c-1/agents/a-1/{route}"


@pytest.mark.parametrize("route", NOTICE_ROUTES)
def test_v2_off_the_notice_routes_answer_as_if_absent(v2, route: str) -> None:
    v2(False)
    app = FastAPI()
    app.include_router(controller_router)
    response = TestClient(app).post(
        _notice(route), json={}, headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


@pytest.mark.parametrize("route", NOTICE_ROUTES)
def test_v2_on_the_notice_routes_are_reached(v2, route: str) -> None:
    v2(True)
    app = FastAPI()
    app.include_router(controller_router)
    response = TestClient(app, raise_server_exceptions=False).post(
        _notice(route), json={}
    )
    # Reached: refused for want of a controller or its wiring, never "Not Found".
    assert response.status_code != 404 or response.json() != {"detail": "Not Found"}


# ── Sweep rows tested without a database ─────────────────────────────────────


def _machine(backend: str):
    from types import SimpleNamespace

    return SimpleNamespace(
        id="m-1",
        state="ready",
        desired_state="running",
        revision=1,
        data_volume_id=None,
        retain_until=None,
        backend=backend,
    )


@pytest.mark.parametrize(
    ("on", "backend", "shown"),
    [
        (False, "vm", None),
        (False, "box", "box"),
        (True, "vm", "vm"),
        (True, "box", "box"),
    ],
)
def test_a_machine_row_names_its_backend_as_ruled(
    v2, on: bool, backend: str, shown: str | None
) -> None:
    """Tech lead, point 2: with v2 off a v1 machine's row is upstream's (no key),
    and a box's still says `box`, so the v1 operator leaves it alone."""
    from switch_core.gateway.hosted_controller import machine_item

    v2(on)
    item = machine_item(_machine(backend))  # type: ignore[arg-type]
    assert item.get("backend") == shown
    assert ("backend" in item) is (shown is not None)


@pytest.mark.parametrize("field", ["evictions", "restarts", "node"])
def test_v2_off_an_observation_with_v2_fields_is_refused_as_upstream(
    v2, field: str
) -> None:
    """Sweep row 14: upstream's `extra="forbid"` refused these with a 422."""
    from switch_core.gateway.hosted_controller import (
        Observation,
        _refuse_v2_fields_while_off,
    )

    body = Observation.model_validate(
        {"state": "running", "revision": 1, field: "node-a" if field == "node" else 1}
    )
    v2(True)
    _refuse_v2_fields_while_off(body)  # on: accepted
    v2(False)
    with pytest.raises(RequestValidationError) as refused:
        _refuse_v2_fields_while_off(body)
    (error,) = refused.value.errors()
    assert (error["type"], error["loc"]) == ("extra_forbidden", ("body", field))
    _refuse_v2_fields_while_off(
        Observation.model_validate({"state": "running", "revision": 1})
    )  # an upstream observation still passes


def _status_with(machine: dict, agent: dict) -> dict:
    from tests.switch_core.management.harness import fixture

    report = fixture("status_request.json")
    report["machine"].update(machine)
    report["agents"][0].update(agent)
    return report


# Values v2's strict types refuse, which upstream kept as sent.
_LOOSE_MACHINE = {
    "mem_anon_bytes": "lots",
    "gateway_capped": "yes",
    "memory_note": "a free-text note",
}
_LOOSE_AGENT = {"session": "sleepy", "busy": 1, "ai_calls_today": -3}


def test_v2_off_a_status_report_is_read_as_upstream(v2) -> None:
    """Sweep row 8: with v2 off, nothing v2 declared refuses a report; each
    value is kept as sent, as upstream's `extra="allow"` kept it."""
    from switch_core.management.schemas import StatusReport

    v2(False)
    report = StatusReport.model_validate(_status_with(_LOOSE_MACHINE, _LOOSE_AGENT))
    dumped = report.model_dump(mode="json", exclude_unset=True)
    for key, value in _LOOSE_MACHINE.items():
        assert dumped["machine"][key] == value
    for key, value in _LOOSE_AGENT.items():
        assert dumped["agents"][0][key] == value
    assert report.machine._dropped_old_note is False


@pytest.mark.parametrize("value", ["system", "workspace", 7])
def test_v2_off_a_disk_scope_is_kept_as_sent(v2, value: object) -> None:
    """With v2 off, `disk_scope` is an undeclared field to upstream: any value
    is accepted and kept as sent, never refused or turned into "unknown"."""
    from switch_core.management.schemas import StatusReport

    v2(False)
    report = StatusReport.model_validate(_status_with({"disk_scope": value}, {}))
    dumped = report.model_dump(mode="json", exclude_unset=True)
    assert dumped["machine"]["disk_scope"] == value


def test_v2_on_the_same_report_is_refused(v2) -> None:
    from pydantic import ValidationError

    from switch_core.management.schemas import StatusReport

    v2(True)
    with pytest.raises(ValidationError):
        StatusReport.model_validate(_status_with({}, _LOOSE_AGENT))


def test_the_loose_fields_are_every_field_v2_declared() -> None:
    """A guard on row 8 itself: a field v2 adds to a status report must be
    loosened too, or v1 could be refused for it."""
    from switch_core.management.schemas import (
        V2_AGENT_STATUS_FIELDS,
        V2_MACHINE_STATUS_FIELDS,
        AgentStatus,
        MachineStatus,
        _V1AgentStatus,
        _V1MachineStatus,
    )

    for model, loose, names in (
        (MachineStatus, _V1MachineStatus, V2_MACHINE_STATUS_FIELDS),
        (AgentStatus, _V1AgentStatus, V2_AGENT_STATUS_FIELDS),
    ):
        for name in names:
            assert name in model.model_fields
            assert (
                loose.model_fields[name].annotation
                is not model.model_fields[name].annotation
            )


@pytest.mark.parametrize(
    ("on", "backend", "minutes", "reads"),
    [(False, "box", 30, 0), (True, "vm", 30, 1), (True, "box", 15, 1)],
)
async def test_a_machine_code_lives_15_minutes_only_for_a_v2_box(
    v2, on: bool, backend: str, minutes: int, reads: int
) -> None:
    """Sweep row 18: upstream's 30 minutes for a v1 machine and with v2 off."""
    from datetime import timedelta
    from types import SimpleNamespace

    from switch_core.management.service import _machine_code_lifetime

    v2(on)
    session = AsyncMock()
    session.scalar = AsyncMock(return_value=backend)
    lifetime = await _machine_code_lifetime(
        session,
        SimpleNamespace(machine_id="m-1"),  # type: ignore[arg-type]
    )
    assert lifetime == timedelta(minutes=minutes)
    assert session.scalar.await_count == reads


@pytest.mark.parametrize(
    ("on", "backend", "blocked_checked", "refused"),
    [
        (False, "box", False, "hosted_v2_off"),
        (False, "vm", False, None),
        (False, None, False, None),
        (True, "vm", False, None),
        (True, None, False, None),
        (True, "box", True, None),
    ],
)
async def test_a_controllers_doors_refuse_only_a_box(
    v2, monkeypatch, on: bool, backend, blocked_checked: bool, refused
) -> None:
    """QA's question 4 (tech lead): the pause and turn-off are checked for a
    box only, even with v2 on; with v2 off a box is refused as `hosted_v2_off`.
    One check stands at every door: enrolment, token, rotation, placement."""
    from switch_core.management import service
    from switch_core.management.errors import ManagementError

    v2(on)
    checked = AsyncMock()
    monkeypatch.setattr(service, "_refuse_if_blocked", checked)
    if refused:
        with pytest.raises(ManagementError) as error:
            await service._refuse_for_box(AsyncMock(), backend, "owner", "t")
        assert (error.value.status_code, error.value.code) == (403, refused)
        assert error.value.message == "This server does not support cloud agents."
    else:
        await service._refuse_for_box(AsyncMock(), backend, "owner", "t")
    assert (checked.await_count == 1) is blocked_checked


# ── The two opt-in settings (security) ──────────────────────────────────────


def test_the_opt_in_settings_are_unset_by_default() -> None:
    from switch_core.providers.hosted import HostedControllerSettings

    for name in ("allowed_user_ids", "management_tenant_ids"):
        field = HostedControllerSettings.model_fields[name]
        assert not field.is_required()
        assert field.default is None


@pytest.mark.parametrize("allowed_tenants", [None, ["t-1"], ["t-2"]])
@pytest.mark.parametrize("user_id", ["u-1", "u-2"])
def test_unset_they_answer_as_upstream(
    monkeypatch: pytest.MonkeyPatch, allowed_tenants, user_id: str
) -> None:
    """Unset, the cloud-machine check is upstream's rule for every account,
    and agent management is open to every workspace, as upstream."""
    from types import SimpleNamespace

    from switch_core.gateway import hosted_machines
    from switch_core.providers.hosted import HostedControllerSettings, tenant_allowed

    monkeypatch.setattr(hosted_machines, "require_tenant_id", lambda: "t-1")
    config = SimpleNamespace(hosted_agents_enabled=True, hosted_launch_capacity=1)
    # Only the lists matter here: every other setting is left at its default.
    settings = HostedControllerSettings.model_construct(
        allowed_tenant_ids=allowed_tenants
    )
    # Upstream `473c2e64b`'s `machines_enabled`, word for word in effect.
    upstream = allowed_tenants is None or "t-1" in allowed_tenants
    assert hosted_machines.machines_enabled(config, settings, user_id) is upstream  # type: ignore[arg-type]
    assert tenant_allowed(settings.management_tenant_ids, "any-workspace")
