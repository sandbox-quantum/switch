"""The operator restart, Core side: the action record the hosted operator
carries out. Against Postgres."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from switch_core.db.audit import AuditAction, ServerAuditAction
from switch_core.db.models import AuditEvent, CloudMachine
from switch_core.tenant_context import tenant_scope
from switch_core.visibility.keyed_id import KeyedIdKind
from switch_core.visibility.operator_actions import ActionRefused, OperatorActions
from tests.conftest import RLSHarness
from tests.switch_core.visibility.test_hosted_access import (
    KEY,
    _box,
    _server_entries,
    _world,
)

pytestmark = pytest.mark.no_ambient_tenant


def _actions(rls_harness: RLSHarness, now=None) -> OperatorActions:
    return OperatorActions(
        session_factory=rls_harness.restricted,
        key=KEY,
        **({"now": now} if now else {}),
    )


def _box_keyed(machine_id: str) -> str:
    return KEY.keyed_id(KeyedIdKind.BOX, machine_id)


async def _linked(rls_harness: RLSHarness, event_id: str) -> list:
    return [
        e
        for e in await _server_entries(rls_harness)
        if (e.details or {}).get("linked_to") == event_id
    ]


async def test_a_restart_is_recorded_and_listed_with_ids_only(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x, y] = await _world(rls_harness, workspaces=2)
    machine_id, _ = await _box(rls_harness, user_id, [x, y])
    actions = _actions(rls_harness)
    request = await actions.request_restart(
        actor_id=operator_id,
        box_keyed_id=_box_keyed(machine_id),
        reason="MARKER-REASON-7",
    )
    [listed] = await actions.open_actions("restart")
    assert (listed.action_id, listed.kind, listed.machine_id, listed.step) == (
        request.event_id,
        "restart",
        machine_id,
        None,
    )
    assert "MARKER-REASON-7" not in repr(listed)
    # Each workspace the box serves gets its copy, marked as having a reason,
    # but never the reason itself: that stays in the operators' log.
    # Pinned for restarts too.
    for tenant in (x, y):
        with tenant_scope(tenant):
            async with rls_harness.restricted() as session:
                copies = (
                    await session.scalars(
                        select(AuditEvent).where(
                            AuditEvent.action == AuditAction.HOSTED_OPERATOR_ACTION
                        )
                    )
                ).all()
        mine = [
            c for c in copies if c.details.get("server_event_id") == request.event_id
        ]
        assert len(mine) == 1
        assert mine[0].details.get("has_reason") is True
        assert "reason" not in mine[0].details
        assert "MARKER-REASON-7" not in repr(mine[0].details)


async def test_an_unknown_box_is_a_404_audited_and_a_raw_id_writes_nothing(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    actions = _actions(rls_harness)
    nobody = _box_keyed("no-such-box")
    with pytest.raises(ActionRefused) as unknown:
        await actions.request_restart(
            actor_id=operator_id, box_keyed_id=nobody, reason="r"
        )
    assert unknown.value.status == 404
    mine = [e for e in await _server_entries(rls_harness) if e.target_id == nobody]
    assert [e.details["phase"] for e in mine] == ["requested", "result"]
    assert mine[1].details["step"] == "not_found"
    before = len(await _server_entries(rls_harness))
    for wrong in (machine_id, KEY.keyed_id(KeyedIdKind.USER, user_id)):
        with pytest.raises(ActionRefused):
            await actions.request_restart(
                actor_id=operator_id, box_keyed_id=wrong, reason="r"
            )
    # The raw id writes nothing; the user's keyed id is a well-formed unknown box.
    assert len(await _server_entries(rls_harness)) == before + 2


async def test_one_action_at_a_time_and_only_on_a_running_box(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    actions = _actions(rls_harness)
    keyed = _box_keyed(machine_id)
    await actions.request_restart(
        actor_id=operator_id, box_keyed_id=keyed, reason="first"
    )
    with pytest.raises(ActionRefused) as second:
        await actions.request_restart(
            actor_id=operator_id, box_keyed_id=keyed, reason="second"
        )
    assert second.value.status == 409
    assert KEY.keyed_id(KeyedIdKind.USER, operator_id) in second.value.detail
    # A stopped box (here, paused) can't be restarted, so a pause can't be got round.
    user2, operator2, [x2] = await _world(rls_harness)
    machine2, _ = await _box(rls_harness, user2, [x2])
    async with rls_harness.owner() as session:
        m = await session.get(CloudMachine, machine2)
        m.desired_state, m.stop_reason = "stopped", "paused"
        await session.commit()
    before = len(await _server_entries(rls_harness))
    with pytest.raises(ActionRefused) as stopped:
        await actions.request_restart(
            actor_id=operator2, box_keyed_id=_box_keyed(machine2), reason="r"
        )
    assert stopped.value.status == 409
    assert len(await _server_entries(rls_harness)) == before


async def test_two_restarts_at_once_make_one_action(rls_harness: RLSHarness) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    keyed = _box_keyed(machine_id)
    results = await asyncio.gather(
        _actions(rls_harness).request_restart(
            actor_id=operator_id, box_keyed_id=keyed, reason="a"
        ),
        _actions(rls_harness).request_restart(
            actor_id=operator_id, box_keyed_id=keyed, reason="b"
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(r, ActionRefused) and r.status == 409 for r in results) == 1
    assert len(await _actions(rls_harness).open_actions("restart")) == 1


async def test_steps_are_codes_in_order_and_the_first_claim_wins(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    actions = _actions(rls_harness)
    request = await actions.request_restart(
        actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="r"
    )
    aid = request.event_id
    for step, state, status in (
        ("pod_deleted", "running", 409),  # before claimed
        ("made_up", "running", 422),
        ("box_ready", "done", 409),  # out of order
    ):
        with pytest.raises(ActionRefused) as refused:
            await actions.step(aid, step, state)
        assert refused.value.status == status
    await actions.step(aid, "claimed", "running")
    with pytest.raises(ActionRefused) as twice:
        await actions.step(aid, "claimed", "running")
    assert twice.value.status == 409
    await actions.step(aid, "pod_deleted", "running")
    [listed] = await actions.open_actions("restart")
    assert listed.step == "pod_deleted"
    with pytest.raises(ActionRefused):
        await actions.step(aid, "pod_deleted", "done")  # only box_ready finishes
    await actions.step(aid, "box_ready", "done")
    assert await actions.open_actions("restart") == []
    linked = await _linked(rls_harness, aid)
    assert (
        linked[-1].details["phase"] == "result"
        and linked[-1].details["result"] == "done"
    )
    with pytest.raises(ActionRefused) as ended:
        await actions.step(aid, "box_ready", "running")
    assert ended.value.status == 409
    # The workspace's admins see the result linked to their copy.
    with tenant_scope(x):
        async with rls_harness.restricted() as session:
            copies = (
                await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.action == AuditAction.HOSTED_OPERATOR_ACTION
                    )
                )
            ).all()
    [copy] = [c for c in copies if c.details.get("server_event_id") == aid]
    assert [
        c.details["result"] for c in copies if c.details.get("linked_to") == copy.id
    ] == ["done"]


async def test_a_failure_code_ends_the_action_failed_at_that_code(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    actions = _actions(rls_harness)
    request = await actions.request_restart(
        actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="r"
    )
    await actions.step(request.event_id, "claimed", "running")
    await actions.step(request.event_id, "delete_refused", "failed")
    last = (await _linked(rls_harness, request.event_id))[-1]
    assert (last.details["result"], last.details["step"]) == (
        "failed",
        "delete_refused",
    )


async def test_an_expired_action_leaves_the_list_and_refuses_steps(
    rls_harness: RLSHarness,
) -> None:
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    request = await _actions(rls_harness).request_restart(
        actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="r"
    )
    later = _actions(rls_harness, now=lambda: datetime.now(UTC) + timedelta(minutes=11))
    assert await later.open_actions("restart") == []
    last = (await _linked(rls_harness, request.event_id))[-1]
    assert (last.details["result"], last.details["step"]) == ("failed", "expired")
    with pytest.raises(ActionRefused) as refused:
        await later.step(request.event_id, "claimed", "running")
    assert refused.value.status == 409
    # A new restart can be asked for once the old one has ended.
    await later.request_restart(
        actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="again"
    )


async def test_an_unknown_kind_is_refused(rls_harness: RLSHarness) -> None:
    with pytest.raises(ActionRefused) as refused:
        await _actions(rls_harness).open_actions("uncordon")
    assert refused.value.status == 422
    assert ServerAuditAction.HOSTED_BOX_RESTARTED.value == "hosted.box_restarted"


async def test_box_ready_after_the_expiry_is_refused_and_recorded_expired(
    rls_harness: RLSHarness,
) -> None:
    """A `box_ready` that arrives after the 10 minutes gets 409,
    and the action is recorded expired at the step it reached."""
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    actions = _actions(rls_harness)
    request = await actions.request_restart(
        actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="r"
    )
    await actions.step(request.event_id, "claimed", "running")
    await actions.step(request.event_id, "pod_deleted", "running")
    late = _actions(rls_harness, now=lambda: datetime.now(UTC) + timedelta(minutes=11))
    with pytest.raises(ActionRefused) as refused:
        await late.step(request.event_id, "box_ready", "done")
    assert refused.value.status == 409
    last = (await _linked(rls_harness, request.event_id))[-1]
    assert (last.details["result"], last.details["step"], last.details["reached"]) == (
        "failed",
        "expired",
        "pod_deleted",
    )


async def test_a_box_still_being_made_cant_be_restarted(
    rls_harness: RLSHarness,
) -> None:
    """Box provisioning: a freshly claimed box is `running` but `queued`, with no pod
    yet, so a restart is refused and nothing is written."""
    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x], state="queued")
    before = len(await _server_entries(rls_harness))
    with pytest.raises(ActionRefused) as refused:
        await _actions(rls_harness).request_restart(
            actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="r"
        )
    assert refused.value.status == 409
    assert len(await _server_entries(rls_harness)) == before


async def test_a_ready_box_with_an_open_provision_cant_be_restarted(
    rls_harness: RLSHarness,
) -> None:
    """A provision still open on the box means it's being made or remade,
    whatever its state reads, so a restart is refused with nothing written."""
    from switch_core.db.audit import record_server_audit_event

    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    async with rls_harness.owner() as session:
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=_box_keyed(machine_id),
            details={
                "phase": "requested",
                "by": "core",
                "machine_id": machine_id,
                "user": KEY.keyed_id(KeyedIdKind.USER, user_id),
                "size": None,
                "expires_at": (datetime.now(UTC) + timedelta(minutes=15)).isoformat(),
            },
        )
        await session.commit()
    before = len(await _server_entries(rls_harness))
    with pytest.raises(ActionRefused) as refused:
        await _actions(rls_harness).request_restart(
            actor_id=operator_id, box_keyed_id=_box_keyed(machine_id), reason="r"
        )
    assert refused.value.status == 409
    assert len(await _server_entries(rls_harness)) == before


async def test_the_restart_route_counts_towards_the_operator_limit(
    rls_harness: RLSHarness,
) -> None:
    """An operator's 11th action in an hour, here a restart, is audited as
    `rate_limited` and answered 429, and nothing is asked of the cluster."""
    from types import SimpleNamespace

    from fastapi import HTTPException

    from switch_core.visibility.audit_log import record_operator_request
    from switch_core.visibility.operator_action_routes import ReasonBody, restart_box
    from switch_core.visibility.operator_limits import DEFAULTS

    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    for _ in range(10):
        await record_operator_request(
            rls_harness.restricted,
            actor_user_id=operator_id,
            action=ServerAuditAction.HOSTED_USER_PAUSED,
            target_type="user",
            target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, user_id),
            reason="earlier",
        )
    actions = _actions(rls_harness)
    with pytest.raises(HTTPException) as refused:
        await restart_box(
            _box_keyed(machine_id),
            ReasonBody(reason="Stuck"),
            SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
            actions,
            SimpleNamespace(**DEFAULTS),  # type: ignore[arg-type]
        )
    assert refused.value.status_code == 429
    assert await actions.open_actions("restart") == []
    steps = [
        (e.details or {}).get("step")
        for e in await _server_entries(rls_harness)
        if (e.details or {}).get("phase") == "result"
    ]
    assert steps == ["rate_limited"]
    # Marked in its own request entry, so the server-wide count leaves it out.
    marks = [
        (e.details or {}).get("rate_limited")
        for e in await _server_entries(rls_harness)
        if e.action == ServerAuditAction.HOSTED_BOX_RESTARTED.value
        and (e.details or {}).get("phase") == "requested"
    ]
    assert marks == [True]
    # And so it isn't in the server-wide total: still the 10 earlier ones.
    from datetime import UTC, datetime, timedelta

    from switch_core.tenant_context import no_tenant
    from switch_core.visibility.operator_limits import ACTIONS as LIMITED
    from switch_core.visibility.operator_limits import operator_requests_since

    with no_tenant():
        async with rls_harness.restricted() as session:
            server_wide = await operator_requests_since(
                session,
                None,
                LIMITED,
                datetime.now(UTC) - timedelta(hours=1),
                skip_rate_limited=True,
            )
    assert server_wide == 10


async def test_a_restart_waiting_too_long_for_the_limit_lock_is_a_503(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rate limit v1.1's lock timeout reaches restart too: 503, nothing written,
    nothing asked of the cluster."""
    from types import SimpleNamespace

    from fastapi import HTTPException
    from sqlalchemy import text

    from switch_core.visibility import operator_limits
    from switch_core.visibility.operator_action_routes import ReasonBody, restart_box
    from switch_core.visibility.operator_limits import DEFAULTS

    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    actions = _actions(rls_harness)
    monkeypatch.setattr(operator_limits, "LOCK_TIMEOUT_S", 1)
    async with rls_harness.owner() as holder:
        await holder.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "switch.operator_limit:actions"},
        )
        with pytest.raises(HTTPException) as busy:
            await restart_box(
                _box_keyed(machine_id),
                ReasonBody(reason="Stuck"),
                SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
                actions,
                SimpleNamespace(**DEFAULTS),  # type: ignore[arg-type]
            )
        await holder.rollback()
    assert busy.value.status_code == 503
    assert await actions.open_actions("restart") == []
    assert [
        e for e in await _server_entries(rls_harness) if e.actor_user_id == operator_id
    ] == []


