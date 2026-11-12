"""Draining a machine, Core's side. Core checks a drain and records it; the operator does the work.

What the code must do: the daily cap, A11 on any drain, the claim and race
cases, and a node with no uid refused. The merge rule: a drain goes through
`limited_request` and counts alongside pause and restart."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text, update

from switch_core.db.audit import AuditAction, ServerAuditAction
from switch_core.db.models import (
    AuditEvent,
    CloudMachine,
    ServerAuditEvent,
    TenantMember,
    User,
)
from switch_core.tenant_context import tenant_scope
from switch_core.visibility import cluster_report, operator_limits
from switch_core.visibility import operator_actions as operator_actions_module
from switch_core.visibility.alerts import Condition, open_alerts
from switch_core.visibility.audit_log import record_operator_request
from switch_core.visibility.hosted_access import block_reason
from switch_core.visibility.hosted_access_routes import _operator_action
from switch_core.visibility.keyed_id import KeyedIdKind
from switch_core.visibility.operator_action_routes import (
    ReasonBody,
    drain_machine,
    restart_box,
)
from switch_core.visibility.operator_actions import (
    ActionRefused,
    OperatorActions,
    drain_window,
)
from switch_core.visibility.operator_limits import (
    DEFAULTS,
    Limits,
    clear_quiet_bulk_alerts,
    warn_raised_limits,
)
from switch_core.visibility.reason_codes import StopReason
from tests.conftest import RLSHarness
from tests.switch_core.visibility.test_hosted_access import (
    KEY,
    FakeRevoker,
    _access,
    _box,
    _server_entries,
    _world,
)

pytestmark = pytest.mark.no_ambient_tenant

NODE = "ip-10-0-0-1"
OTHER_NODE = "ip-10-0-0-2"
UID = "0f6c2a1e-6c8b-4d4e-9a57-3b2f1d0c9e8a"
NEW_UID = "7d3b9e41-2a5c-4f60-8b1d-9c0e2f4a6b8d"
CONFIG = SimpleNamespace(**DEFAULTS)
LIMITS = Limits.from_config(CONFIG)  # type: ignore[arg-type]
MARKER = "MARKER-DRAIN-REASON-9"


@pytest.fixture(autouse=True)
def _no_report():
    cluster_report.forget_cluster_report()
    yield
    cluster_report.forget_cluster_report()


def _report(
    nodes: list[tuple[str, str | None]] | None = None, *, ago: timedelta | None = None
) -> None:
    """Keep a cluster report naming these (node, uid) pairs, received `ago`."""
    report = cluster_report.ClusterReport.model_validate(
        {
            "nodes": [
                {
                    "name": name,
                    "zone": "eu-west-3a",
                    "gate": "passed",
                    **({"uid": uid} if uid else {}),
                }
                for name, uid in (nodes if nodes is not None else [(NODE, UID)])
            ],
            "services": [],
        }
    )
    cluster_report.keep_cluster_report(
        report, now=datetime.now(UTC) - (ago or timedelta())
    )


def _machine_keyed(name: str = NODE) -> str:
    return KEY.keyed_id(KeyedIdKind.MACHINE, name)


def _actions(rls_harness: RLSHarness, now=None) -> OperatorActions:
    return OperatorActions(
        session_factory=rls_harness.restricted,
        key=KEY,
        **({"now": now} if now else {}),
    )


async def _on_node(rls_harness: RLSHarness, machine_id: str, node: str) -> None:
    """Where the operator last saw the box (the operator overview's box facts)."""
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        machine.heartbeat = {**(machine.heartbeat or {}), "box": {"node": node}}
        await session.commit()


async def _member(rls_harness: RLSHarness, tenants: list[str]) -> str:
    """Another user in these workspaces: one box per owner."""
    user_id = f"user-{uuid.uuid4().hex[:8]}"
    async with rls_harness.owner() as session:
        session.add(
            User(id=user_id, name=user_id, email=f"{user_id}@example.test", role="user")
        )
        await session.flush()
        for tenant_id in tenants:
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=user_id, role="member")
            )
        await session.commit()
    return user_id


