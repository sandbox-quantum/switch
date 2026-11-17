"""The security event stream: an audit write reaches the log once, after its
transaction commits, and never for a change that rolled back."""

from __future__ import annotations

import json
import logging

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import (
    AuditAction,
    OrganizationAuditAction,
    ServerAuditAction,
    record_audit_event,
    record_organization_audit_event,
    record_server_audit_event,
)
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.logging_config import JsonFormatter
from switch_core.logging_context import structured_fields
from switch_core.security_events import (
    LOGGER_NAME,
    SecuritySignal,
    flat_details,
    log_security_event,
)


def _events(caplog: pytest.LogCaptureFixture) -> list[dict]:
    return [
        structured_fields(record)["switch"]
        for record in caplog.records
        if record.name == LOGGER_NAME
    ]


def _details(caplog: pytest.LogCaptureFixture) -> list[dict]:
    return [
        structured_fields(record)["security_details"]
        for record in caplog.records
        if record.name == LOGGER_NAME
    ]


async def _record_agent_deleted(session: AsyncSession, agent_id: str) -> None:
    await record_audit_event(
        session,
        tenant_id=TENANT_ZERO_ID,
        actor_user_id="user-1",
        action=AuditAction.AGENT_DELETED,
        target_type="agent",
        target_id=agent_id,
        details={"agent_name": "Bot", "room_id": "room-1", "tags": ["a", "b"]},
    )


@pytest.fixture(autouse=True)
def _capture(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)


async def test_a_committed_audit_write_is_logged_once_with_its_ids(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        await _record_agent_deleted(session, "agent-1")
        assert _events(caplog) == []
        await session.commit()

    [event] = _events(caplog)
    assert event["event"] == "security.agent.deleted"
    assert event["scope"] == "tenant"
    assert event["tenant_id"] == TENANT_ZERO_ID
    assert event["actor_user_id"] == "user-1"
    assert event["target_type"] == "agent"
    assert event["target_id"] == "agent-1"
    assert event["agent_id"] == "agent-1"
    assert event["room_id"] == "room-1"
    assert event["audit_event_id"]
    [details] = _details(caplog)
    assert details == {"agent_name": "Bot", "room_id": "room-1", "tags": '["a", "b"]'}


async def test_a_rolled_back_change_logs_nothing(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        await _record_agent_deleted(session, "agent-1")
        await session.rollback()
        await session.commit()

    assert _events(caplog) == []


async def test_a_session_closed_without_commit_logs_nothing_later(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    session = session_factory()
    await _record_agent_deleted(session, "agent-1")
    await session.close()
    await _record_agent_deleted(session, "agent-2")
    await session.commit()
    await session.close()

    assert [event["target_id"] for event in _events(caplog)] == ["agent-2"]


async def test_a_rolled_back_savepoint_drops_only_its_own_events(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        await _record_agent_deleted(session, "outer")
        async with session.begin_nested():
            await _record_agent_deleted(session, "released")
        savepoint = await session.begin_nested()
        await _record_agent_deleted(session, "rolled-back")
        async with session.begin_nested():
            await _record_agent_deleted(session, "inside-rolled-back")
        await savepoint.rollback()
        assert _events(caplog) == []
        await session.commit()

    assert [event["target_id"] for event in _events(caplog)] == ["outer", "released"]


async def test_a_savepoint_rolled_back_by_an_exception_drops_its_events(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        with pytest.raises(RuntimeError):
            async with session.begin_nested():
                await _record_agent_deleted(session, "failed")
                raise RuntimeError("change refused")
        await session.commit()

    assert _events(caplog) == []


async def test_each_transaction_logs_its_own_events(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        await _record_agent_deleted(session, "first")
        await session.commit()
        await _record_agent_deleted(session, "second")
        await session.commit()
        await session.commit()

    assert [event["target_id"] for event in _events(caplog)] == ["first", "second"]


async def test_organization_and_server_writes_name_their_scope(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        await record_organization_audit_event(
            session,
            organization_id=TENANT_ZERO_ID,
            actor_user_id="user-1",
            action=OrganizationAuditAction.ORGANIZATION_RENAMED,
            target_type="organization",
            target_id=TENANT_ZERO_ID,
            details=None,
        )
        await record_server_audit_event(
            session,
            actor_user_id="operator-1",
            action=ServerAuditAction.USER_SESSIONS_ENDED,
            target_type="user",
            target_id="user-2",
            details=None,
        )
        await session.commit()

    organization, server = _events(caplog)
    assert organization["event"] == "security.organization.renamed"
    assert organization["scope"] == "organization"
    assert organization["organization_id"] == TENANT_ZERO_ID
    assert organization["tenant_id"] is None
    assert server["event"] == "security.user.sessions_ended"
    assert server["scope"] == "server"
    assert server["target_id"] == "user-2"


def test_a_log_only_event_is_written_at_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log_security_event(
        SecuritySignal.SIGN_IN_FAILED,
        tenant_id=None,
        actor_user_id=None,
        target_type="user",
        target_id=None,
        agent_id=None,
        room_id=None,
        details={"method": "password", "reason": "invalid_credentials"},
    )

    [event] = _events(caplog)
    assert event["event"] == "security.auth.sign_in_failed"
    assert event["scope"] == "log"
    assert event["audit_event_id"] is None


def test_email_addresses_in_details_stay_out_of_the_log() -> None:
    assert flat_details(
        {
            "email": "someone@example.com",
            "invited_email": "x@example.com",
            "role": "member",
        }
    ) == {"role": "member"}


def test_the_json_line_carries_the_event_as_fields(
    caplog: pytest.LogCaptureFixture,
) -> None:
    log_security_event(
        SecuritySignal.BUDGET_EXCEEDED,
        tenant_id="t-1",
        actor_user_id=None,
        target_type="agent",
        target_id="agent-1",
        agent_id="agent-1",
        room_id="room-1",
        details={"window": "daily"},
    )
    [record] = [r for r in caplog.records if r.name == LOGGER_NAME]
    line = json.loads(
        JsonFormatter(
            service="switch-core", environment=None, version=None, process_id="p"
        ).format(record)
    )

    assert line["logger"]["name"] == "switch_core.security"
    assert line["switch"]["event"] == "security.budget.exceeded"
    assert line["switch"]["room_id"] == "room-1"
    assert line["security_details"] == {"window": "daily"}
