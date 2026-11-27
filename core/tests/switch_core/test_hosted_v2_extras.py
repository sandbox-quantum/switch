"""The v1/v2 switch's extras, the parts that need no
database: with hosted agents v2 off, v2's budget metrics are refused as before
v2, budget changes are neither audited nor nudge controllers, and the
controllers' notice routes answer as if absent. Their Postgres halves are in
`test_hosted_block_refusals.py` and `test_tenant_api_routes.py`."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import (
    BaseModel,
    TypeAdapter,
    ValidationError,
)

from switch_core import box_cluster
from switch_core.db.models import (
    UsageMetric,
)
from switch_core.gateway import tenants
from switch_core.gateway.schemas import (
    BudgetCreateRequest,
    BudgetUpdateRequest,
)
from switch_core.management.controller_routes import router as controller_router
from switch_core.tenant_context import tenant_scope

NOTICE_ROUTES = ("restart-notice", "rest-notice", "reset-refused")


@pytest.fixture
def v2(monkeypatch: pytest.MonkeyPatch):
    def _set(on: bool) -> None:
        monkeypatch.setattr(box_cluster, "_process_on", on)

    return _set


def _errors(model: type[BaseModel], body: dict) -> list[dict] | None:
    try:
        TypeAdapter(model).validate_python(body)
    except ValidationError as error:
        # A value error's context holds the exception itself, which compares
        # by identity: compare its words instead.
        return [
            {**e, "ctx": {k: str(v) for k, v in e["ctx"].items()}} if "ctx" in e else e
            for e in error.errors(include_url=False)
        ]
    return None


_BUDGET_BODIES = [
    {
        "agent_id": None,
        "metric": metric,
        "model": model,
        "amount_limit": limit,
        "period_hours": hours,
    }
    for metric in ("awake_minutes", "hosted_ai_calls", "turns", "input_tokens", "bogus")
    for model, limit, hours in (("", 300, 24), ("m", 0, 99999), ("m", 5, 1))
]


def test_v2_on_its_budget_metric_is_accepted(v2) -> None:
    v2(True)
    body = {
        "agent_id": None,
        "metric": UsageMetric.AWAKE_MINUTES.value,
        "model": "",
        "amount_limit": 300,
        "period_hours": 24,
    }
    assert _errors(BudgetCreateRequest, body) is None


@pytest.mark.parametrize("change", ["update", "delete"])
async def test_the_budget_is_read_before_a_change(monkeypatch, change: str) -> None:
    """The budget's audit needs it as it was."""
    monkeypatch.setattr(tenants, "record_audit_event", AsyncMock())
    row = AsyncMock(return_value=None)
    monkeypatch.setattr(tenants, "_budget_row", row)
    monkeypatch.setattr(tenants, "_budget_standing", AsyncMock())
    store = AsyncMock()
    store.update.return_value = SimpleNamespace(
        metric="turns", model="", agent_id=None, amount_limit=5, period_hours=24
    )
    common: dict[str, Any] = {
        "tenant_id": "t",
        "budget_id": "b",
        "session": AsyncMock(),
        "budget_store": store,
        "user": SimpleNamespace(id="u"),
    }
    with tenant_scope("t"):
        if change == "update":
            await tenants.update_budget(
                body=BudgetUpdateRequest(amount_limit=5, period_hours=24), **common
            )
        else:
            await tenants.delete_budget(**common)
    assert row.await_count == 1


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


def _notice(route: str) -> str:
    return f"/v1/management/controllers/c-1/agents/a-1/{route}"


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
        expedite_deletion=False,
        backend=backend,
    )


@pytest.mark.parametrize(
    ("on", "backend"),
    [(on, backend) for on in (False, True) for backend in ("vm", "box")],
)
def test_a_machine_row_names_its_backend(v2, on: bool, backend: str) -> None:
    """With or without a box cluster, so the v1 operator leaves a box alone."""
    from switch_core.gateway.hosted_controller import machine_item

    v2(on)
    item = machine_item(_machine(backend))  # type: ignore[arg-type]
    assert item["backend"] == backend


