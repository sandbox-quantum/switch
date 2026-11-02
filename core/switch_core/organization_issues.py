"""What needs an organization admin's attention, read from how things stand.

Changes brought in from a directory kept outside Switch are applied even
when they break a rule Switch keeps (`organization_mirror.py`), and each is
recorded as a `directory_conflict` in the organization's audit log. The audit
log says what happened; this says what is still wrong, so a notice goes away
once someone fixes it rather than once someone dismisses it:

- `no_org_admin`: nobody administers the organization (only the platform
  operator, who may make someone its admin, can then read this).
- `workspace_without_owner`: a workspace with no `owner`.
- `agents_without_acting_owner`: agents whose owner is neither a member of
  their workspace nor the organization's `org_admin`, so nobody can act for
  them as their owner.
- `directory_organization_deleted`: the WorkOS organization this one follows
  was deleted after it was linked.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import and_, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    Agent,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    TenantMember,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore

IssueKind = Literal[
    "no_org_admin",
    "workspace_without_owner",
    "agents_without_acting_owner",
    "directory_organization_deleted",
]
NO_ORG_ADMIN: IssueKind = "no_org_admin"
WORKSPACE_WITHOUT_OWNER: IssueKind = "workspace_without_owner"
AGENTS_WITHOUT_ACTING_OWNER: IssueKind = "agents_without_acting_owner"
DIRECTORY_ORGANIZATION_DELETED: IssueKind = "directory_organization_deleted"


@dataclass(frozen=True)
class OrganizationIssue:
    """One issue: its kind, the workspace it is in (None for the
    organization's own), and the agents it names, if any."""

    kind: IssueKind
    workspace_id: str | None
    workspace_name: str | None
    agents: list[str]


async def organization_issues(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    *,
    organization_id: str,
    workspaces: list[tuple[str, str]],
) -> list[OrganizationIssue]:
    """The issues of `organization_id` as things stand. `session` is bound
    to one of its workspaces, for the organization's own rows; each of
    `workspaces`, its workspaces as (id, name), is read on a short session of its own,
    after `session` has let go of its connection."""
    admins = set(
        await session.scalars(
            select(OrganizationMember.user_id).where(
                OrganizationMember.organization_id == organization_id,
                OrganizationMember.role == ORGANIZATION_ADMIN_ROLE,
            )
        )
    )
    issues = []
    if not admins:
        issues.append(OrganizationIssue(NO_ORG_ADMIN, None, None, []))
    if await _directory_organization_deleted(session, organization_id):
        issues.append(OrganizationIssue(DIRECTORY_ORGANIZATION_DELETED, None, None, []))
    await session.commit()

    for workspace_id, workspace_name in sorted(workspaces, key=lambda w: w[1]):
        async with tenant_session(session_factory, workspace_id) as tenant:
            if await user_store.count_owners(tenant) == 0:
                issues.append(
                    OrganizationIssue(
                        WORKSPACE_WITHOUT_OWNER, workspace_id, workspace_name, []
                    )
                )
            stranded = list(
                await tenant.scalars(
                    select(Agent.name)
                    .where(
                        Agent.tenant_id == workspace_id,
                        Agent.owner_id.is_not(None),
                        Agent.owner_id.not_in(admins) if admins else true(),
                        ~select(TenantMember.user_id)
                        .where(
                            TenantMember.tenant_id == workspace_id,
                            TenantMember.user_id == Agent.owner_id,
                        )
                        .exists(),
                    )
                    .order_by(Agent.name)
                )
            )
        if stranded:
            issues.append(
                OrganizationIssue(
                    AGENTS_WITHOUT_ACTING_OWNER, workspace_id, workspace_name, stranded
                )
            )
    return issues


async def _directory_organization_deleted(
    session: AsyncSession, organization_id: str
) -> bool:
    """Whether the organization is linked and the WorkOS organization it
    follows was reported deleted after the link was last made."""
    linked = await session.scalar(
        select(Organization.workos_organization_id).where(
            Organization.id == organization_id
        )
    )
    if linked is None:
        return False
    latest = await session.scalar(
        select(OrganizationAuditEvent.action)
        .where(
            OrganizationAuditEvent.organization_id == organization_id,
            or_(
                OrganizationAuditEvent.action
                == OrganizationAuditAction.LINKED_TO_DIRECTORY,
                and_(
                    OrganizationAuditEvent.action
                    == OrganizationAuditAction.DIRECTORY_CONFLICT,
                    OrganizationAuditEvent.details["kind"].astext
                    == DIRECTORY_ORGANIZATION_DELETED,
                ),
            ),
        )
        .order_by(
            OrganizationAuditEvent.occurred_at.desc(),
            OrganizationAuditEvent.id.desc(),
        )
        .limit(1)
    )
    return latest == OrganizationAuditAction.DIRECTORY_CONFLICT
