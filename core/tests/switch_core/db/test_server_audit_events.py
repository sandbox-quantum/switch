"""The server's own audit log: recorded in the caller's transaction, and
append-only for the role the server connects as."""

from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import ServerAuditEvent
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


async def _seed(rls_harness: RLSHarness) -> None:
    async with rls_harness.restricted() as session:
        await record_server_audit_event(
            session,
            actor_user_id="operator-1",
            action=ServerAuditAction.CONNECTOR_APP_SAVED,
            target_type="service",
            target_id="github",
            details={"service": "github", "fields_changed": ["client_secret"]},
        )
        await session.commit()


async def test_the_runtime_role_records_with_no_tenant_bound(
    rls_harness: RLSHarness,
) -> None:
    await _seed(rls_harness)

    async with rls_harness.restricted() as session:
        [event] = (await session.execute(select(ServerAuditEvent))).scalars().all()
    assert event.action == ServerAuditAction.CONNECTOR_APP_SAVED
    assert event.actor_user_id == "operator-1"
    assert event.target_id == "github"
    assert event.details == {"service": "github", "fields_changed": ["client_secret"]}


async def test_a_change_that_rolls_back_leaves_no_event(
    rls_harness: RLSHarness,
) -> None:
    async with rls_harness.restricted() as session:
        await record_server_audit_event(
            session,
            actor_user_id="operator-1",
            action=ServerAuditAction.CONNECTOR_APP_REMOVED,
            target_type="service",
            target_id="github",
            details=None,
        )
        await session.rollback()

    async with rls_harness.owner() as session:
        assert (await session.execute(select(ServerAuditEvent))).scalars().all() == []


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE server_audit_events SET action = 'rewritten'",
        "DELETE FROM server_audit_events",
    ],
)
async def test_the_runtime_role_cannot_rewrite_history(
    rls_harness: RLSHarness, statement: str
) -> None:
    await _seed(rls_harness)

    async with rls_harness.restricted() as session:
        with pytest.raises(ProgrammingError, match="permission denied"):
            await session.execute(text(statement))

    async with rls_harness.owner() as session:
        [event] = (await session.execute(select(ServerAuditEvent))).scalars().all()
    assert event.action == ServerAuditAction.CONNECTOR_APP_SAVED
