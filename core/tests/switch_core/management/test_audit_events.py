"""Controllers enrolled and revoked, and managed agents given `auto_approve`,
recorded in the audit log, end to end against Postgres."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction
from switch_core.db.models import AuditEvent
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    enroll_daemon,
    provider,
    report_status,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _events(
    session_factory: async_sessionmaker[AsyncSession], action: AuditAction
) -> list[AuditEvent]:
    async with session_factory() as session:
        return list(
            (
                await session.execute(
                    select(AuditEvent)
                    .where(AuditEvent.action == action.value)
                    .order_by(AuditEvent.occurred_at)
                )
            )
            .scalars()
            .all()
        )


async def test_enrolling_and_revoking_a_controller_are_recorded(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        laptop = await enroll_console(harness, client, owner)
        box = await enroll_daemon(harness, client, owner)
        for _ in range(2):
            revoked = await client.delete(
                f"/gateway/management/controllers/{laptop.controller_id}",
                cookies=cookies_for(owner),
            )
            assert revoked.status_code == 200

    enrolled = await _events(harness.session_factory, AuditAction.CONTROLLER_ENROLLED)
    assert [(e.target_id, e.actor_user_id) for e in enrolled] == [
        (laptop.controller_id, owner.id),
        (box.controller_id, owner.id),
    ]
    assert [e.details["via"] for e in enrolled if e.details] == [
        "console",
        "enrollment_code",
    ]
    [revocation] = await _events(
        harness.session_factory, AuditAction.CONTROLLER_REVOKED
    )
    assert revocation.target_type == "controller"
    assert revocation.target_id == laptop.controller_id
    assert revocation.actor_user_id == owner.id
    assert revocation.details is not None
    assert revocation.details["owner_id"] == owner.id


async def test_auto_approve_on_create_and_on_update_is_recorded(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        await report_status(client, controller, 1, providers=[provider("claude")])
        bypass = await create_managed_agent(
            client,
            owner,
            name="bypass",
            controller_id=controller.controller_id,
            definition_body=definition(auto_approve=True),
        )
        careful = await create_managed_agent(
            client, owner, name="careful", controller_id=controller.controller_id
        )
        assert bypass.status_code == careful.status_code == 201
        careful_id = careful.json()["agent_id"]
        for _ in range(2):
            patched = await client.patch(
                f"/gateway/management/agents/{careful_id}",
                json={"definition": definition(auto_approve=True)},
                cookies=cookies_for(owner),
            )
            assert patched.status_code == 200, patched.text

    events = await _events(
        harness.session_factory, AuditAction.AGENT_AUTO_APPROVE_ENABLED
    )
    assert [(e.target_id, e.details and e.details["change"]) for e in events] == [
        (bypass.json()["agent_id"], "created"),
        (careful_id, "updated"),
    ]
    assert all(e.actor_user_id == owner.id for e in events)
    registered = await _events(harness.session_factory, AuditAction.AGENT_REGISTERED)
    assert {e.target_id for e in registered} == {bypass.json()["agent_id"], careful_id}
