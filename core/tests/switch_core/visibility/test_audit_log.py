"""The visibility audit log on the existing tables, through the runtime role.

Operators' entries go to `server_audit_events`; each workspace gets its own copy
of operator actions on its people, as "Switch operator"; a result is a second,
linked entry; workspace admin changes get a server-wide copy for operators.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from switch_core.db.audit import AuditAction, ServerAuditAction
from switch_core.db.models import AuditEvent, ServerAuditEvent, Tenant, User
from switch_core.tenant_context import tenant_scope
from switch_core.visibility.audit_log import (
    REASON_MAX,
    AuditInputError,
    last_recorded_step,
    load_operator_request,
    record_admin_change,
    record_operator_list,
    record_operator_progress,
    record_operator_request,
    record_operator_result,
    recorded_operators,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from switch_core.visibility.operators import (
    OperatorList,
    operators_holding_admin,
    warn_if_operators_hold_admin,
)
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")


async def _tenants(rls_harness: RLSHarness, n: int = 2) -> list[str]:
    suffix = uuid.uuid4().hex[:8]
    ids = [f"tenant-{i}-{suffix}" for i in range(n)]
    async with rls_harness.owner() as session:
        for tenant_id in ids:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    return ids


async def test_an_operator_action_and_its_result_are_two_linked_entries(
    rls_harness: RLSHarness,
) -> None:
    [ws, other] = await _tenants(rls_harness)
    user_k = KEY.keyed_id(KeyedIdKind.USER, "user-1")
    ws_k = KEY.keyed_id(KeyedIdKind.WORKSPACE, ws)

    request = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="operator-1",
        action=ServerAuditAction.HOSTED_USER_PAUSED,
        target_type="user",
        target_keyed_id=user_k,
        reason="Reported misuse, ticket 42",
        workspace_id=ws,
        workspace_keyed_id=ws_k,
    )
    result_id = await record_operator_result(
        rls_harness.restricted, request, result="done"
    )

    async with rls_harness.restricted() as session:
        server = (
            (
                await session.execute(
                    select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
                )
            )
            .scalars()
            .all()
        )
    assert [e.id for e in server] == [request.event_id, result_id]
    first, second = server
    assert first.target_id == user_k and first.details["workspace"] == ws_k
    assert first.details["phase"] == "requested"
    assert first.details["reason"] == "Reported misuse, ticket 42"
    assert second.details == {
        "phase": "result",
        "result": "done",
        "linked_to": request.event_id,
        "workspace": ws_k,
    }
    # No raw workspace id in the operators' log.
    assert ws not in repr([e.details for e in server])

    # The workspace sees both, as "Switch operator", through its own policy.
    with tenant_scope(ws):
        async with rls_harness.restricted() as session:
            copies = (
                (
                    await session.execute(
                        select(AuditEvent).order_by(AuditEvent.occurred_at)
                    )
                )
                .scalars()
                .all()
            )
    assert [c.action for c in copies] == [AuditAction.HOSTED_OPERATOR_ACTION] * 2
    assert all(c.actor_user_id is None for c in copies)
    assert all(c.details["actor_kind"] == "operator" for c in copies)
    assert copies[0].details["server_event_id"] == request.event_id
    assert copies[1].details["linked_to"] == copies[0].id
    assert copies[1].details["server_event_id"] == result_id
    # The operator's reason stays in the operators' log: the
    # workspace's copy only says there was one.
    assert copies[0].details["has_reason"] is True
    assert all("reason" not in c.details for c in copies)
    assert "ticket 42" not in repr([c.details for c in copies])

    # Another workspace sees none of it.
    with tenant_scope(other):
        async with rls_harness.restricted() as session:
            assert (await session.execute(select(AuditEvent))).scalars().all() == []


async def test_a_failed_action_records_the_step_it_reached(
    rls_harness: RLSHarness,
) -> None:
    request = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="operator-1",
        action=ServerAuditAction.HOSTED_MACHINE_DRAINED,
        target_type="machine",
        target_keyed_id=KEY.keyed_id(KeyedIdKind.MACHINE, "m-1"),
        reason="Kernel update",
        extra={"boxes": 4},
    )
    await record_operator_result(
        rls_harness.restricted, request, result="failed", step="moved_2_of_4"
    )
    async with rls_harness.restricted() as session:
        last = (
            await session.execute(
                select(ServerAuditEvent)
                .order_by(ServerAuditEvent.occurred_at.desc())
                .limit(1)
            )
        ).scalar_one()
    assert last.details["result"] == "failed"
    assert last.details["step"] == "moved_2_of_4"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"reason": ""},
        {"reason": "   "},
        {"reason": "x" * (REASON_MAX + 1)},
        {"target_keyed_id": "user-1"},
        {"workspace_id": "w", "workspace_keyed_id": None},
        {"workspace_id": "w", "workspace_keyed_id": "Ada's workspace"},
        {"extra": {"reason": "sneaky"}},
        {"extra": {"note": "x" * 201}},
        {"extra": {"nested": {"a": 1}}},
    ],
)
async def test_bad_input_is_refused_and_nothing_is_written(
    rls_harness: RLSHarness, kwargs: dict
) -> None:
    args = {
        "actor_user_id": "operator-1",
        "action": ServerAuditAction.HOSTED_USER_PAUSED,
        "target_type": "user",
        "target_keyed_id": KEY.keyed_id(KeyedIdKind.USER, "u"),
        "reason": "fine",
        **kwargs,
    }
    with pytest.raises(AuditInputError):
        await record_operator_request(rls_harness.restricted, **args)
    async with rls_harness.owner() as session:
        assert (await session.execute(select(ServerAuditEvent))).scalars().all() == []


async def test_a_reason_of_exactly_500_characters_is_kept_as_typed(
    rls_harness: RLSHarness,
) -> None:
    reason = ("Ünïcode & <b>not html</b> " * 30)[:REASON_MAX]
    request = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="operator-1",
        action=ServerAuditAction.OPERATOR_NAME_REVEALED,
        target_type="user",
        target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "u"),
        reason=reason,
    )
    async with rls_harness.restricted() as session:
        event = await session.get(ServerAuditEvent, request.event_id)
    assert event is not None and event.details["reason"] == reason


async def test_an_admin_change_lands_in_both_logs_in_one_transaction(
    rls_harness: RLSHarness,
) -> None:
    [ws, _] = await _tenants(rls_harness)
    ws_k = KEY.keyed_id(KeyedIdKind.WORKSPACE, ws)
    with tenant_scope(ws):
        async with rls_harness.restricted() as session:
            await record_admin_change(
                session,
                workspace_id=ws,
                workspace_keyed_id=ws_k,
                actor_user_id="admin-1",
                actor_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "admin-1"),
                action=AuditAction.HOSTED_PERSON_TURNED_OFF,
                target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "person-1"),
                result="done",
            )
            await session.rollback()
    async with rls_harness.owner() as session:
        assert (await session.execute(select(AuditEvent))).scalars().all() == []
        assert (await session.execute(select(ServerAuditEvent))).scalars().all() == []

    with tenant_scope(ws):
        async with rls_harness.restricted() as session:
            await record_admin_change(
                session,
                workspace_id=ws,
                workspace_keyed_id=ws_k,
                actor_user_id="admin-1",
                actor_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "admin-1"),
                action=AuditAction.HOSTED_PERSON_TURNED_OFF,
                target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "person-1"),
                result="done",
            )
            await session.commit()
    async with rls_harness.restricted() as session:
        [server] = (await session.execute(select(ServerAuditEvent))).scalars().all()
    assert server.action == ServerAuditAction.HOSTED_ADMIN_CHANGE
    assert server.details["workspace"] == ws_k
    assert server.details["action"] == AuditAction.HOSTED_PERSON_TURNED_OFF
    assert "admin-1" not in repr((server.actor_user_id, server.details))


async def test_operator_list_changes_are_logged_once(rls_harness: RLSHarness) -> None:
    granted, removed = await record_operator_list(
        rls_harness.restricted, frozenset({"u1", "u2"})
    )
    assert (granted, removed) == ({"u1", "u2"}, frozenset())
    # The same list again records nothing.
    assert await record_operator_list(
        rls_harness.restricted, frozenset({"u1", "u2"})
    ) == (frozenset(), frozenset())
    granted, removed = await record_operator_list(
        rls_harness.restricted, frozenset({"u1"})
    )
    assert (granted, removed) == (frozenset(), {"u2"})
    async with rls_harness.restricted() as session:
        assert await recorded_operators(session) == {"u1"}
        rows = [
            (e.action, e.actor_user_id, e.target_id, e.details)
            for e in (
                await session.execute(
                    select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
                )
            ).scalars()
        ]
    source = {"source": "config_file"}
    assert rows == [
        (ServerAuditAction.OPERATOR_GRANTED, None, "u1", source),
        (ServerAuditAction.OPERATOR_GRANTED, None, "u2", source),
        (ServerAuditAction.OPERATOR_REMOVED, None, "u2", source),
    ]


async def test_operators_who_also_hold_the_admin_bit_are_found(
    rls_harness: RLSHarness, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    suffix = uuid.uuid4().hex[:8]
    async with rls_harness.owner() as session:
        both = User(name="Both", email=f"both-{suffix}@example.test", role="admin")
        plain = User(name="Op", email=f"op-{suffix}@example.test", role="user")
        session.add_all([both, plain])
        await session.commit()
        both_id, plain_id = both.id, plain.id
    path = tmp_path / "operators.json"
    path.write_text(json.dumps({"operators": [both_id, plain_id]}))
    os.chmod(path, 0o600)
    operators = OperatorList(path)

    assert await operators_holding_admin(rls_harness.restricted, operators) == {both_id}
    with caplog.at_level(logging.WARNING):
        await warn_if_operators_hold_admin(rls_harness.restricted, operators)
    [line] = [r for r in caplog.records if "deployment admin" in r.getMessage()]
    assert line.levelno == logging.WARNING
    assert getattr(line, "count", None) == 1
    # Counts only: no ids in the line.
    assert both_id not in line.getMessage()


async def test_progress_steps_say_where_to_resume(rls_harness: RLSHarness) -> None:
    [ws, _] = await _tenants(rls_harness)
    request = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="operator-1",
        action=ServerAuditAction.HOSTED_MACHINE_DRAINED,
        target_type="machine",
        target_keyed_id=KEY.keyed_id(KeyedIdKind.MACHINE, "m-1"),
        reason="Kernel update",
        workspace_id=ws,
        workspace_keyed_id=KEY.keyed_id(KeyedIdKind.WORKSPACE, ws),
    )
    async with rls_harness.restricted() as session:
        assert await last_recorded_step(session, request.event_id) is None
    await record_operator_progress(rls_harness.restricted, request, step="cordoned")
    await record_operator_progress(
        rls_harness.restricted, request, step="moved_1_of_3", extra={"boxes_left": 2}
    )
    async with rls_harness.restricted() as session:
        assert await last_recorded_step(session, request.event_id) == (
            "progress",
            "moved_1_of_3",
        )
    await record_operator_result(
        rls_harness.restricted, request, result="failed", step="moved_1_of_3"
    )
    async with rls_harness.restricted() as session:
        assert await last_recorded_step(session, request.event_id) == (
            "result",
            "moved_1_of_3",
        )
    # The workspace's admins see the request and the result, not each step.
    with tenant_scope(ws):
        async with rls_harness.restricted() as session:
            phases = [
                c.details["phase"]
                for c in (
                    await session.execute(
                        select(AuditEvent).order_by(AuditEvent.occurred_at)
                    )
                ).scalars()
            ]
    assert phases == ["requested", "result"]


async def test_a_user_wide_action_reaches_every_workspace(
    rls_harness: RLSHarness,
) -> None:
    """A pause is user-wide: each of the person's workspaces gets its own copy
    of the request and of the result, and nobody else's does."""
    [ws_a, ws_b, other] = await _tenants(rls_harness, 3)
    keyed = {w: KEY.keyed_id(KeyedIdKind.WORKSPACE, w) for w in (ws_a, ws_b)}
    request = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="operator-1",
        action=ServerAuditAction.HOSTED_USER_PAUSED,
        target_type="user",
        target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "user-1"),
        reason="Misuse report",
        workspaces=[(ws_a, keyed[ws_a]), (ws_b, keyed[ws_b])],
    )
    assert [c[0] for c in request.workspace_copies] == [ws_a, ws_b]
    await record_operator_result(rls_harness.restricted, request, result="done")

    async with rls_harness.restricted() as session:
        first = await session.get(ServerAuditEvent, request.event_id)
    assert first is not None
    assert first.details["workspaces"] == [keyed[ws_a], keyed[ws_b]]
    assert "workspace" not in first.details

    for ws in (ws_a, ws_b):
        with tenant_scope(ws):
            async with rls_harness.restricted() as session:
                copies = (
                    (
                        await session.execute(
                            select(AuditEvent).order_by(AuditEvent.occurred_at)
                        )
                    )
                    .scalars()
                    .all()
                )
        assert [c.details["phase"] for c in copies] == ["requested", "result"]
        assert copies[1].details["linked_to"] == copies[0].id
        assert all(c.details["actor_kind"] == "operator" for c in copies)
    with tenant_scope(other):
        async with rls_harness.restricted() as session:
            assert (await session.execute(select(AuditEvent))).scalars().all() == []


