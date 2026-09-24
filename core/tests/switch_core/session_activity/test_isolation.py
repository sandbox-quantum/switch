from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from switch_core.db.models import (
    Agent,
    ApiKey,
    ApprovalRequest,
    Client,
    SessionActivityEvent,
    Tenant,
    User,
)
from switch_core.session_activity.service import (
    ApprovalOption,
    PlatformPerson,
    SessionActivityService,
)
from switch_core.sessions.service import SessionError
from switch_core.tenant_context import tenant_scope


async def _seed(harness, tenant: str) -> SessionActivityService:
    async with harness.owner() as db, db.begin():
        db.add(Tenant(id=tenant, slug=tenant, name=tenant))
        db.add(
            User(id=tenant, name="Owner", email=f"{tenant}@example.test", role="user")
        )
    with tenant_scope(tenant):
        async with harness.restricted() as db, db.begin():
            key = ApiKey(
                user_id=tenant,
                key_hash=uuid.uuid4().hex,
                encrypted_key="",
                label="fixture",
                type="agent",
            )
            client = Client(
                matrix_user_id=f"@agent-{tenant}:example.test",
                display_name="Agent",
                type="agent",
            )
            db.add_all([key, client])
            await db.flush()
            db.add(
                Agent(
                    id=tenant,
                    name="agent",
                    description="Fixture",
                    agent_type="claude",
                    connector_type="external",
                    integration_profile={},
                    client_id=client.id,
                    api_key_id=key.id,
                    owner_id=tenant,
                )
            )
    return SessionActivityService(harness.restricted)


async def test_each_tenant_sees_only_its_own_activity_and_requests(rls_harness):
    services = {t: await _seed(rls_harness, t) for t in ("tenant-a", "tenant-b")}
    for tenant, service in services.items():
        with tenant_scope(tenant):
            await service.report_activity(
                tenant,
                "session-demo",
                seq=1,
                type="notice",
                summary=f"hello from {tenant}",
                detail={},
                turn_id=None,
                room_id=None,
                thread_id=None,
                occurred_at=datetime.now(UTC),
            )
            await service.open_approval(
                tenant,
                "session-demo",
                request_id="req-1",
                question="Proceed?",
                options=[ApprovalOption("yes", "Yes", "accept")],
                room_id=None,
                thread_id=None,
                expires_at=None,
            )

    for tenant in services:
        with tenant_scope(tenant):
            async with rls_harness.restricted() as db:
                for model in (SessionActivityEvent, ApprovalRequest):
                    rows = (await db.scalars(select(model))).all()
                    assert {row.tenant_id for row in rows} == {tenant}


async def test_one_tenant_cannot_answer_anothers_request(rls_harness):
    a = await _seed(rls_harness, "tenant-a")
    b = await _seed(rls_harness, "tenant-b")
    with tenant_scope("tenant-a"):
        await a.open_approval(
            "tenant-a",
            "session-demo",
            request_id="req-1",
            question="Proceed?",
            options=[ApprovalOption("yes", "Yes", "accept")],
            room_id=None,
            thread_id=None,
            expires_at=None,
        )
    with tenant_scope("tenant-b"), pytest.raises(SessionError) as error:
        await b.answer_approval(
            "tenant-a",
            "session-demo",
            "req-1",
            answer="yes",
            answerer=PlatformPerson("x"),
        )
    assert error.value.code == "NOT_FOUND"
    with tenant_scope("tenant-a"):
        async with rls_harness.restricted() as db:
            state = await db.scalar(select(ApprovalRequest.state))
    assert state == "open"
