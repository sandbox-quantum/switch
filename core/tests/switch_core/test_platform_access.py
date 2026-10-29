"""`administers_on_record`: an admin decision made for the platform operator
on the operator flag alone is recorded in the workspace's audit log, and one
made on a role anyone may hold is not."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    OrganizationMember,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.platform_access import administers_on_record


async def _user(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    role: str,
    tenant_role: str | None = None,
    organization_role: str | None = None,
) -> User:
    async with session_factory() as session:
        user = User(
            name=f"u-{uuid.uuid4().hex[:6]}",
            email=f"{uuid.uuid4().hex[:6]}@example.invalid",
            role=role,
        )
        session.add(user)
        await session.flush()
        if tenant_role is not None:
            session.add(
                TenantMember(
                    tenant_id=TENANT_ZERO_ID, user_id=user.id, role=tenant_role
                )
            )
        if organization_role is not None:
            session.add(
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID,
                    user_id=user.id,
                    role=organization_role,
                )
            )
        await session.commit()
        return user


async def _decide(
    session_factory: async_sessionmaker[AsyncSession], user: User
) -> tuple[bool, list[AuditEvent]]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        decided = await administers_on_record(
            session,
            session_factory,
            UserStore(),
            user,
            target_type="agent",
            target_id="agent-1",
            details={"event": "agent_acting"},
        )
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        events = list(
            await session.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.PLATFORM_ACCESS,
                    AuditEvent.actor_user_id == user.id,
                )
            )
        )
    return decided, events


async def test_the_operator_on_the_flag_alone_administers_on_record(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator = await _user(session_factory, role="admin", tenant_role="member")

    decided, [event] = await _decide(session_factory, operator)

    assert decided is True
    assert (event.target_type, event.target_id) == ("agent", "agent-1")
    assert event.details == {"event": "agent_acting"}


async def test_the_operator_through_a_role_is_not_marked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator = await _user(
        session_factory,
        role="admin",
        tenant_role="member",
        organization_role="org_admin",
    )

    assert await _decide(session_factory, operator) == (True, [])


async def test_anyone_else_is_answered_by_their_role_and_never_recorded(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _user(session_factory, role="user", tenant_role="admin")
    member = await _user(session_factory, role="user", tenant_role="member")

    assert await _decide(session_factory, admin) == (True, [])
    assert await _decide(session_factory, member) == (False, [])