async def test_an_admins_reason_stays_in_the_workspace(rls_harness: RLSHarness) -> None:
    """An admin's reason may name the person; operators see ids only, so only
    the workspace's entry keeps it."""
    [ws, _] = await _tenants(rls_harness)
    reason = "Ada asked to stop for now"
    with tenant_scope(ws):
        async with rls_harness.restricted() as session:
            await record_admin_change(
                session,
                workspace_id=ws,
                workspace_keyed_id=KEY.keyed_id(KeyedIdKind.WORKSPACE, ws),
                actor_user_id="admin-1",
                actor_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "admin-1"),
                action=AuditAction.HOSTED_PERSON_TURNED_OFF,
                target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "person-1"),
                result="done",
                reason=reason,
            )
            await session.commit()
        async with rls_harness.restricted() as session:
            [entry] = (await session.execute(select(AuditEvent))).scalars().all()
    assert entry.details["reason"] == reason
    async with rls_harness.restricted() as session:
        [copy] = (await session.execute(select(ServerAuditEvent))).scalars().all()
    assert copy.details["has_reason"] is True
    assert "Ada" not in repr(copy.details)
    assert "reason" not in copy.details


@pytest.mark.parametrize("reason", ["", "   ", "x" * (REASON_MAX + 1)])
async def test_a_bad_admin_reason_is_refused(
    rls_harness: RLSHarness, reason: str
) -> None:
    [ws, _] = await _tenants(rls_harness)
    with tenant_scope(ws):
        async with rls_harness.restricted() as session:
            with pytest.raises(AuditInputError):
                await record_admin_change(
                    session,
                    workspace_id=ws,
                    workspace_keyed_id=KEY.keyed_id(KeyedIdKind.WORKSPACE, ws),
                    actor_user_id="admin-1",
                    actor_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "admin-1"),
                    action=AuditAction.HOSTED_PERSON_TURNED_OFF,
                    target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "person-1"),
                    result="done",
                    reason=reason,
                )


