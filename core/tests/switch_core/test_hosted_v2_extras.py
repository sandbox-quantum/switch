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
    Field,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from switch_core import hosted_v2
from switch_core.db.models import (
    MAX_BUDGET_AMOUNT,
    MAX_BUDGET_PERIOD_HOURS,
    UsageMetric,
)
from switch_core.gateway import tenants
from switch_core.gateway.schemas import (
    BudgetCreateRequest,
    BudgetUpdateRequest,
    _V1Metric,
)
from switch_core.management.controller_routes import router as controller_router
from switch_core.tenant_context import tenant_scope

NOTICE_ROUTES = ("restart-notice", "rest-notice", "reset-refused")


@pytest.fixture
def v2(monkeypatch: pytest.MonkeyPatch):
    def _set(on: bool) -> None:
        monkeypatch.setattr(hosted_v2, "_process_on", on)

    return _set


class _UpstreamBudgetCreateRequest(BaseModel):
    """Upstream's `BudgetCreateRequest` (807a1f94d), copied as it was, so the
    v2-off answer is checked against the real thing rather than a summary."""

    agent_id: str | None
    metric: _V1Metric  # type: ignore[valid-type]
    model: str
    amount_limit: int = Field(gt=0, le=MAX_BUDGET_AMOUNT)
    period_hours: int = Field(gt=0, le=MAX_BUDGET_PERIOD_HOURS)

    @model_validator(mode="after")
    def _model_only_on_token_metrics(self) -> _UpstreamBudgetCreateRequest:
        if self.model and self.metric in ("messages", "turns"):
            raise ValueError(
                f"A {self.metric.value} budget cannot name a model: "
                f"{self.metric.value} are not counted per model"
            )
        return self


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


@pytest.mark.parametrize("body", _BUDGET_BODIES)
def test_v2_off_a_new_budget_is_refused_exactly_as_upstream(v2, body: dict) -> None:
    """With v2 off, the same errors in the same order,
    raised while the body is read, so before the handler's workspace check."""
    v2(False)
    assert _errors(BudgetCreateRequest, body) == _errors(
        _UpstreamBudgetCreateRequest, body
    )


@pytest.mark.parametrize(
    "metric", [UsageMetric.AWAKE_MINUTES, UsageMetric.HOSTED_AI_CALLS]
)
def test_v2_on_its_budget_metrics_are_accepted(v2, metric: UsageMetric) -> None:
    v2(True)
    body = {
        "agent_id": None,
        "metric": metric.value,
        "model": "",
        "amount_limit": 300,
        "period_hours": 24,
    }
    assert _errors(BudgetCreateRequest, body) is None
    assert _errors(_UpstreamBudgetCreateRequest, body)


@pytest.mark.parametrize("on", [False, True])
@pytest.mark.parametrize("change", ["update", "delete"])
async def test_the_budget_is_read_before_a_change_only_with_v2_on(
    v2, monkeypatch, on: bool, change: str
) -> None:
    """With v2 off, no extra `usage_budgets` read before an
    update or delete, as upstream; only v2's audit, cap and nudge need it."""
    v2(on)
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
        "request": SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace())),
    }
    with tenant_scope("t"):
        if change == "update":
            await tenants.update_budget(
                body=BudgetUpdateRequest(amount_limit=5, period_hours=24), **common
            )
        else:
            await tenants.delete_budget(**common)
    assert row.await_count == (1 if on else 0)


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
    """With v2 off a v1 machine's row is upstream's (no key),
    and a box's still says `box`, so the v1 operator leaves it alone."""
    from switch_core.gateway.hosted_controller import machine_item

    v2(on)
    item = machine_item(_machine(backend))  # type: ignore[arg-type]
    assert item.get("backend") == shown
    assert ("backend" in item) is (shown is not None)


_OBSERVATIONS = [
    {"state": "running", "revision": 1, "evictions": 2},
    {"node": "node-a", "state": "running", "revision": 1},
    {"restarts": 1, "evictions": -1, "node": "!", "state": "nope", "revision": 0},
    {"state": "running", "revision": 1, "surprise": True, "evictions": 1},
    {"state": "running", "revision": 1},
    {"state": "nope", "revision": 0},
]


@pytest.mark.parametrize("body", _OBSERVATIONS)
def test_v2_off_an_observation_is_refused_exactly_as_upstream(v2, body: dict) -> None:
    """Upstream's `extra="forbid"` model alone decides, so
    the 422 lists its errors in its order, even for v2 fields out of range."""
    from switch_core.gateway.hosted_controller import (
        Observation,
        _UpstreamObservation,
    )

    v2(False)
    assert _errors(Observation, body) == _errors(_UpstreamObservation, body)


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