async def _boxes(
    rls_harness: RLSHarness, count: int = 1, node: str = NODE, workspaces: int = 1
):
    """`count` boxes on `node`, each with its own owner in the same
    workspaces, and an operator. Returns the first owner."""
    user_id, operator_id, tenants = await _world(rls_harness, workspaces=workspaces)
    machines = []
    for i in range(count):
        owner = user_id if i == 0 else await _member(rls_harness, tenants)
        machine_id, _ = await _box(rls_harness, owner, tenants)
        await _on_node(rls_harness, machine_id, node)
        machines.append(machine_id)
    return user_id, operator_id, tenants, machines


async def _drain(actions: OperatorActions, operator_id: str, keyed: str | None = None):
    return await actions.request_drain(
        actor_id=operator_id,
        machine_keyed_id=keyed or _machine_keyed(),
        reason=MARKER,
        limits=LIMITS,
    )


async def _drain_route(actions: OperatorActions, operator_id: str, keyed=None):
    return await drain_machine(
        keyed or _machine_keyed(),
        ReasonBody(reason=MARKER),
        SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
        actions,
        CONFIG,  # type: ignore[arg-type]
    )


async def _drains(rls_harness: RLSHarness) -> list[ServerAuditEvent]:
    """Drain request entries (not their steps or results)."""
    return [
        e
        for e in await _server_entries(rls_harness)
        if e.action == ServerAuditAction.HOSTED_MACHINE_DRAINED.value
        and (e.details or {}).get("phase") == "requested"
    ]


async def _action_entries(rls_harness: RLSHarness) -> list[ServerAuditEvent]:
    """Operator action entries, leaving out alert rows: a refused request
    still raises A11 for an operator with a drain in the window, and that's
    an alert, not an action written."""
    return [
        e
        for e in await _server_entries(rls_harness)
        if not e.action.startswith("alert.")
    ]


async def _results(rls_harness: RLSHarness, action_id: str) -> list[dict]:
    return [
        e.details or {}
        for e in await _server_entries(rls_harness)
        if (e.details or {}).get("linked_to") == action_id
        and (e.details or {}).get("phase") == "result"
    ]


async def _operator(rls_harness: RLSHarness) -> str:
    """A fresh operator with no actions of their own."""
    _, operator_id, _ = await _world(rls_harness)
    return operator_id


async def _past_drains(
    rls_harness: RLSHarness, count: int, *, ago: timedelta | None = None, **extra
) -> None:
    """`count` earlier drains, ended, each by its own operator, so only the
    server-wide daily cap can refuse the next one."""
    for _ in range(count):
        record = await record_operator_request(
            rls_harness.restricted,
            actor_user_id=await _operator(rls_harness),
            action=ServerAuditAction.HOSTED_MACHINE_DRAINED,
            target_type="machine",
            target_keyed_id=_machine_keyed(f"old-{uuid.uuid4().hex[:6]}"),
            reason="earlier",
            extra={
                "kind": "drain",
                "expires_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
                **extra,
            },
        )
        if ago is not None:
            async with rls_harness.owner() as session:
                await session.execute(
                    update(ServerAuditEvent)
                    .where(ServerAuditEvent.id == record.event_id)
                    .values(occurred_at=datetime.now(UTC) - ago)
                )
                await session.commit()


async def _past_actions(
    rls_harness: RLSHarness, operator_id: str, action: ServerAuditAction, count: int
) -> None:
    """Earlier requests by `operator_id`. A restart's carries its window, as
    every real one does, already past."""
    target = KEY.keyed_id(KeyedIdKind.USER, f"someone-{uuid.uuid4().hex[:6]}")
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    extra = (
        {"kind": "restart", "expires_at": past}
        if action == ServerAuditAction.HOSTED_BOX_RESTARTED
        else None
    )
    for _ in range(count):
        await record_operator_request(
            rls_harness.restricted,
            actor_user_id=operator_id,
            action=action,
            target_type="user",
            target_keyed_id=target,
            reason="earlier",
            extra=extra,
        )


# ── The request ──────────────────────────────────────────────────────────────


