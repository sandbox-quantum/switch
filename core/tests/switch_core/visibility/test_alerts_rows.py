"""Hosted alerts against a real Postgres, as Core's restricted runtime role.

The rows, the 10-minute limit, two writers at once, the overview's shape, the
notifier's queue, the audit log hiding alerts, and the evaluator's lock.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import CloudMachine, User
from switch_core.visibility.alerts import (
    BOX_CONDITIONS,
    CLUSTER_CONDITIONS,
    AlertEvaluator,
    Condition,
    Verdict,
    action_alert,
    apply_alert,
    apply_verdicts,
    open_alerts,
    overview_alerts,
    raised_since,
    turn_off_target,
)
from switch_core.visibility.audit_routes import list_operator_audit_events
from switch_core.visibility.box_facts import with_box_facts
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")
NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
OPERATOR = SimpleNamespace(id="op-1")
NODE = "ip-10-0-1-7"


def _memory(true_now: bool, pct: float | None = 90.0) -> Verdict:
    return Verdict(Condition.MACHINE_MEMORY, NODE, true_now, pct)


async def test_raise_once_clear_once_and_the_10_minute_limit(
    rls_harness: RLSHarness,
) -> None:
    f = rls_harness.restricted
    assert await apply_alert(f, _memory(True), NOW) == "raised"
    assert await apply_alert(f, _memory(True), NOW + timedelta(minutes=1)) is None
    assert await apply_alert(f, _memory(False), NOW + timedelta(minutes=2)) == "cleared"
    assert await apply_alert(f, _memory(False), NOW + timedelta(minutes=3)) is None
    # True again within 10 minutes of the raise: held back.
    assert await apply_alert(f, _memory(True), NOW + timedelta(minutes=5)) is None
    assert await apply_alert(f, _memory(True), NOW + timedelta(minutes=11)) == "raised"


async def test_two_writers_at_once_raise_one_alert(rls_harness: RLSHarness) -> None:
    results = await asyncio.gather(
        *(apply_alert(rls_harness.restricted, _memory(True), NOW) for _ in range(5))
    )
    assert results.count("raised") == 1
    async with rls_harness.restricted() as session:
        assert len(await open_alerts(session)) == 1


async def test_a_target_no_longer_reported_is_cleared(rls_harness: RLSHarness) -> None:
    f = rls_harness.restricted
    await apply_verdicts(f, [_memory(True)], CLUSTER_CONDITIONS, NOW)
    # The node left the report entirely.
    await apply_verdicts(f, [], CLUSTER_CONDITIONS, NOW + timedelta(minutes=1))
    async with f() as session:
        assert await open_alerts(session) == []


async def test_the_evaluator_leaves_v3s_action_alerts_alone(
    rls_harness: RLSHarness,
) -> None:
    """A8 to A11 are raised and cleared by their own actions, never the evaluator."""
    f = rls_harness.restricted
    user = KEY.keyed_id(KeyedIdKind.USER, "user-1")
    member = turn_off_target(user, KEY.keyed_id(KeyedIdKind.WORKSPACE, "workspace-1"))
    pause = Verdict(Condition.PAUSE_FAILED, user, True)
    turn_off = Verdict(Condition.TURN_OFF_FAILED, member, True)
    assert await apply_alert(f, pause, NOW) == "raised"
    assert await apply_alert(f, turn_off, NOW) == "raised"
    cap = Verdict(Condition.BOX_CAP_REACHED, "rate", True, 5)
    assert await apply_alert(f, cap, NOW) == "raised"
    operator = KEY.keyed_id(KeyedIdKind.USER, "operator-1")
    bulk = Verdict(Condition.OPERATOR_BULK_ACTIONS, operator, True, 5)
    assert await apply_alert(f, bulk, NOW) == "raised"
    await apply_verdicts(f, [], BOX_CONDITIONS | {Condition.CLUSTER_REPORT_LATE}, NOW)
    await apply_verdicts(f, [], CLUSTER_CONDITIONS, NOW)
    async with f() as session:
        assert sorted(a.condition for a in await open_alerts(session)) == [
            Condition.BOX_CAP_REACHED,
            Condition.OPERATOR_BULK_ACTIONS,
            Condition.PAUSE_FAILED,
            Condition.TURN_OFF_FAILED,
        ]


async def test_a11_raises_and_clears_on_its_own_calls(rls_harness: RLSHarness) -> None:
    """The rate-limit code raises A11, then clears it with a false verdict."""
    f = rls_harness.restricted
    operator = KEY.keyed_id(KeyedIdKind.USER, "operator-1")
    bulk = Verdict(Condition.OPERATOR_BULK_ACTIONS, operator, True, 5)
    assert await apply_alert(f, bulk, NOW) == "raised"
    quiet = Verdict(Condition.OPERATOR_BULK_ACTIONS, operator, False)
    assert await apply_alert(f, quiet, NOW + timedelta(minutes=10)) == "cleared"
    async with f() as session:
        assert await open_alerts(session) == []


async def test_a_bad_target_is_never_written(rls_harness: RLSHarness) -> None:
    bad = Verdict(Condition.BOX_EVICTED, "6f1c2a9e-raw-machine-id", True, 1)
    assert await apply_alert(rls_harness.restricted, bad, NOW) is None
    async with rls_harness.restricted() as session:
        assert await open_alerts(session) == []


async def test_the_overview_shape_and_the_notifier_queue(
    rls_harness: RLSHarness,
) -> None:
    f = rls_harness.restricted
    now = datetime.now(UTC)
    await apply_alert(f, _memory(True), now - timedelta(minutes=30))
    await apply_alert(f, _memory(False), now - timedelta(minutes=20))
    box = KEY.keyed_id(KeyedIdKind.BOX, "machine-1")
    await apply_alert(f, Verdict(Condition.BOX_RESTARTS, box, True, 4), now)
    async with f() as session:
        items = await overview_alerts(session, now)
        queue = await raised_since(session, None)
    assert [set(i) for i in items] == [
        {"id", "severity", "title", "detail", "raised_at", "cleared_at"}
    ] * 2
    newest, older = items
    assert newest["title"] == f"Box `{box}` restarted 4 times in the last hour"
    assert newest["cleared_at"] is None
    assert older["cleared_at"] is not None
    assert [a.condition for a in queue] == [
        Condition.MACHINE_MEMORY,
        Condition.BOX_RESTARTS,
    ]
    async with f() as session:
        assert (
            await raised_since(session, (queue[-1].raised_at, queue[-1].event_id)) == []
        )


async def test_the_audit_log_hides_alerts_unless_asked(rls_harness: RLSHarness) -> None:
    await apply_alert(rls_harness.restricted, _memory(True), NOW)
    async with rls_harness.restricted() as session:
        default = await list_operator_audit_events(session, OPERATOR)  # type: ignore[arg-type]
        asked = await list_operator_audit_events(
            session,
            OPERATOR,  # type: ignore[arg-type]
            action=ServerAuditAction.ALERT_RAISED.value,
        )
    assert default == []
    assert [e.target_id for e in asked] == [NODE]


def _unpooled(url: str) -> AsyncEngine:
    return create_async_engine(url, poolclass=NullPool)


async def _box(rls_harness: RLSHarness, heartbeat: dict) -> str:
    now = datetime.now(UTC)
    async with rls_harness.owner() as session:
        user = User(name="owner", email=f"{uuid4()}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        machine = CloudMachine(
            id=str(uuid4()),
            owner_id=user.id,
            state="ready",
            desired_state="running",
            revision=1,
            active_at=now,
            created_at=now,
            updated_at=now,
            heartbeat=heartbeat,
            heartbeat_at=now,
        )
        session.add(machine)
        await session.commit()
        return machine.id


async def test_one_evaluator_at_a_time_and_its_box_alerts(
    rls_harness: RLSHarness,
) -> None:
    now = datetime.now(UTC)
    heartbeat = with_box_facts(None, node=NODE, restarts=4, evictions=0, now=now)
    machine_id = await _box(rls_harness, heartbeat)
    url = rls_harness.restricted_engine.url.render_as_string(hide_password=False)
    first = AlertEvaluator(
        lambda: _unpooled(url),
        rls_harness.restricted,
        KEY,
        lambda: None,
        clock=lambda: now,
    )
    second = AlertEvaluator(
        lambda: _unpooled(url),
        rls_harness.restricted,
        KEY,
        lambda: None,
        clock=lambda: now,
    )
    try:
        assert await first.evaluate_once() is not None
        assert await second.evaluate_once() is None
        assert list(second.readings()) == []
        async with rls_harness.restricted() as session:
            current = await open_alerts(session)
        assert [(a.condition, a.target_id) for a in current] == [
            (Condition.BOX_RESTARTS, KEY.keyed_id(KeyedIdKind.BOX, machine_id))
        ]
        assert machine_id not in json.dumps([a.target_id for a in current])
        gauges = {r.attributes["condition"]: r.value for r in first.readings()}
        assert gauges["box_restarts"] == 1.0
    finally:
        await first.aclose()
        await second.aclose()


async def test_v3s_hook_raises_and_clears_a9(rls_harness: RLSHarness) -> None:
    """The wiring the hosted alerts add where `HostedAccess` is made: a failed turn-off
    raises A9 for that person in that workspace, and turning on clears it."""
    hook = action_alert(rls_harness.restricted)
    user = KEY.keyed_id(KeyedIdKind.USER, "user-1")
    workspace = KEY.keyed_id(KeyedIdKind.WORKSPACE, "workspace-1")
    await hook("turn_off", user, workspace, True)
    async with rls_harness.restricted() as session:
        current = await open_alerts(session)
    assert [(a.condition, a.target_id) for a in current] == [
        (Condition.TURN_OFF_FAILED, turn_off_target(user, workspace))
    ]
    await hook("turn_off", user, workspace, False)
    async with rls_harness.restricted() as session:
        assert await open_alerts(session) == []