async def test_a_restart_failing_partway_still_counts_towards_a11(
    rls_harness: RLSHarness,
) -> None:
    """A restart that fails
    partway with an unexpected error, after its request entry is written,
    still counts that attempt towards A11. Two earlier requests plus this one
    make the third, which raises it, and the error still reaches the caller."""
    from types import SimpleNamespace

    from switch_core.visibility.alerts import Condition, open_alerts
    from switch_core.visibility.audit_log import record_operator_request
    from switch_core.visibility.operator_action_routes import ReasonBody, restart_box
    from switch_core.visibility.operator_limits import DEFAULTS

    user_id, operator_id, [x] = await _world(rls_harness)
    machine_id, _ = await _box(rls_harness, user_id, [x])
    for _ in range(2):
        await record_operator_request(
            rls_harness.restricted,
            actor_user_id=operator_id,
            action=ServerAuditAction.HOSTED_USER_PAUSED,
            target_type="user",
            target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, user_id),
            reason="earlier",
        )
    actions = _actions(rls_harness)

    async def written_then_broken(**kwargs):
        await record_operator_request(
            rls_harness.restricted,
            actor_user_id=operator_id,
            action=ServerAuditAction.HOSTED_BOX_RESTARTED,
            target_type="box",
            target_keyed_id=kwargs["box_keyed_id"],
            reason=kwargs["reason"],
        )
        raise RuntimeError("broke after the request entry")

    actions.request_restart = written_then_broken  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        await restart_box(
            _box_keyed(machine_id),
            ReasonBody(reason="Stuck"),
            SimpleNamespace(id=operator_id),  # type: ignore[arg-type]
            actions,
            SimpleNamespace(**DEFAULTS),  # type: ignore[arg-type]
        )
    async with rls_harness.restricted() as session:
        raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    operator_keyed = KEY.keyed_id(KeyedIdKind.USER, operator_id)
    assert [(a.target_id, a.figure) for a in raised] == [(operator_keyed, 3)]
