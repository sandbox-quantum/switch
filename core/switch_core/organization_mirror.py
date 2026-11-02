"""Switch's organization rows brought up to date with a directory kept
outside Switch (`organization_directory.py`).

Only organizations an operator has linked to one in the directory are
touched (`organizations.workos_organization_id`), and only by memberships of
exactly that one: a customer starts using Switch by having its organization
linked, not by one of its people signing in.

The directory is the record, so whatever it says is applied:

- Someone it lists and Switch does not is added, with its role.
- A member it lists as `org_admin` is made one.
- An `org_admin` it lists as anything else is made a member, and loses what
  they held in the organization's workspaces they stood in only as its
  `org_admin` (`organization_access.end_access_through_organization`).
- A member it no longer lists is removed, from the organization and from each
  of its workspaces, with their keys, service connections and sign-ins there.

Each is recorded in the organization's audit log, with where it came from
(`source`). A change that breaks a rule Switch keeps itself (the last Org
Admin, agents left with an owner who can no longer act, a workspace left
with no owner) is applied all the same, logged at `error` and recorded as a
`directory_conflict` for the organization's admins.

A sign-in (`bring_in_memberships`) only grants: it never waits on taking
access away, which the mirror (`workos_mirror.py`) does from the directory's
events and its daily check (`apply_from_directory`).
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
)
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.tenant_lookup import directory_organizations_of_user
from switch_core.gateway.auth import (
    workspaces_in_organization,
    workspaces_reached_through_organization,
)
from switch_core.organization_access import (
    AccessRevocation,
    end_access_through_organization,
    remove_from_workspace,
    workspaces_where_they_own_agents,
)
from switch_core.organization_directory import DirectoryMembership

logger = logging.getLogger(__name__)

SIGN_IN = "sign_in"


async def bring_in_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    memberships: list[DirectoryMembership],
) -> None:
    """At sign-in: add `user_id` to each linked organization `memberships`
    lists them in, and make them Org Admin where it lists them as one, each
    organization committed on its own. What it would take away is logged."""
    roles = {
        membership.workos_organization_id: membership.role for membership in memberships
    }
    for organization_id in await directory_organizations_of_user(
        session_factory, user_id, list(roles)
    ):
        async with organization_session(session_factory, organization_id) as session:
            workos_organization_id, current = await _link_and_role(
                session, organization_id, user_id
            )
            wanted = (
                roles.get(workos_organization_id) if workos_organization_id else None
            )
            if wanted is not None and _grants(current, wanted):
                await _grant(
                    session, organization_id, user_id, current, wanted, SIGN_IN
                )
            elif current != wanted:
                logger.warning(
                    "User %s is %s in organization %s and %s in WorkOS "
                    "organization %s; the directory mirror applies it",
                    user_id,
                    current,
                    organization_id,
                    wanted or "not a member",
                    workos_organization_id,
                )


async def apply_from_directory(
    session_factory: async_sessionmaker[AsyncSession],
    revocation: AccessRevocation,
    *,
    organization_id: str,
    user_id: str,
    wanted: str | None,
    source: str,
) -> None:
    """Make `user_id`'s membership of `organization_id` what the directory
    says, `wanted` (a role, or None for no membership). Raises `ServiceError`
    when a connection to revoke is busy, having changed nothing that a retry
    would not finish."""
    async with organization_session(session_factory, organization_id) as session:
        _, current = await _link_and_role(session, organization_id, user_id)
        if current == wanted:
            return
        if _grants(current, wanted):
            assert wanted is not None
            await _grant(session, organization_id, user_id, current, wanted, source)
            return
        admins = await _count_admins(session, organization_id)
    assert current is not None
    conflicts: list[dict[str, Any]] = []
    warnings: list[str] = []
    details = {"source": source}

    if current == ORGANIZATION_ADMIN_ROLE:
        if admins <= 1:
            conflicts.append({"kind": "last_org_admin"})
        reached = await workspaces_reached_through_organization(
            session_factory, user_id, organization_id
        )
        conflicts += await _agents_left(session_factory, revocation, user_id, reached)
        warning = await end_access_through_organization(
            session_factory,
            revocation,
            user_id=user_id,
            reached=reached,
            actor_id=None,
            details={
                "reason": "demoted" if wanted is not None else "removed",
                **details,
            },
            keep_agent_keys=True,
        )
        if warning:
            warnings.append(warning)

    if wanted is None:
        workspaces = await workspaces_in_organization(
            session_factory, user_id, organization_id
        )
        conflicts += await _agents_left(
            session_factory, revocation, user_id, workspaces
        )
        for tenant in workspaces:
            if await _is_last_owner(session_factory, tenant.id, user_id):
                conflicts.append(
                    {"kind": "workspace_left_without_owner", "workspace": tenant.name}
                )
            warning = await remove_from_workspace(
                session_factory,
                revocation,
                user_id=user_id,
                tenant=tenant,
                actor_id=None,
                details=details,
                keep_agent_keys=True,
            )
            if warning:
                warnings.append(warning)

    async with organization_session(session_factory, organization_id) as session:
        if wanted is None:
            await session.execute(
                delete(OrganizationMember).where(
                    OrganizationMember.organization_id == organization_id,
                    OrganizationMember.user_id == user_id,
                )
            )
            action = OrganizationAuditAction.MEMBER_REMOVED_FROM_DIRECTORY
        else:
            await _set_role(session, organization_id, user_id, wanted)
            action = OrganizationAuditAction.MEMBER_DEMOTED_FROM_DIRECTORY
        await record_organization_audit_event(
            session,
            organization_id=organization_id,
            actor_user_id=None,
            action=action,
            target_type="user",
            target_id=user_id,
            details={
                **details,
                "from_role": current,
                "role": wanted,
                **({"warning": " ".join(warnings)} if warnings else {}),
            },
        )
        for conflict in conflicts:
            logger.error(
                "Applying WorkOS's change to user %s in organization %s broke "
                "a rule Switch keeps: %s",
                user_id,
                organization_id,
                conflict,
            )
            await record_organization_audit_event(
                session,
                organization_id=organization_id,
                actor_user_id=None,
                action=OrganizationAuditAction.DIRECTORY_CONFLICT,
                target_type="user",
                target_id=user_id,
                details={**details, **conflict},
            )
        await session.commit()


def _grants(current: str | None, wanted: str | None) -> bool:
    """Whether going from `current` to `wanted` only gives: joining, or
    becoming Org Admin."""
    if wanted is None or current == wanted:
        return False
    return current is None or wanted == ORGANIZATION_ADMIN_ROLE


async def _grant(
    session: AsyncSession,
    organization_id: str,
    user_id: str,
    current: str | None,
    wanted: str,
    source: str,
) -> None:
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
        action = OrganizationAuditAction.MEMBER_ADDED_FROM_DIRECTORY
        details: dict[str, Any] = {"source": source, "role": wanted}
    else:
        await _set_role(session, organization_id, user_id, wanted)
        action = OrganizationAuditAction.MEMBER_PROMOTED_FROM_DIRECTORY
        details = {"source": source, "from_role": current, "role": wanted}
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


async def _link_and_role(
    session: AsyncSession, organization_id: str, user_id: str
) -> tuple[str | None, str | None]:
    """The organization's link to the directory, and `user_id`'s role in it
    (None if not a member), in one read."""
    workos_organization_id, role = (
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
    return workos_organization_id, role


async def _set_role(
    session: AsyncSession, organization_id: str, user_id: str, role: str
) -> None:
    await session.execute(
        update(OrganizationMember)
        .where(
            OrganizationMember.organization_id == organization_id,
            OrganizationMember.user_id == user_id,
        )
        .values(role=role)
    )


async def _count_admins(session: AsyncSession, organization_id: str) -> int:
    return (
        await session.scalar(
            select(func.count()).where(
                OrganizationMember.organization_id == organization_id,
                OrganizationMember.role == ORGANIZATION_ADMIN_ROLE,
            )
        )
    ) or 0


async def _agents_left(
    session_factory: async_sessionmaker[AsyncSession],
    revocation: AccessRevocation,
    user_id: str,
    workspaces: list[Tenant],
) -> list[dict[str, Any]]:
    """A conflict for each of `workspaces` where `user_id` owns agents, which
    stay, with the keys they run on, owned by someone who can no longer act
    there, for an admin to deal with."""
    return [
        {"kind": "agents_left_with_owner", "workspace": tenant.name}
        for tenant in await workspaces_where_they_own_agents(
            session_factory, revocation.agent_store, user_id, workspaces
        )
    ]


async def _is_last_owner(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, user_id: str
) -> bool:
    async with tenant_session(session_factory, tenant_id) as session:
        owners = list(
            await session.scalars(
                select(TenantMember.user_id).where(
                    TenantMember.tenant_id == tenant_id, TenantMember.role == "owner"
                )
            )
        )
    return owners == [user_id]