@pytest.mark.parametrize("on", [False, True])
async def test_a_status_report_reads_and_locks_only_with_v2_on(
    v2, monkeypatch, on: bool
) -> None:
    """With v2 off, no read of the bound agents, no lock on
    the previous report, and a session state kept as sent, as upstream."""
    from switch_core.bridges.agent.auth import ControllerPrincipal
    from switch_core.management import service as service_module
    from switch_core.management.schemas import StatusReport
    from switch_core.management.service import ManagementService

    v2(on)
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
        ControllerPrincipal(controller_id="c", owner_id="u", tenant_id="t"),
        report,
    )
    calls = 1 if on else 0
    assert listed.await_count == calls
    assert locked.await_count == calls
    assert stored_status.await_args is not None
    stored = stored_status.await_args.kwargs["status"]
    # The agent isn't bound to this controller: v2 drops its session state.
    assert ("session" in stored["agents"][0]) is not on


@pytest.mark.parametrize("on", [False, True])
async def test_a_claim_reads_the_owners_pause_only_with_v2_on(
    v2, monkeypatch, on: bool
) -> None:
    """The pause is v2's; with it off, no read on claim."""
    from switch_core.db.stores import hosted_machine_store as store_module

    class _Reached(Exception):
        pass

    v2(on)
    paused = AsyncMock(return_value=True)
    monkeypatch.setattr(store_module, "owner_paused", paused)
    monkeypatch.setattr(
        store_module.CloudMachineStore,
        "live_for_owner",
        AsyncMock(side_effect=_Reached),
    )
    store = object.__new__(store_module.CloudMachineStore)
    expected = store_module.CloudMachineConflict if on else _Reached
    with pytest.raises(expected) as raised:
        await store.claim(
            AsyncMock(), AsyncMock(), owner_id="u", capacity=1, now=datetime.now(UTC)
        )
    if on:
        assert str(raised.value) == store_module.MACHINE_PAUSED
    assert paused.await_count == (1 if on else 0)


@pytest.mark.parametrize("value", ["reply:7f1c", "not a key", "x" * 500])
def test_v2_off_a_client_txn_id_is_ignored(v2, value: str) -> None:
    """With v2 off the header is ignored as upstream: no 400
    for one out of shape, and no key, so no `sent_under` lookup."""
    from switch_core.bridges.agent.api.operations import reply_key

    v2(False)
    assert reply_key(value) is None


def test_v2_on_a_client_txn_id_is_checked_and_kept(v2) -> None:
    from fastapi import HTTPException

    from switch_core.bridges.agent.api.operations import reply_key

    v2(True)
    assert reply_key("reply:7f1c") == "reply:7f1c"
    assert reply_key(None) is None
    with pytest.raises(HTTPException) as refused:
        reply_key("not a key")
    assert refused.value.status_code == 400


@pytest.mark.parametrize("on", [False, True])
def test_the_agent_apis_feature_flags_hide_v2s_own_flags_with_v2_off(
    on: bool,
) -> None:
    """As the gateway's list, upstream's exactly with v2 off."""
    from switch_core.bridges.agent.api.handlers import router as agent_router
    from switch_core.bridges.agent.auth import get_agent_from_scope
    from switch_core.bridges.agent.dependencies import get_config
    from switch_core.feature_flags import (
        ECOSYSTEM_SHOW_OWNERS,
        HOSTED_AWAKE_BUDGETS,
        HOSTED_CLOUD_FILES,
    )

    flags = {
        ECOSYSTEM_SHOW_OWNERS: True,
        HOSTED_AWAKE_BUDGETS: True,
        HOSTED_CLOUD_FILES: False,
    }
    app = FastAPI()
    app.include_router(agent_router, prefix="/agent")
    app.dependency_overrides[get_agent_from_scope] = lambda: SimpleNamespace(id="a")
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(
        feature_flags=flags, hosted_box_provisioning=on
    )
    listed = TestClient(app).get("/agent/feature-flags").json()["flags"]
    keys = [flag["key"] for flag in listed]
    if on:
        assert keys == list(flags)
    else:
        assert keys == [ECOSYSTEM_SHOW_OWNERS]


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
    principal = ControllerPrincipal(controller_id="c", owner_id="u", tenant_id="t-2")
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
        assert hosted_machines.machines_enabled(config, settings, "any-user")  # type: ignore[arg-type]


async def _sync(check: Any, authenticator: object) -> None:
    """A sync dependency, run as the awaited checks are."""
    check(SimpleNamespace(), authenticator)