_OBSERVATIONS = [
    {"state": "running", "revision": 1, "evictions": 2},
    {"node": "node-a", "state": "running", "revision": 1},
    {"restarts": 1, "evictions": -1, "node": "!", "state": "nope", "revision": 0},
    {"state": "running", "revision": 1, "surprise": True, "evictions": 1},
    {"state": "running", "revision": 1},
    {"state": "nope", "revision": 0},
]


def test_v2_on_an_observation_may_name_v2s_fields(v2) -> None:
    from switch_core.gateway.hosted_controller import Observation

    v2(True)
    body = {
        "state": "running",
        "revision": 1,
        "evictions": 2,
        "restarts": 1,
        "node": "node-a",
    }
    assert _errors(Observation, body) is None
    assert _errors(Observation, {**body, "evictions": -1}) == [
        {
            "type": "greater_than_equal",
            "loc": ("evictions",),
            "msg": "Input should be greater than or equal to 0",
            "input": -1,
            "ctx": {"ge": "0"},
        }
    ]


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


def test_v2_on_the_same_report_is_refused(v2) -> None:
    from pydantic import ValidationError

    from switch_core.management.schemas import StatusReport

    v2(True)
    with pytest.raises(ValidationError):
        StatusReport.model_validate(_status_with({}, _LOOSE_AGENT))