async def test_a_drain_is_recorded_with_the_nodes_uid_its_boxes_and_its_window(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, [x], _machines = await _boxes(rls_harness, count=2)
    _report()
    actions = _actions(rls_harness)
    before = datetime.now(UTC)
    answer = await _drain_route(actions, operator_id)
    [request] = [e for e in await _drains(rls_harness) if e.id == answer.action_id]
    details = request.details or {}
    assert (request.target_type, request.target_id) == ("machine", _machine_keyed())
    assert (details["kind"], details["boxes"], details["node_uid"]) == (
        "drain",
        2,
        UID,
    )
    expires = datetime.fromisoformat(details["expires_at"])
    # 15 minutes for room and 5 per box.
    assert before + timedelta(minutes=25) <= expires
    assert expires <= datetime.now(UTC) + timedelta(minutes=25)
    assert NODE not in repr(details)  # the log holds the keyed id, never the name
    # The workspace copy says an operator drained a machine, with a reason,
    # but never the reason or the uid.
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            copies = (
                await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.action == AuditAction.HOSTED_OPERATOR_ACTION
                    )
                )
            ).all()
    [mine] = [c for c in copies if c.details.get("server_event_id") == request.id]
    assert mine.details.get("has_reason") is True
    assert "reason" not in mine.details
    for secret in (MARKER, UID, NODE):
        assert secret not in repr(mine.details)


def test_the_window_is_15_minutes_and_5_per_box_capped_at_4_hours() -> None:
    assert drain_window(1) == timedelta(minutes=20)
    assert drain_window(10) == timedelta(minutes=65)
    assert drain_window(200) == timedelta(hours=4)


async def test_overlapping_workspaces_get_one_copy_each(
    rls_harness: RLSHarness,
) -> None:
    """Two boxes in workspace X and one also in Y give one copy in
    each workspace, from the union over the node's boxes."""
    user_id, operator_id, [x, y] = await _world(rls_harness, workspaces=2)
    first, _ = await _box(rls_harness, user_id, [x, y])
    second, _ = await _box(rls_harness, await _member(rls_harness, [x]), [x])
    for machine_id in (first, second):
        await _on_node(rls_harness, machine_id, NODE)
    _report()
    request = await _drain(_actions(rls_harness), operator_id)
    assert sorted(t for t, _k, _c in request.workspace_copies) == sorted([x, y])


async def test_a_stale_or_missing_report_is_a_409_with_nothing_written(
    rls_harness: RLSHarness,
) -> None:
    """Fresh means Core's own receive time, never a time the report
    claims. Received 3 minutes ago is stale."""
    _, operator_id, _, _ = await _boxes(rls_harness)
    actions = _actions(rls_harness)
    for keep in (None, timedelta(minutes=3)):
        if keep is not None:
            _report(ago=keep)
        with pytest.raises(ActionRefused) as stale:
            await _drain(actions, operator_id)
        assert (stale.value.status, stale.value.code) == (409, "report_stale")
    assert await _server_entries(rls_harness) == []
    _report(ago=timedelta(seconds=90))
    await _drain(actions, operator_id)


async def test_only_a_nodes_keyed_id_finds_it(rls_harness: RLSHarness) -> None:
    """A raw node name writes nothing (404). A box's or user's keyed id, or a
    node no longer in the report, is a well-formed unknown: audited as
    `not_found`, then 404, as for restart."""
    user_id, operator_id, _, [machine_id] = await _boxes(rls_harness)
    _report([(OTHER_NODE, UID)])  # NODE has left the report
    actions = _actions(rls_harness)
    with pytest.raises(HTTPException) as raw:
        await _drain_route(actions, operator_id, keyed=NODE)
    assert raw.value.status_code == 404
    assert await _server_entries(rls_harness) == []
    for wrong in (
        _machine_keyed(),
        KEY.keyed_id(KeyedIdKind.BOX, machine_id),
        KEY.keyed_id(KeyedIdKind.USER, user_id),
    ):
        with pytest.raises(ActionRefused) as unknown:
            await _drain(actions, operator_id, keyed=wrong)
        assert unknown.value.status == 404
        [request] = [e for e in await _drains(rls_harness) if e.target_id == wrong]
        assert (request.details or {}).get("not_found") is True
        assert [r["step"] for r in await _results(rls_harness, request.id)] == [
            "not_found"
        ]


async def test_a_node_with_no_uid_is_refused_with_nothing_written_or_counted(
    rls_harness: RLSHarness,
) -> None:
    """The node uid is optional: a drain could never be pinned
    to the machine chosen, so it's refused before anything is written."""
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report([(NODE, None)])
    with pytest.raises(HTTPException) as refused:
        await _drain_route(_actions(rls_harness), operator_id)
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "node_uid_missing"
    assert await _server_entries(rls_harness) == []


# ── Refusals, each writing and counting nothing ─────────────────────────────


