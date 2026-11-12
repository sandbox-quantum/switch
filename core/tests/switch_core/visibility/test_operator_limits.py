"""The operator rate limits and the bulk-action alert (A11), on real Postgres
through the runtime role. The numbers:
10 actions an hour per operator, 30 across all operators, Show
name at 30, and A11 at 3 actions in 10 minutes. Also D1 (refused
requests don't use up the server-wide limit), D2 (the lock covers only the
count and the request entry, with a timeout) and the lows."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text, update

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import AuditEvent, ServerAuditEvent, User
from switch_core.visibility import alerts as alerts_module
from switch_core.visibility import operator_limits
from switch_core.visibility.alerts import (
    Condition,
    alert_title,
    open_alerts,
    overview_alerts,
)
from switch_core.visibility.audit_log import record_operator_request
from switch_core.visibility.hosted_access import block_reason
from switch_core.visibility.hosted_access_routes import ReasonBody, _operator_action
from switch_core.visibility.keyed_id import KeyedIdKind
from switch_core.visibility.operator_limits import (
    DEFAULTS,
    LimitBusy,
    Limits,
    clear_quiet_bulk_alerts,
    configure_limits,
    limit_slot,
    live_bulk_figures,
    warn_raised_limits,
)
from switch_core.visibility.reason_codes import StopReason
from tests.conftest import RLSHarness
from tests.switch_core.visibility.test_hosted_access import (
    KEY,
    FakeRevoker,
    _access,
    _box,
    _world,
)

pytestmark = pytest.mark.no_ambient_tenant

CONFIG = SimpleNamespace(**DEFAULTS)
LIMITS = Limits.from_config(CONFIG)  # type: ignore[arg-type]


async def _operator(rls_harness: RLSHarness) -> str:
    operator_id = f"operator-{uuid.uuid4().hex[:8]}"
    async with rls_harness.owner() as session:
        session.add(
            User(
                id=operator_id,
                name=operator_id,
                email=f"{operator_id}@example.test",
                role="user",
            )
        )
        await session.commit()
    return operator_id


async def _past_requests(
    rls_harness: RLSHarness,
    operator_id: str,
    count: int,
    action: ServerAuditAction = ServerAuditAction.HOSTED_USER_PAUSED,
    *,
    ago: timedelta | None = None,
) -> None:
    """`count` earlier request entries by `operator_id`, as the audit log keeps
    them; `ago` moves them back in time."""
    target = KEY.keyed_id(KeyedIdKind.USER, f"someone-{uuid.uuid4().hex[:6]}")
    for _ in range(count):
        record = await record_operator_request(
            rls_harness.restricted,
            actor_user_id=operator_id,
            action=action,
            target_type="user",
            target_keyed_id=target,
            reason="earlier",
        )
        if ago is not None:
            async with rls_harness.owner() as session:
                await session.execute(
                    update(ServerAuditEvent)
                    .where(ServerAuditEvent.id == record.event_id)
                    .values(occurred_at=datetime.now(UTC) - ago)
                )
                await session.commit()


async def _act(
    rls_harness: RLSHarness, access, operator_id: str, user_id: str, action="pause"
):
    return await _operator_action(
        action,
        KEY.keyed_id(KeyedIdKind.USER, user_id),
        ReasonBody(reason="Ticket 7"),
        SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
        access,
        CONFIG,  # type: ignore[arg-type]
    )


async def _results(rls_harness: RLSHarness, step: str) -> int:
    async with rls_harness.owner() as session:
        rows = (
            await session.scalars(
                select(ServerAuditEvent).where(
                    ServerAuditEvent.details["phase"].astext == "result"
                )
            )
        ).all()
    return sum(1 for r in rows if (r.details or {}).get("step") == step)


async def test_the_11th_action_in_an_hour_is_refused_audited_and_changes_nothing(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await _past_requests(rls_harness, operator_id, 10)
    with pytest.raises(HTTPException) as refused:
        await _act(rls_harness, access, operator_id, user_id)
    assert refused.value.status_code == 429
    assert refused.value.headers == {"Retry-After": "3600"}
    assert await _results(rls_harness, "rate_limited") == 1
    # Nothing happened: the user isn't paused.
    assert await block_reason(rls_harness.restricted, user_id, None) is None


async def test_mixed_actions_count_together_and_reveals_dont(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    for action in (
        ServerAuditAction.HOSTED_USER_PAUSED,
        ServerAuditAction.HOSTED_USER_RESUMED,
        ServerAuditAction.HOSTED_BOX_RESTARTED,
    ):
        await _past_requests(rls_harness, operator_id, 3, action)
    await _past_requests(
        rls_harness, operator_id, 30, ServerAuditAction.OPERATOR_NAME_REVEALED
    )
    # 9 actions so far: the 10th passes, the 11th doesn't.
    await _act(rls_harness, access, operator_id, user_id)
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )
    with pytest.raises(HTTPException) as refused:
        await _act(rls_harness, access, operator_id, user_id, "resume")
    assert refused.value.status_code == 429
    # And the 30 reveals left actions alone, but the reveal limit is reached.
    async with limit_slot(
        rls_harness.restricted, operator_id, "reveal", LIMITS, datetime.now(UTC)
    ) as over:
        assert over == "rate_limited"


async def test_the_server_wide_ceiling_holds_across_operators(
    rls_harness: RLSHarness,
) -> None:
    user_id, _operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    for _ in range(3):
        await _past_requests(rls_harness, await _operator(rls_harness), 10)
    fresh = await _operator(rls_harness)
    with pytest.raises(HTTPException) as refused:
        await _act(rls_harness, access, fresh, user_id)
    assert refused.value.status_code == 429


async def test_the_hour_rolls_on(rls_harness: RLSHarness) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await _past_requests(rls_harness, operator_id, 10, ago=timedelta(minutes=61))
    await _act(rls_harness, access, operator_id, user_id)
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )


async def test_two_requests_at_once_on_the_last_slot_let_one_through(
    rls_harness: RLSHarness,
) -> None:
    first, operator_id, _ = await _world(rls_harness)
    second, _other, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await _past_requests(rls_harness, operator_id, 9)
    outcomes = await asyncio.gather(
        _act(rls_harness, access, operator_id, first),
        _act(rls_harness, access, operator_id, second),
        return_exceptions=True,
    )
    refused = [o for o in outcomes if isinstance(o, HTTPException)]
    assert len(refused) == 1 and refused[0].status_code == 429
    assert await _results(rls_harness, "rate_limited") == 1


async def test_the_third_action_in_ten_minutes_raises_a11_and_quiet_clears_it(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    operator_keyed = KEY.keyed_id(KeyedIdKind.USER, operator_id)
    await _past_requests(rls_harness, operator_id, 1)
    await _act(rls_harness, access, operator_id, user_id)
    async with rls_harness.restricted() as session:
        assert await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,)) == []
    await _act(rls_harness, access, operator_id, user_id, "resume")
    async with rls_harness.restricted() as session:
        raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    assert [(a.target_id, a.figure) for a in raised] == [(operator_keyed, 3)]
    # Still 3 in the window: the sweep leaves it raised.
    now = datetime.now(UTC)
    assert await clear_quiet_bulk_alerts(rls_harness.restricted, KEY, LIMITS, now) == 0
    # Ten quiet minutes on, it clears.
    later = now + timedelta(minutes=11)
    assert (
        await clear_quiet_bulk_alerts(rls_harness.restricted, KEY, LIMITS, later) == 1
    )
    async with rls_harness.restricted() as session:
        assert await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,)) == []


async def test_a_refused_action_still_counts_towards_the_bulk_alert(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await _past_requests(rls_harness, operator_id, 10)
    with pytest.raises(HTTPException):
        await _act(rls_harness, access, operator_id, user_id)
    async with rls_harness.restricted() as session:
        raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    assert [a.target_id for a in raised] == [
        KEY.keyed_id(KeyedIdKind.USER, operator_id)
    ]


async def test_a_raw_id_is_a_plain_404_with_nothing_written_or_counted(
    rls_harness: RLSHarness,
) -> None:
    _user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    with pytest.raises(HTTPException) as refused:
        await _operator_action(
            "pause",
            "not-a-keyed-id",
            ReasonBody(reason="Ticket 7"),
            SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
            access,
            CONFIG,  # type: ignore[arg-type]
        )
    assert refused.value.status_code == 404
    # Only this operator's rows, so other tests' rows don't matter.
    async with rls_harness.owner() as session:
        mine = await session.scalar(
            select(func.count())
            .select_from(ServerAuditEvent)
            .where(ServerAuditEvent.actor_user_id == operator_id)
        )
    assert mine == 0


def test_a_looser_limit_is_named_at_start(caplog: pytest.LogCaptureFixture) -> None:
    looser = SimpleNamespace(
        **{
            **DEFAULTS,
            "visibility_operator_actions_per_hour": 50,
            "visibility_operator_bulk_window_minutes": 5,
        }
    )
    with caplog.at_level(logging.WARNING):
        warn_raised_limits(looser)  # type: ignore[arg-type]
        warn_raised_limits(CONFIG)  # type: ignore[arg-type]
    named = [r.args[0] for r in caplog.records if r.args]
    assert sorted(named) == [
        "visibility_operator_actions_per_hour",
        "visibility_operator_bulk_window_minutes",
    ]


# ── v1.1 ────────────────────────────────────────────────────────────────────


async def test_refused_requests_never_use_up_the_server_wide_limit(
    rls_harness: RLSHarness,
) -> None:
    """D1: operator A at their own limit sends 20 refused requests, which
    would fill the server-wide 30 if they counted. Operator B can still act."""
    user_id, operator_a, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await _past_requests(rls_harness, operator_a, 10)
    for _ in range(20):
        with pytest.raises(HTTPException) as refused:
            await _act(rls_harness, access, operator_a, user_id)
        assert refused.value.status_code == 429
    operator_b = await _operator(rls_harness)
    await _act(rls_harness, access, operator_b, user_id)
    assert (
        await block_reason(rls_harness.restricted, user_id, None)
        is StopReason.PAUSED_BY_SWITCH
    )


async def test_a_refused_request_is_marked_and_gets_no_workspace_copies(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    await _past_requests(rls_harness, operator_id, 10)
    with pytest.raises(HTTPException):
        await _act(rls_harness, access, operator_id, user_id)
    async with rls_harness.owner() as session:
        requests = (
            await session.scalars(
                select(ServerAuditEvent).where(
                    ServerAuditEvent.actor_user_id == operator_id,
                    ServerAuditEvent.details["phase"].astext == "requested",
                    ServerAuditEvent.target_id
                    == KEY.keyed_id(KeyedIdKind.USER, user_id),
                )
            )
        ).all()
        copies = await session.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.tenant_id.in_(tenants))
        )
    assert [(r.details or {}).get("rate_limited") for r in requests] == [True]
    assert copies == 0
    # Its own limit still counts it.
    async with limit_slot(
        rls_harness.restricted, operator_id, "action", LIMITS, datetime.now(UTC)
    ) as over:
        assert over == "rate_limited"


async def test_an_accepted_request_is_written_once_with_its_workspace_copies(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, tenants = await _world(rls_harness, workspaces=2)
    access = _access(rls_harness, FakeRevoker())
    answer = await _act(rls_harness, access, operator_id, user_id)
    async with rls_harness.owner() as session:
        requests = (
            await session.scalars(
                select(ServerAuditEvent).where(
                    ServerAuditEvent.actor_user_id == operator_id,
                    ServerAuditEvent.details["phase"].astext == "requested",
                )
            )
        ).all()
        copies = await session.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(
                AuditEvent.tenant_id.in_(tenants),
                AuditEvent.details["phase"].astext == "requested",
            )
        )
    assert [r.id for r in requests] == [answer.action_id]
    assert "rate_limited" not in (requests[0].details or {})
    assert copies == 2


async def _lock_is_free(rls_harness: RLSHarness, key: str) -> bool:
    async with rls_harness.owner() as session:
        got = await session.scalar(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": key},
        )
        await session.rollback()
    return bool(got)


async def test_the_lock_is_released_before_the_action_runs(
    rls_harness: RLSHarness,
) -> None:
    """D2: the mark and the revoke run with the server-wide lock free."""
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    seen: list[bool] = []
    pause = access.pause

    async def watched_pause(**kwargs):
        seen.append(await _lock_is_free(rls_harness, "switch.operator_limit:actions"))
        return await pause(**kwargs)

    access.pause = watched_pause  # type: ignore[method-assign]
    await _act(rls_harness, access, operator_id, user_id)
    assert seen == [True]


async def test_a_busy_lock_times_out_as_a_503_with_nothing_written(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    monkeypatch.setattr(operator_limits, "LOCK_TIMEOUT_S", 1)
    async with rls_harness.owner() as holder:
        await holder.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "switch.operator_limit:actions"},
        )
        with pytest.raises(LimitBusy):
            async with limit_slot(
                rls_harness.restricted,
                operator_id,
                "action",
                LIMITS,
                datetime.now(UTC),
            ):
                pass
        with pytest.raises(HTTPException) as busy:
            await _act(rls_harness, access, operator_id, user_id)
        await holder.rollback()
    assert busy.value.status_code == 503
    assert busy.value.headers == {"Retry-After": "60"}
    async with rls_harness.owner() as session:
        mine = await session.scalar(
            select(func.count())
            .select_from(ServerAuditEvent)
            .where(ServerAuditEvent.actor_user_id == operator_id)
        )
    assert mine == 0
    assert await block_reason(rls_harness.restricted, user_id, None) is None


async def test_a_raised_a11_shows_the_operators_current_count(
    rls_harness: RLSHarness,
) -> None:
    """The overview's A11 follows the count, not the 3 it was raised
    with."""
    user_id, operator_id, _ = await _world(rls_harness)
    access = _access(rls_harness, FakeRevoker())
    operator_keyed = KEY.keyed_id(KeyedIdKind.USER, operator_id)
    await _past_requests(rls_harness, operator_id, 2)
    await _act(rls_harness, access, operator_id, user_id)  # the 3rd raises it
    await _past_requests(rls_harness, operator_id, 2)  # now 5 in the window
    now = datetime.now(UTC)
    async with rls_harness.restricted() as session:
        live = await live_bulk_figures(session, KEY, LIMITS, now)
        items = await overview_alerts(session, now, live_figures=live)
    assert live[(Condition.OPERATOR_BULK_ACTIONS.value, operator_keyed)] == 5.0
    titles = [i["title"] for i in items if operator_keyed in i["title"]]
    assert titles == [
        f"Operator `{operator_keyed}` made 5 actions in the last 10 minutes"
    ]


async def test_no_live_figures_without_a_raised_a11(rls_harness: RLSHarness) -> None:
    _user_id, operator_id, _ = await _world(rls_harness)
    await _past_requests(rls_harness, operator_id, 2)
    operator_keyed = KEY.keyed_id(KeyedIdKind.USER, operator_id)
    async with rls_harness.restricted() as session:
        live = await live_bulk_figures(session, KEY, LIMITS, datetime.now(UTC))
    assert (Condition.OPERATOR_BULK_ACTIONS.value, operator_keyed) not in live


def test_the_a11_title_takes_the_window_from_the_setting() -> None:
    target = KEY.keyed_id(KeyedIdKind.USER, "someone")
    try:
        configure_limits(
            SimpleNamespace(  # type: ignore[arg-type]
                **{**DEFAULTS, "visibility_operator_bulk_window_minutes": 15}
            )
        )
        assert alert_title(Condition.OPERATOR_BULK_ACTIONS, target, 4) == (
            f"Operator `{target}` made 4 actions in the last 15 minutes"
        )
    finally:
        alerts_module.set_bulk_window_minutes(10)


def test_the_sweep_warns_when_it_cant_start(caplog: pytest.LogCaptureFixture) -> None:
    from switch_core.main import _start_bulk_alert_sweep

    config = SimpleNamespace(hosted_agents_enabled=True, **DEFAULTS)
    app = SimpleNamespace(state=SimpleNamespace(keyed_id_key=None))
    with caplog.at_level(logging.WARNING):
        task = _start_bulk_alert_sweep(config, app, None)  # type: ignore[arg-type]
    assert task is None
    assert any("sweep isn't running" in r.getMessage() for r in caplog.records)


async def test_a_caller_cant_mark_its_own_request_refused(
    rls_harness: RLSHarness,
) -> None:
    """A caller's own `rate_limited` in `extra` is
    dropped, so it can't hide a real request from the server-wide count."""
    from switch_core.visibility.operator_limits import limited_request

    _user_id, operator_id, _ = await _world(rls_harness)
    target = KEY.keyed_id(KeyedIdKind.USER, f"someone-{uuid.uuid4().hex[:6]}")
    record, over = await limited_request(
        rls_harness.restricted,
        operator_id=operator_id,
        kind="action",
        limits=LIMITS,
        now=datetime.now(UTC),
        action=ServerAuditAction.HOSTED_USER_PAUSED,
        target_type="user",
        target_keyed_id=target,
        reason="Ticket 9",
        extra={"rate_limited": True, "kind": "pause"},
    )
    assert over is None
    async with rls_harness.owner() as session:
        row = await session.get(ServerAuditEvent, record.event_id)
    assert row is not None
    assert "rate_limited" not in (row.details or {})
    assert (row.details or {}).get("kind") == "pause"


async def test_an_action_failing_partway_still_counts_towards_a11(
    rls_harness: RLSHarness,
) -> None:
    """A pause that fails partway, with anything other than
    LookupError, still counts its attempt towards A11. Two earlier requests
    plus this one make the third, which raises it."""

    class BrokenRevoker(FakeRevoker):
        async def revoke_controllers(
            self, session, tenant_id, controller_ids, revoked_by=None
        ):
            raise RuntimeError("revoke failed")

    user_id, operator_id, tenants = await _world(rls_harness)
    await _box(rls_harness, user_id, tenants)
    access = _access(rls_harness, BrokenRevoker())
    await _past_requests(rls_harness, operator_id, 2)
    with pytest.raises(RuntimeError):
        await _act(rls_harness, access, operator_id, user_id)
    async with rls_harness.restricted() as session:
        raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    assert KEY.keyed_id(KeyedIdKind.USER, operator_id) in [a.target_id for a in raised]