@pytest.mark.parametrize(
    ("backend", "minutes"),
    [("vm", 30), ("box", 15)],
)
async def test_a_machine_code_lives_15_minutes_only_for_a_box(
    backend: str, minutes: int
) -> None:
    """Sweep row 18: upstream's 30 minutes for a v1 machine."""
    from datetime import timedelta
    from types import SimpleNamespace

    from switch_core.management.service import _machine_code_lifetime

    session = AsyncMock()
    session.scalar = AsyncMock(return_value=backend)
    lifetime = await _machine_code_lifetime(
        session,
        SimpleNamespace(machine_id="m-1"),  # type: ignore[arg-type]
    )
    assert lifetime == timedelta(minutes=minutes)
    assert session.scalar.await_count == 1


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
    """The pause and turn-off are checked for a
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


# ── The two opt-in settings ──────────────────────────────────────


def test_the_opt_in_settings_are_unset_by_default() -> None:
    from switch_core.providers.hosted import HostedControllerSettings

    for name in ("allowed_user_ids", "management_tenant_ids"):
        field = HostedControllerSettings.model_fields[name]
        assert not field.is_required()
        assert field.default is None


async def test_a_status_report_reads_the_bound_agents_and_locks(monkeypatch) -> None:
    """The bound agents are read and the previous report locked, and an agent
    not bound to the controller has its session state dropped."""
    from switch_core.bridges.agent.auth import ControllerPrincipal
    from switch_core.management import service as service_module
    from switch_core.management.schemas import StatusReport
    from switch_core.management.service import ManagementService

    monkeypatch.setattr(service_module, "controller_release_view", lambda *_: None)
    controller = SimpleNamespace(
        id="c", status={}, kind="local", assignment_revision=3, owner_id="u"
    )
    listed = AsyncMock(return_value=[])
    locked = AsyncMock(return_value=(None, None))
    stored_status = AsyncMock(return_value=True)
    svc: Any = object.__new__(ManagementService)
    svc.definitions = SimpleNamespace(list_for_controller=listed)
    svc.controllers = SimpleNamespace(
        lock_previous_report=locked, record_status=stored_status
    )
    svc._principal_controller = AsyncMock(return_value=controller)
    svc.now = lambda: datetime.now(UTC)
    svc.user_changes = SimpleNamespace(publish=lambda *_: None)
    svc.settings = SimpleNamespace(
        status_interval_seconds=30, wait_limit_seconds=600, controller_release=None
    )
    report = StatusReport.model_validate(_status_with({}, {"session": "active"}))
    await svc.record_status(
        AsyncMock(),
        ControllerPrincipal(
            controller_id="c", owner_id="u", tenant_id="t", key_id=None
        ),
        report,
    )
    assert listed.await_count == 1
    assert locked.await_count == 1
    assert stored_status.await_args is not None
    stored = stored_status.await_args.kwargs["status"]
    # The agent isn't bound to this controller: v2 drops its session state.
    assert "session" not in stored["agents"][0]


def test_v2_on_a_client_txn_id_is_checked_and_kept(v2) -> None:
    from fastapi import HTTPException

    from switch_core.bridges.agent.api.operations import reply_key

    v2(True)
    assert reply_key("reply:7f1c") == "reply:7f1c"
    assert reply_key(None) is None
    with pytest.raises(HTTPException) as refused:
        reply_key("not a key")
    assert refused.value.status_code == 400


def _hosted_config(tmp_path, **lists) -> str:
    """A v1 server's hosted controller config: no v2 setting, and only the
    lists given here."""
    import json

    path = tmp_path / "hosted.json"
    path.write_text(
        json.dumps(
            {
                "allowed_tenant_ids": None,
                "token": "t" * 32,
                "agent_api_endpoint": "https://core.example",
                **lists,
            }
        )
    )
    return str(path)


@pytest.mark.parametrize(
    ("lists", "refused"),
    [
        (None, False),  # no hosted config at all
        ({}, False),  # a v1 config, lists left out
        ({"management_tenant_ids": None, "allowed_user_ids": None}, False),
        ({"management_tenant_ids": ["t-1"]}, True),  # set: the check is real
    ],
)
async def test_unset_allow_lists_add_no_403_on_the_paths_that_check_them(
    tmp_path, monkeypatch, lists: dict | None, refused: bool
) -> None:
    """With `management_tenant_ids` and `allowed_user_ids`
    unset, a v1 server refuses no workspace on the three paths that check the
    management list, wired as `create_management` wires them, and lets every
    account use cloud machines as upstream."""
    from functools import partial

    from switch_core.bridges.agent.auth import ControllerAuthError, ControllerPrincipal
    from switch_core.gateway import hosted_machines
    from switch_core.management import auth as auth_module
    from switch_core.management.auth import ManagementAuthenticator
    from switch_core.management.dependencies import require_management_workspace
    from switch_core.management.errors import ManagementError
    from switch_core.management.wiring import _management_tenant_ids
    from switch_core.providers.hosted import load_hosted_settings, tenant_allowed

    path = None if lists is None else _hosted_config(tmp_path, **lists)
    tenant_ids = _management_tenant_ids(path)
    principal = ControllerPrincipal(
        controller_id="c", owner_id="u", tenant_id="t-2", key_id=None
    )
    authenticator = ManagementAuthenticator(
        session_factory=AsyncMock(),  # type: ignore[arg-type]
        controllers=AsyncMock(),  # type: ignore[arg-type]
        token_secret="s" * 32,
        presence=AsyncMock(),  # type: ignore[arg-type]
        auth_cache=SimpleNamespace(controller=lambda *_: principal),  # type: ignore[arg-type]
        workspace_allowed=partial(tenant_allowed, tenant_ids),
        workspace_restricted=tenant_ids is not None,
    )
    monkeypatch.setattr(auth_module, "tenant_of_api_key", AsyncMock(return_value="t-2"))
    outcomes: list[int | None] = []
    with tenant_scope("t-2"):
        for check in (
            lambda: _sync(require_management_workspace, authenticator),
            lambda: authenticator.current(principal),
            lambda: authenticator.tenant_of_secret("secret"),
        ):
            try:
                await check()
                outcomes.append(None)
            except (ManagementError, ControllerAuthError) as error:
                outcomes.append(error.status_code)
    assert outcomes == ([403, 403, 403] if refused else [None, None, None])
    assert authenticator.workspace_restricted is refused
    if path is not None:
        settings = load_hosted_settings(path)
        assert settings is not None
        monkeypatch.setattr(hosted_machines, "require_tenant_id", lambda: "t-2")
        config = SimpleNamespace(hosted_agents_enabled=True, hosted_launch_capacity=1)
        # A v1 owner, on their v1 machine: every account, as upstream.
        assert hosted_machines.machines_enabled(
            config, settings, "any-user", on_v1=True
        )  # type: ignore[arg-type]
        # Anyone asking for a box: unset lists admit nobody.
        assert not hosted_machines.machines_enabled(  # type: ignore[arg-type]
            config, settings, "any-user", on_v1=False
        )


async def _sync(check: Any, authenticator: object) -> None:
    """A sync dependency, run as the awaited checks are."""
    check(SimpleNamespace(), authenticator)