async def test_a_request_can_be_loaded_back_with_its_workspace_copies(
    rls_harness: RLSHarness,
) -> None:
    """The pause's start-up sweep writes `failed` for a half-done pause: the loaded
    record carries the workspace copies, so each workspace gets the result."""
    [ws_a, ws_b, _other] = await _tenants(rls_harness, 3)
    keyed = {w: KEY.keyed_id(KeyedIdKind.WORKSPACE, w) for w in (ws_a, ws_b)}
    original = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="operator-1",
        action=ServerAuditAction.HOSTED_USER_PAUSED,
        target_type="user",
        target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "user-1"),
        reason="Misuse report",
        workspaces=[(ws_a, keyed[ws_a]), (ws_b, keyed[ws_b])],
    )
    loaded = await load_operator_request(rls_harness.restricted, original.event_id, KEY)
    assert loaded is not None
    assert loaded.workspace_copies == original.workspace_copies
    assert loaded.action is ServerAuditAction.HOSTED_USER_PAUSED
    await record_operator_result(
        rls_harness.restricted, loaded, result="failed", step="revoke"
    )
    for ws in (ws_a, ws_b):
        with tenant_scope(ws):
            async with rls_harness.restricted() as session:
                phases = [
                    (c.details["phase"], c.details.get("result"))
                    for c in (
                        await session.execute(
                            select(AuditEvent).order_by(AuditEvent.occurred_at)
                        )
                    ).scalars()
                ]
        assert phases == [("requested", None), ("result", "failed")]
    # A result id isn't a request.
    async with rls_harness.restricted() as session:
        result_id = (
            await session.execute(
                select(ServerAuditEvent.id).where(
                    ServerAuditEvent.details["phase"].astext == "result"
                )
            )
        ).scalar_one()
    assert await load_operator_request(rls_harness.restricted, result_id, KEY) is None
