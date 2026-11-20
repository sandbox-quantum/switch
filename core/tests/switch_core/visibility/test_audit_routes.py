"""The operators' audit-log read: newest first, filtered, never a write."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import ServerAuditEvent
from switch_core.visibility.audit_log import (
    record_operator_request,
    record_operator_result,
)
from switch_core.visibility.audit_routes import (
    is_hosted_action,
    list_operator_audit_events,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")
OPERATOR = SimpleNamespace(id="op-1")


async def _seed(rls_harness: RLSHarness) -> tuple[str, str]:
    paused = KEY.keyed_id(KeyedIdKind.USER, "user-1")
    restarted = KEY.keyed_id(KeyedIdKind.BOX, "box-1")
    request = await record_operator_request(
        rls_harness.restricted,
        actor_user_id="op-1",
        action=ServerAuditAction.HOSTED_USER_PAUSED,
        target_type="user",
        target_keyed_id=paused,
        reason="Misuse report",
    )
    await record_operator_result(rls_harness.restricted, request, result="done")
    await record_operator_request(
        rls_harness.restricted,
        actor_user_id="op-2",
        action=ServerAuditAction.HOSTED_BOX_RESTARTED,
        target_type="box",
        target_keyed_id=restarted,
        reason="Stuck",
    )
    return paused, restarted


async def test_newest_first_and_filtered(rls_harness: RLSHarness) -> None:
    paused, restarted = await _seed(rls_harness)
    async with rls_harness.restricted() as session:
        everything = await list_operator_audit_events(session, OPERATOR)  # type: ignore[arg-type]
    assert [e.action for e in everything] == [
        ServerAuditAction.HOSTED_BOX_RESTARTED,
        ServerAuditAction.HOSTED_USER_PAUSED,
        ServerAuditAction.HOSTED_USER_PAUSED,
    ]
    async with rls_harness.restricted() as session:
        by_target = await list_operator_audit_events(
            session,
            OPERATOR,  # type: ignore[arg-type]
            target_id=paused,
        )
        by_action = await list_operator_audit_events(
            session,
            OPERATOR,  # type: ignore[arg-type]
            action=ServerAuditAction.HOSTED_BOX_RESTARTED.value,
        )
        one = await list_operator_audit_events(session, OPERATOR, limit=1)  # type: ignore[arg-type]
        older = await list_operator_audit_events(
            session,
            OPERATOR,  # type: ignore[arg-type]
            before=datetime.fromisoformat(one[0].occurred_at),
        )
    assert {e.target_id for e in by_target} == {paused}
    assert [e.target_id for e in by_action] == [restarted]
    assert len(one) == 1 and one[0].target_id == restarted
    assert {e.target_id for e in older} == {paused}


async def test_an_unknown_action_is_refused(rls_harness: RLSHarness) -> None:
    async with rls_harness.restricted() as session:
        with pytest.raises(HTTPException) as exc:
            await list_operator_audit_events(
                session,
                OPERATOR,  # type: ignore[arg-type]
                action="anything; drop table",
            )
    assert exc.value.status_code == 422


async def test_older_server_entries_never_come_back(rls_harness: RLSHarness) -> None:
    """The table's pre-existing entries may hold raw ids or names, so the read
    returns this feature's actions only, with or without a filter."""
    await _seed(rls_harness)
    async with rls_harness.restricted() as session:
        await record_server_audit_event(
            session,
            actor_user_id="deploy-owner",
            action=ServerAuditAction.CONNECTOR_APP_SAVED,
            target_type="service",
            target_id="github",
            details={"by": "ada@example.test"},
        )
        await session.commit()
    async with rls_harness.restricted() as session:
        everything = await list_operator_audit_events(session, OPERATOR, limit=200)  # type: ignore[arg-type]
        with pytest.raises(HTTPException) as exc:
            await list_operator_audit_events(
                session,
                OPERATOR,  # type: ignore[arg-type]
                action=ServerAuditAction.CONNECTOR_APP_SAVED.value,
            )
        by_target = await list_operator_audit_events(
            session,
            OPERATOR,  # type: ignore[arg-type]
            target_id="github",
        )
    assert ServerAuditAction.CONNECTOR_APP_SAVED not in {e.action for e in everything}
    assert "ada@example.test" not in repr([e.details for e in everything])
    assert exc.value.status_code == 422
    assert by_target == []


def test_the_allow_list() -> None:
    assert is_hosted_action("hosted.user_paused")
    assert is_hosted_action("operator.granted")
    assert is_hosted_action("alert.raised")
    assert is_hosted_action("alert.cleared")
    assert not is_hosted_action("connector_app.saved")
    assert not is_hosted_action("alertXraised")
    assert not is_hosted_action("alert_raised")
    assert not is_hosted_action("alerts.raised")
    assert not is_hosted_action("")


async def test_alerts_show_only_when_asked_for(rls_harness: RLSHarness) -> None:
    """The hosted alert rows share the table; the default view leaves them out so
    they don't bury the actions, and filtering for one returns it."""
    await _seed(rls_harness)
    async with rls_harness.restricted() as session:
        # The alert action values aren't the point; the row is what matters here.
        session.add(
            ServerAuditEvent(
                actor_user_id=None,
                action="alert.raised",
                target_type="box",
                target_id=KEY.keyed_id(KeyedIdKind.BOX, "box-9"),
                details={"condition": "box_restarting"},
            )
        )
        await session.commit()
    async with rls_harness.restricted() as session:
        default = await list_operator_audit_events(session, OPERATOR, limit=200)  # type: ignore[arg-type]
        alerts = await list_operator_audit_events(
            session,
            OPERATOR,  # type: ignore[arg-type]
            action="alert.raised",
        )
    assert "alert.raised" not in {e.action for e in default}
    assert len(default) == 3
    assert [e.action for e in alerts] == ["alert.raised"]
