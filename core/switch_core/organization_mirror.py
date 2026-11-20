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
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.bridges.agent.registration_bootstrap import is_bootstrap_owner
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import directory_organizations_of_user
from switch_core.gateway.auth import (
    workspaces_in_organization,
    workspaces_reached_through_organization,
)
from switch_core.organization_access import (
    AccessRevocation,
    end_organization_admin_access,
    remove_membership,
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


@dataclass(frozen=True)
class MirrorDependencies:
    """What applying a change from the directory needs."""

    revocation: AccessRevocation
    organization_store: OrganizationStore
    user_store: UserStore


async def apply_from_directory(
    session_factory: async_sessionmaker[AsyncSession],
    dependencies: MirrorDependencies,
    *,
    organization_id: str,
    workos_organization_id: str,
    user_id: str,
    wanted: str | None,
    source: str,
) -> None:
    """Make `user_id`'s membership of `organization_id` what the directory
    says, `wanted` (a role, or None for no membership), as read from WorkOS
    organization `workos_organization_id`. Nothing is changed unless the
    organization still follows that one.

    Each workspace is worked on in a transaction of its own, with the
    conflicts it raises recorded in the same one, so a retry after a failure
    part-way (`ServiceError`, a busy connection) finds the workspaces already
    done done, and their conflicts recorded.
    """
    async with organization_session(session_factory, organization_id) as session:
        linked, current = await _link_and_role(session, organization_id, user_id)
        if linked != workos_organization_id:
            logger.warning(
                "Organization %s no longer follows WorkOS organization %s; "
                "user %s's membership there is not applied",
                organization_id,
                workos_organization_id,
                user_id,
            )
            return
        if current == wanted:
            return
        if wanted is not None and _grants(current, wanted):
            await _grant(session, organization_id, user_id, current, wanted, source)
            return
    assert current is not None
    details = {"source": source}
    revocation = dependencies.revocation
    warnings: list[str] = []

    if current == ORGANIZATION_ADMIN_ROLE:
        reason = "demoted" if wanted is not None else "removed"
        for tenant in await workspaces_reached_through_organization(
            session_factory, user_id, organization_id
        ):
            async with tenant_session(session_factory, tenant.id) as session:
                await _conflict_if_agents_left(
                    session, dependencies, organization_id, user_id, tenant, details
                )
                revoked = await end_organization_admin_access(
                    session,
                    revocation,
                    tenant_id=tenant.id,
                    user_id=user_id,
                    actor_id=None,
                    details={"reason": reason, **details},
                    keep_agent_keys=True,
                )
                await session.commit()
                warning = await revocation.finish(session, user_id, revoked)
            if warning:
                warnings.append(f"{tenant.name}: {warning}")

    if wanted is None:
        for tenant in await workspaces_in_organization(
            session_factory, user_id, organization_id
        ):
            async with tenant_session(session_factory, tenant.id) as session:
                membership = await session.get(TenantMember, (tenant.id, user_id))
                if membership is None:
                    continue
                await _conflict_if_agents_left(
                    session, dependencies, organization_id, user_id, tenant, details
                )
                if (
                    membership.role == "admin"
                    and await dependencies.user_store.lock_admins(session) <= 1
                ):
                    await _conflict(
                        session,
                        organization_id,
                        user_id,
                        {
                            **details,
                            "kind": "workspace_left_without_admin",
                            "workspace": tenant.name,
                        },
                    )
                removal = await remove_membership(
                    session,
                    revocation,
                    membership,
                    actor_id=None,
                    details=details,
                    keep_agent_keys=True,
                )
                await session.commit()
                warning = await revocation.finish(session, user_id, removal.revoked)
            if warning:
                warnings.append(f"{tenant.name}: {warning}")

    async with organization_session(session_factory, organization_id) as session:
        admins = await dependencies.organization_store.lock_admins(
            session, organization_id
        )
        _, current = await _link_and_role(session, organization_id, user_id)
        if current is None or current == wanted:
            return
        if current == ORGANIZATION_ADMIN_ROLE and admins <= 1:
            await _conflict(
                session, organization_id, user_id, {**details, "kind": "last_org_admin"}
            )
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
    if wanted == ORGANIZATION_ADMIN_ROLE:
        user = await session.get(User, user_id)
        if user is None:
            raise RuntimeError(f"Directory member {user_id} has no user")
        if is_bootstrap_owner(user):
            # Never Org Admin, whatever the directory says
            # (`SERVICE_ACCOUNT_ADMIN_REFUSAL`): it joins as a member, if
            # joining, and the refusal is recorded for an admin to see.
            await _conflict(
                session,
                organization_id,
                user_id,
                {"source": source, "kind": "service_account_not_admin"},
            )
            if current is not None:
                await session.commit()
                return
            wanted = "member"
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


async def _conflict_if_agents_left(
    session: AsyncSession,
    dependencies: MirrorDependencies,
    organization_id: str,
    user_id: str,
    tenant: Tenant,
    details: dict[str, Any],
) -> None:
    """Agents `user_id` owns in `tenant`, bound on `session`, stay, with the
    keys they run on, owned by someone who can no longer act there, for an
    admin to deal with."""
    if await dependencies.revocation.agent_store.get_by_owner(session, user_id):
        await _conflict(
            session,
            organization_id,
            user_id,
            {**details, "kind": "agents_left_with_owner", "workspace": tenant.name},
        )


async def _conflict(
    session: AsyncSession,
    organization_id: str,
    user_id: str,
    details: dict[str, Any],
) -> None:
    """Record, in the caller's transaction, that a change from the directory
    broke a rule Switch keeps. `session` may be bound to the organization or
    to one of its workspaces."""
    logger.error(
        "Applying WorkOS's change to user %s in organization %s broke a rule "
        "Switch keeps: %s",
        user_id,
        organization_id,
        details,
    )
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=None,
        action=OrganizationAuditAction.DIRECTORY_CONFLICT,
        target_type="user",
        target_id=user_id,
        details=details,
    )