async def test_one_drain_at_a_time_anywhere(rls_harness: RLSHarness) -> None:
    _, operator_id, _, _ = await _boxes(rls_harness)
    user_2, _, tenants_2 = await _world(rls_harness)
    other, _ = await _box(rls_harness, user_2, tenants_2)
    await _on_node(rls_harness, other, OTHER_NODE)
    _report([(NODE, UID), (OTHER_NODE, NEW_UID)])
    actions = _actions(rls_harness)
    first = await _drain(actions, operator_id)
    before = len(await _action_entries(rls_harness))
    with pytest.raises(HTTPException) as second:
        await _drain_route(actions, operator_id, keyed=_machine_keyed(OTHER_NODE))
    assert second.value.status_code == 409
    detail = second.value.detail
    assert detail["code"] == "drain_open"
    assert detail["operator"] == KEY.keyed_id(KeyedIdKind.USER, operator_id)
    [opened] = [e for e in await _drains(rls_harness) if e.id == first.event_id]
    assert detail["started_at"] == opened.occurred_at.isoformat()
    assert MARKER not in repr(detail)  # never echoes the request
    assert len(await _action_entries(rls_harness)) == before


async def test_a_restart_open_on_the_node_refuses_the_drain(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, _, [machine_id] = await _boxes(rls_harness)
    _report()
    actions = _actions(rls_harness)
    await actions.request_restart(
        actor_id=operator_id,
        box_keyed_id=KEY.keyed_id(KeyedIdKind.BOX, machine_id),
        reason="first",
    )
    before = len(await _action_entries(rls_harness))
    with pytest.raises(ActionRefused) as refused:
        await _drain(actions, operator_id)
    assert (refused.value.status, refused.value.code) == (409, "restart_open")
    assert set(refused.value.fields) == {"started_at", "operator"}
    assert len(await _action_entries(rls_harness)) == before


async def test_a_drain_open_on_its_node_refuses_a_restart(
    rls_harness: RLSHarness,
) -> None:
    """The restart check widens to drains: a box on a node being drained can't be
    restarted, so the two can never both start."""
    _, operator_id, _, [machine_id] = await _boxes(rls_harness)
    _report()
    actions = _actions(rls_harness)
    await _drain(actions, operator_id)
    before = len(await _action_entries(rls_harness))
    with pytest.raises(HTTPException) as refused:
        await restart_box(
            KEY.keyed_id(KeyedIdKind.BOX, machine_id),
            ReasonBody(reason="Stuck"),
            SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
            actions,
            CONFIG,  # type: ignore[arg-type]
        )
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "drain_open"
    assert len(await _action_entries(rls_harness)) == before


async def test_a_node_with_no_boxes_is_refused(rls_harness: RLSHarness) -> None:
    _, operator_id, _, _ = await _boxes(rls_harness, node=OTHER_NODE)
    _report([(NODE, UID), (OTHER_NODE, NEW_UID)])
    with pytest.raises(ActionRefused) as refused:
        await _drain(_actions(rls_harness), operator_id)
    assert (refused.value.status, refused.value.code) == (409, "no_boxes")
    assert await _server_entries(rls_harness) == []


# ── The limits: the merge rule ──────────────────────────────────────────────


async def test_a_drain_counts_alongside_pause_and_restart(
    rls_harness: RLSHarness,
) -> None:
    """The merge rule: the drain's request entry goes
    through `limited_request`, sharing restart's limit and A11. Nine earlier
    pauses and restarts, then a drain passes as the 10th, and the next pause
    and the next restart each get 429."""
    user_id, operator_id, _, [machine_id] = await _boxes(rls_harness)
    _report()
    await _past_actions(
        rls_harness, operator_id, ServerAuditAction.HOSTED_USER_PAUSED, 5
    )
    await _past_actions(
        rls_harness, operator_id, ServerAuditAction.HOSTED_BOX_RESTARTED, 4
    )
    actions = _actions(rls_harness)
    calls = []
    real = operator_limits.limited_request

    async def watched(*args, **kwargs):
        calls.append(kwargs["kind"])
        return await real(*args, **kwargs)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(operator_actions_module, "limited_request", watched)
        await _drain_route(actions, operator_id)
    assert calls == ["drain"]
    with pytest.raises(HTTPException) as paused:
        await _operator_action(
            "pause",
            KEY.keyed_id(KeyedIdKind.USER, user_id),
            ReasonBody(reason="Ticket 7"),
            SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
            _access(rls_harness, FakeRevoker()),
            CONFIG,  # type: ignore[arg-type]
        )
    assert paused.value.status_code == 429
    user_2, _, tenants_2 = await _world(rls_harness)
    other, _ = await _box(rls_harness, user_2, tenants_2)
    with pytest.raises(HTTPException) as restarted:
        await restart_box(
            KEY.keyed_id(KeyedIdKind.BOX, other),
            ReasonBody(reason="Stuck"),
            SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
            actions,
            CONFIG,  # type: ignore[arg-type]
        )
    assert restarted.value.status_code == 429


async def test_an_operator_at_their_limit_gets_429_on_drain_and_nothing_listed(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    await _past_actions(
        rls_harness, operator_id, ServerAuditAction.HOSTED_USER_PAUSED, 10
    )
    actions = _actions(rls_harness)
    with pytest.raises(HTTPException) as refused:
        await _drain_route(actions, operator_id)
    assert refused.value.status_code == 429
    assert refused.value.detail["code"] == "rate_limited"
    [request] = await _drains(rls_harness)
    assert (request.details or {}).get("rate_limited") is True
    assert [r["step"] for r in await _results(rls_harness, request.id)] == [
        "rate_limited"
    ]
    assert await actions.open_actions("drain") == []


async def test_the_daily_drain_cap_is_server_wide(rls_harness: RLSHarness) -> None:
    """The cap: three drains in 24 hours across every operator. The
    fourth is refused even for a fresh operator, with its own code as the
    result step. Refused drains don't use the cap up, nor
    do ones for an unknown id, and drains over 24 hours old stop counting."""
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    await _past_drains(rls_harness, 2)
    await _past_drains(rls_harness, 3, ago=timedelta(hours=25))
    await _past_drains(rls_harness, 2, rate_limited=True)
    await _past_drains(rls_harness, 2, not_found=True)
    actions = _actions(rls_harness)
    passed = await _drain(actions, operator_id)  # the third in 24 hours
    # Ended, so the next one meets the cap rather than the one-at-a-time rule.
    async with rls_harness.owner() as session:
        entry = await session.get(ServerAuditEvent, passed.event_id)
        assert entry is not None
        entry.details = {
            **(entry.details or {}),
            "expires_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
        }
        await session.commit()
    fresh = await _operator(rls_harness)
    with pytest.raises(HTTPException) as capped:
        await _drain_route(actions, fresh)
    assert capped.value.status_code == 429
    assert capped.value.detail["code"] == "drain_daily_cap"
    [request] = [e for e in await _drains(rls_harness) if e.actor_user_id == fresh]
    assert (request.details or {}).get("rate_limited") is True
    assert [r["step"] for r in await _results(rls_harness, request.id)] == [
        "drain_daily_cap"
    ]


def test_the_daily_cap_setting_is_bounded_and_a_raise_is_warned(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from switch_core.config import SwitchConfig

    field = SwitchConfig.model_fields["visibility_operator_drains_per_day"]
    bounds = {type(m).__name__: m for m in field.metadata}
    assert field.default == 3 == DEFAULTS["visibility_operator_drains_per_day"]
    assert (bounds["Ge"].ge, bounds["Le"].le) == (1, 20)
    with caplog.at_level(logging.WARNING, logger=operator_limits.__name__):
        warn_raised_limits(
            SimpleNamespace(**{**DEFAULTS, "visibility_operator_drains_per_day": 5})  # type: ignore[arg-type]
        )
    assert "visibility_operator_drains_per_day" in caplog.text


async def test_any_drain_raises_a11_and_the_sweep_keeps_it_while_in_the_window(
    rls_harness: RLSHarness,
) -> None:
    """One drain, with no earlier actions, raises A11 for its operator."""
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    await _drain_route(_actions(rls_harness), operator_id)
    operator_keyed = KEY.keyed_id(KeyedIdKind.USER, operator_id)
    async with rls_harness.restricted() as session:
        raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    assert [a.target_id for a in raised] == [operator_keyed]
    now = datetime.now(UTC)
    assert await clear_quiet_bulk_alerts(rls_harness.restricted, KEY, LIMITS, now) == 0
    later = now + LIMITS.bulk_window + timedelta(minutes=1)
    assert (
        await clear_quiet_bulk_alerts(rls_harness.restricted, KEY, LIMITS, later) == 1
    )


async def test_a_drain_failing_partway_still_counts_towards_a11(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    actions = _actions(rls_harness)

    async def written_then_broken(**kwargs):
        await record_operator_request(
            rls_harness.restricted,
            actor_user_id=operator_id,
            action=ServerAuditAction.HOSTED_MACHINE_DRAINED,
            target_type="machine",
            target_keyed_id=kwargs["machine_keyed_id"],
            reason=kwargs["reason"],
        )
        raise RuntimeError("broke after the request entry")

    actions.request_drain = written_then_broken  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        await _drain_route(actions, operator_id)
    async with rls_harness.restricted() as session:
        raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    assert [a.target_id for a in raised] == [
        KEY.keyed_id(KeyedIdKind.USER, operator_id)
    ]


async def test_a_busy_limit_lock_is_a_503_with_nothing_written(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    monkeypatch.setattr(operator_limits, "LOCK_TIMEOUT_S", 1)
    async with rls_harness.owner() as holder:
        await holder.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "switch.operator_limit:actions"},
        )
        with pytest.raises(HTTPException) as busy:
            await _drain_route(_actions(rls_harness), operator_id)
        await holder.rollback()
    assert busy.value.status_code == 503
    async with rls_harness.owner() as session:
        mine = await session.scalar(
            select(func.count())
            .select_from(ServerAuditEvent)
            .where(ServerAuditEvent.actor_user_id == operator_id)
        )
    assert mine == 0


# ── The operator API ─────────────────────────────────────────────────────────


async def test_the_list_shows_the_node_and_uid_and_nothing_else(
    rls_harness: RLSHarness,
) -> None:
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    actions = _actions(rls_harness)
    request = await _drain(actions, operator_id)
    [listed] = await actions.open_actions("drain")
    assert (listed.action_id, listed.node, listed.node_uid, listed.step) == (
        request.event_id,
        NODE,
        UID,
        None,
    )
    assert listed.counts is None and listed.machine_id is None
    for secret in (MARKER, operator_id):
        assert secret not in repr(listed)
    assert await actions.open_actions("restart") == []


async def test_a_drain_is_hidden_once_its_node_leaves_or_is_replaced(
    rls_harness: RLSHarness,
) -> None:
    """A name back with a different uid is another machine,
    so the drain isn't listed and the operator never acts on it."""
    _, operator_id, _, _ = await _boxes(rls_harness)
    _report()
    actions = _actions(rls_harness)
    await _drain(actions, operator_id)
    _report([(NODE, NEW_UID)])
    assert await actions.open_actions("drain") == []
    _report([(OTHER_NODE, UID)])
    assert await actions.open_actions("drain") == []
    _report()
    assert len(await actions.open_actions("drain")) == 1


# ── Steps ────────────────────────────────────────────────────────────────────


async def _opened(rls_harness: RLSHarness, boxes: int = 2, now=None):
    _, operator_id, _, machines = await _boxes(rls_harness, count=boxes)
    _report()
    actions = _actions(rls_harness, now=now)
    request = await _drain(actions, operator_id)
    return actions, request.event_id, machines


async def _refused_step(actions, action_id, step, state, counts=None) -> int:
    with pytest.raises(ActionRefused) as refused:
        await actions.step(action_id, step, state, counts)
    return refused.value.status


async def test_steps_come_in_order_and_only_two_repeat(
    rls_harness: RLSHarness,
) -> None:
    actions, action_id, _ = await _opened(rls_harness)
    assert await _refused_step(actions, action_id, "room_ok", "running") == 409
    assert await _refused_step(actions, action_id, "unplugged", "running") == 422
    assert await _refused_step(actions, action_id, "node_replaced", "running") == 422
    await actions.step(action_id, "claimed", "running")
    assert await _refused_step(actions, action_id, "claimed", "running") == 409
    await actions.step(action_id, "waiting_for_machine", "running")
    await actions.step(action_id, "waiting_for_machine", "running")
    assert await _refused_step(actions, action_id, "moving", "running", (0, 2)) == 409
    await actions.step(action_id, "room_ok", "running")
    assert await _refused_step(actions, action_id, "room_ok", "running") == 409
    assert (
        await _refused_step(actions, action_id, "waiting_for_machine", "running") == 409
    )
    await actions.step(action_id, "cordoned", "running")
    await actions.step(action_id, "moving", "running", (0, 2))
    await actions.step(action_id, "moving", "running", (1, 2))
    assert await _refused_step(actions, action_id, "cordoned", "running") == 409
    assert await _refused_step(actions, action_id, "cordoned", "done") == 409
    await actions.step(action_id, "moving", "done", (2, 2))
    assert [r["result"] for r in await _results(rls_harness, action_id)] == ["done"]
    assert await _refused_step(actions, action_id, "moving", "running", (2, 2)) == 409
    assert await actions.open_actions("drain") == []


async def test_waiting_for_a_machine_is_optional(rls_harness: RLSHarness) -> None:
    actions, action_id, _ = await _opened(rls_harness, boxes=1)
    for step in ("claimed", "room_ok", "cordoned"):
        await actions.step(action_id, step, "running")
    await actions.step(action_id, "moving", "done", (1, 1))


async def test_counts_are_checked(rls_harness: RLSHarness) -> None:
    actions, action_id, _ = await _opened(rls_harness, boxes=3)
    assert await _refused_step(actions, action_id, "claimed", "running", (0, 3)) == 422
    for step in ("claimed", "room_ok", "cordoned"):
        await actions.step(action_id, step, "running")
    assert await _refused_step(actions, action_id, "moving", "running") == 422
    assert await _refused_step(actions, action_id, "moving", "running", (4, 3)) == 422
    assert await _refused_step(actions, action_id, "moving", "running", (0, 201)) == 422
    assert await _refused_step(actions, action_id, "moving", "running", (-1, 3)) == 422
    await actions.step(action_id, "moving", "running", (2, 3))
    # total is fixed at the first moving step, whatever joins or leaves.
    assert await _refused_step(actions, action_id, "moving", "running", (2, 4)) == 409
    assert await _refused_step(actions, action_id, "moving", "running", (1, 3)) == 409
    assert await _refused_step(actions, action_id, "moving", "done", (2, 3)) == 409
    [listed] = await actions.open_actions("drain")
    assert (listed.step, listed.counts) == ("moving", (2, 3))
    await actions.step(action_id, "moving", "done", (3, 3))


async def test_a_paused_box_counts_as_moved_and_isnt_started(
    rls_harness: RLSHarness,
) -> None:
    """A pause racing a drain, Core's side: a box paused
    mid-drain is off the node, so the operator counts it as moved and the
    drain finishes. The drain writes no box row, so the pause stands. The
    pause revoked that box's controller credentials, and Core now refuses its
    owner, so a pod started on a new node in that second can't reach Core;
    the other owner, drained but not paused, isn't blocked."""
    user_id, operator_id, [x] = await _world(rls_harness)
    paused_box, controllers = await _box(rls_harness, user_id, [x])
    other_owner = await _member(rls_harness, [x])
    other_box, _ = await _box(rls_harness, other_owner, [x])
    machines = [paused_box, other_box]
    for machine_id in machines:
        await _on_node(rls_harness, machine_id, NODE)
    _report()
    actions = _actions(rls_harness)
    action_id = (await _drain(actions, operator_id)).event_id
    for step in ("claimed", "room_ok", "cordoned"):
        await actions.step(action_id, step, "running")
    await actions.step(action_id, "moving", "running", (1, 2))
    revoker = FakeRevoker()
    await _operator_action(
        "pause",
        KEY.keyed_id(KeyedIdKind.USER, user_id),
        ReasonBody(reason="Ticket 7"),
        SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
        _access(rls_harness, revoker),
        CONFIG,  # type: ignore[arg-type]
    )
    await actions.step(action_id, "moving", "done", (2, 2))
    async with rls_harness.owner() as session:
        machine = await session.get(CloudMachine, paused_box)
        assert machine is not None
        assert machine.desired_state != "running"
    assert sorted(revoker.revoked) == sorted(controllers)
    assert (
        await block_reason(rls_harness.restricted, user_id, x)
        == StopReason.PAUSED_BY_SWITCH
    )
    assert await block_reason(rls_harness.restricted, other_owner, x) is None


async def test_failures_record_the_step_reached_and_counts(
    rls_harness: RLSHarness,
) -> None:
    actions, action_id, _ = await _opened(rls_harness)
    for step in ("claimed", "room_ok", "cordoned"):
        await actions.step(action_id, step, "running")
    await actions.step(action_id, "moving", "running", (1, 2))
    assert await _refused_step(actions, action_id, "stopped_partway", "failed") == 422
    await actions.step(action_id, "stopped_partway", "failed", (1, 2))
    [result] = await _results(rls_harness, action_id)
    assert (result["step"], result["reached"], result["moved"], result["total"]) == (
        "stopped_partway",
        "moving",
        1,
        2,
    )
    assert await _refused_step(actions, action_id, "claimed", "running") == 409


async def test_node_replaced_is_recorded_at_any_step(rls_harness: RLSHarness) -> None:
    """The operator refuses with `node_replaced` when the
    live node's uid differs, at claim or later, and Core records it."""
    actions, action_id, _ = await _opened(rls_harness)
    await actions.step(action_id, "claimed", "running")
    await actions.step(action_id, "node_replaced", "failed")
    [result] = await _results(rls_harness, action_id)
    assert (result["step"], result["reached"]) == ("node_replaced", "claimed")
    actions, second, _ = await _opened(rls_harness)
    for step in ("claimed", "room_ok", "cordoned"):
        await actions.step(second, step, "running")
    await actions.step(second, "node_replaced", "failed")
    [result] = await _results(rls_harness, second)
    assert (result["step"], result["reached"]) == ("node_replaced", "cordoned")


async def test_an_unfinished_drain_expires_with_the_step_reached(
    rls_harness: RLSHarness,
) -> None:
    clock = {"now": datetime.now(UTC)}
    actions, action_id, _ = await _opened(
        rls_harness, boxes=1, now=lambda: clock["now"]
    )
    await actions.step(action_id, "claimed", "running")
    clock["now"] += drain_window(1) + timedelta(seconds=1)
    assert await _refused_step(actions, action_id, "room_ok", "running") == 409
    [result] = await _results(rls_harness, action_id)
    assert (result["result"], result["step"], result["reached"]) == (
        "failed",
        "expired",
        "claimed",
    )


async def test_other_drain_failures_may_carry_counts(rls_harness: RLSHarness) -> None:
    """`evict_refused`, `box_not_ready`, `node_replaced` and
    `no_machine_in_time` may say how far the drain got, under the same rules;
    without counts they're still taken."""
    actions, action_id, _ = await _opened(rls_harness, boxes=3)
    for step in ("claimed", "room_ok", "cordoned"):
        await actions.step(action_id, step, "running")
    await actions.step(action_id, "moving", "running", (2, 3))
    assert (
        await _refused_step(actions, action_id, "evict_refused", "failed", (1, 3))
        == 409
    )
    assert (
        await _refused_step(actions, action_id, "evict_refused", "failed", (2, 4))
        == 409
    )
    await actions.step(action_id, "evict_refused", "failed", (2, 3))
    [result] = await _results(rls_harness, action_id)
    assert (result["step"], result["moved"], result["total"]) == (
        "evict_refused",
        2,
        3,
    )
    actions, second, _ = await _opened(rls_harness)
    await actions.step(second, "claimed", "running")
    await actions.step(second, "no_machine_in_time", "failed")
    [result] = await _results(rls_harness, second)
    assert "moved" not in result


async def test_the_worker_refusing_its_own_node_is_recorded(
    rls_harness: RLSHarness,
) -> None:
    """The worker never drains the
    node it runs on. It claims, then says so at once with its own code."""
    actions, action_id, _ = await _opened(rls_harness)
    await actions.step(action_id, "claimed", "running")
    await actions.step(action_id, "own_node", "failed")
    [result] = await _results(rls_harness, action_id)
    assert (result["result"], result["step"], result["reached"]) == (
        "failed",
        "own_node",
        "claimed",
    )
    assert await actions.open_actions("drain") == []


async def test_no_failure_is_taken_before_claimed(
    rls_harness: RLSHarness,
) -> None:
    """A drain takes no failure until it's
    claimed, so a worker can't end a drain it never claimed."""
    actions, action_id, _ = await _opened(rls_harness)
    for failure in (
        "no_machine_in_time",
        "evict_refused",
        "box_not_ready",
        "node_replaced",
        "own_node",
        "cordon_refused",
    ):
        assert await _refused_step(actions, action_id, failure, "failed") == 409
    assert (
        await _refused_step(actions, action_id, "stopped_partway", "failed", (0, 2))
        == 409
    )
    await actions.step(action_id, "claimed", "running")
    await actions.step(action_id, "room_ok", "running")
    await actions.step(action_id, "cordon_refused", "failed")
    [result] = await _results(rls_harness, action_id)
    assert (result["step"], result["reached"]) == ("cordon_refused", "room_ok")
