"""Switch's organization rows brought up to date with a directory kept
outside Switch (`organization_directory.py`), for one person at sign-in.

Only organizations an operator has linked to one in the directory are
touched (`organizations.workos_organization_id`), and only by memberships of
exactly that one: a customer starts using Switch by having its organization
linked, not by one of its people signing in.

- Someone the directory lists and Switch does not is added, with the
  directory's role.
- A member the directory lists as `org_admin` is made one.

Both are recorded in the organization's audit log. Neither takes anything
away. A demotion, or a membership the directory no longer lists, is logged at
`error` and left as it is: taking a role away also takes away the workspaces
it reached, which is for the directory mirror to do (not built yet), not a
sign-in.
"""

from __future__ import annotations

import logging

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import Organization, OrganizationMember
from switch_core.db.session_scope import organization_session
from switch_core.db.tenant_lookup import directory_organizations_of_user
from switch_core.organization_directory import DirectoryMembership

logger = logging.getLogger(__name__)


async def bring_in_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    memberships: list[DirectoryMembership],
) -> None:
    """Bring `user_id`'s rows in each linked organization up to date with
    `memberships`, one organization at a time, each committed on its own."""
    roles = {
        membership.workos_organization_id: membership.role for membership in memberships
    }
    for organization_id in await directory_organizations_of_user(
        session_factory, user_id, list(roles)
    ):
        async with organization_session(session_factory, organization_id) as session:
            await _bring_in_one(session, organization_id, user_id, roles)


async def _bring_in_one(
    session: AsyncSession,
    organization_id: str,
    user_id: str,
    roles: dict[str, str],
) -> None:
    workos_organization_id, current = (
        await session.execute(
            select(Organization.workos_organization_id, OrganizationMember.role)
            .outerjoin(
                OrganizationMember,
                (OrganizationMember.organization_id == Organization.id)
                & (OrganizationMember.user_id == user_id),
            )
            .where(Organization.id == organization_id)
        )
    ).one()
    wanted = roles.get(workos_organization_id) if workos_organization_id else None
    if wanted is None:
        if current is not None:
            logger.error(
                "User %s is %s in organization %s, which WorkOS organization %s "
                "no longer lists them in; Switch keeps their membership until "
                "the directory mirror can end it",
                user_id,
                current,
                organization_id,
                workos_organization_id,
            )
        return
    if current is None:
        added = await session.execute(
            insert(OrganizationMember)
            .values(organization_id=organization_id, user_id=user_id, role=wanted)
            .on_conflict_do_nothing(index_elements=["organization_id", "user_id"])
            .returning(OrganizationMember.user_id)
        )
        if added.first() is None:
            # A concurrent sign-in or invitation added them first.
            return
        action = OrganizationAuditAction.MEMBER_ADDED_AT_SIGN_IN
        details = {"role": wanted}
    elif current != wanted and wanted == ORGANIZATION_ADMIN_ROLE:
        await session.execute(
            update(OrganizationMember)
            .where(
                OrganizationMember.organization_id == organization_id,
                OrganizationMember.user_id == user_id,
            )
            .values(role=wanted)
        )
        action = OrganizationAuditAction.MEMBER_PROMOTED_AT_SIGN_IN
        details = {"from_role": current, "role": wanted}
    else:
        if current != wanted:
            logger.error(
                "User %s is %s in organization %s and %s in WorkOS organization "
                "%s; Switch keeps their role until the directory mirror can "
                "change it",
                user_id,
                current,
                organization_id,
                wanted,
                workos_organization_id,
            )
        return
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=None,
        action=action,
        target_type="user",
        target_id=user_id,
        details=details,
    )
    await session.commit()
