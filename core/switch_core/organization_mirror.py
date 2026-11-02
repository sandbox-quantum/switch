"""Switch's organization rows brought up to date with a directory kept
outside Switch (`organization_directory.py`), for one person at sign-in.

Only customers that already have a Switch organization are touched: a
customer starts using Switch by creating its organization here, not by one of
its people signing in. Someone the directory lists in such an organization
and Switch does not is added, with the directory's role, and the addition is
recorded in the organization's audit log. A role that differs, or a
membership the directory no longer lists, is left as it is and logged: taking
a role away also takes away what it reached, which is the directory mirror's
to do, not a sign-in's.
"""

from __future__ import annotations

import logging

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import OrganizationMember
from switch_core.db.session_scope import organization_session
from switch_core.db.tenant_lookup import organization_of_customer
from switch_core.organization_directory import DirectoryMembership

logger = logging.getLogger(__name__)


async def bring_in_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    memberships: list[DirectoryMembership],
) -> None:
    """Add `user_id` to each Switch organization of a customer in
    `memberships` that they are not in yet, one organization at a time."""
    for membership in memberships:
        organization_id = await organization_of_customer(
            session_factory, membership.customer_id
        )
        if organization_id is None:
            continue
        async with organization_session(session_factory, organization_id) as session:
            member = await session.get(OrganizationMember, (organization_id, user_id))
            if member is not None:
                if member.role != membership.role:
                    logger.warning(
                        "User %s is %s in organization %s and %s in its "
                        "directory; the sign-in leaves Switch's role as it is",
                        user_id,
                        member.role,
                        organization_id,
                        membership.role,
                    )
                continue
            added = await session.execute(
                insert(OrganizationMember)
                .values(
                    organization_id=organization_id,
                    user_id=user_id,
                    role=membership.role,
                )
                .on_conflict_do_nothing(index_elements=["organization_id", "user_id"])
                .returning(OrganizationMember.user_id)
            )
            if added.first() is not None:
                await record_organization_audit_event(
                    session,
                    organization_id=organization_id,
                    actor_user_id=None,
                    action=OrganizationAuditAction.MEMBER_ADDED_AT_SIGN_IN,
                    target_type="user",
                    target_id=user_id,
                    details={"role": membership.role},
                )
            await session.commit()
