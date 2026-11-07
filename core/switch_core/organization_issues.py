"""What needs an organization admin's attention, read from how things stand.

Changes brought in from a directory kept outside Switch are applied even
when they break a rule Switch keeps (`organization_mirror.py`), and each is
recorded as a `directory_conflict` in the organization's audit log. The audit
log says what happened; this says what is still wrong, so a notice goes away
once someone fixes it rather than once someone dismisses it:

- `no_org_admin`: nobody administers the organization (only the platform
  operator, who may make someone its admin, can then read this).
- `workspace_without_admin`: a workspace with no `admin`.
- `agents_without_acting_owner`: agents whose owner is neither a member of
  their workspace, nor the organization's `org_admin`, nor the platform
  operator, so nobody can act for them as their owner.
- `directory_organization_deleted`: the WorkOS organization this one follows
  was deleted.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select, true
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.audit import OrganizationAuditAction, OrganizationIssueKind
from switch_core.db.models import (
    Agent,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore


@dataclass(frozen=True)
class OrganizationIssue:
    """One issue: its kind, the workspace it is in (None for the
    organization's own), and the agents it names, if any."""

    kind: OrganizationIssueKind
    workspace_id: str | None
    workspace_name: str | None
    agents: list[str]


async def organization_wide_issues(
    session: AsyncSession, organization_id: str
) -> tuple[list[OrganizationIssue], set[str]]:
    """The issues of `organization_id` itself, read on `session`, bound to
    one of its workspaces, and its `org_admin`s, which `workspace_issues`
    needs. The caller commits before reading the workspaces, so it holds no
    connection while they are read."""
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
        issues.append(
            OrganizationIssue(OrganizationIssueKind.NO_ORG_ADMIN, None, None, [])
        )
    if await _directory_organization_deleted(session, organization_id):
        issues.append(
            OrganizationIssue(
                OrganizationIssueKind.DIRECTORY_ORGANIZATION_DELETED, None, None, []
            )
        )
    return issues, admins


async def workspace_issues(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    *,
    organization_id: str,
    admins: set[str],
    candidates: list[str],
) -> list[OrganizationIssue]:
    """The issues in the workspaces of `organization_id` among `candidates`,
    sorted by workspace name. Each candidate is read on a short session of
    its own, and those of other organizations skipped."""
    found: list[OrganizationIssue] = []
    for tenant_id in candidates:
        async with tenant_session(session_factory, tenant_id) as tenant_db:
            workspace = await tenant_db.get(Tenant, tenant_id)
            if workspace is None or workspace.organization_id != organization_id:
                continue
            without_admin = await user_store.count_admins(tenant_db) == 0
            stranded = await _stranded_agents(tenant_db, tenant_id, admins)
        if without_admin:
            found.append(
                OrganizationIssue(
                    OrganizationIssueKind.WORKSPACE_WITHOUT_ADMIN,
                    tenant_id,
                    workspace.name,
                    [],
                )
            )
        if stranded:
            found.append(
                OrganizationIssue(
                    OrganizationIssueKind.AGENTS_WITHOUT_ACTING_OWNER,
                    tenant_id,
                    workspace.name,
                    stranded,
                )
            )
    return sorted(found, key=lambda issue: issue.workspace_name or "")


async def _stranded_agents(
    session: AsyncSession, tenant_id: str, admins: set[str]
) -> list[str]:
    """The agents of `tenant_id` whose owner is neither its member, nor the
    organization's `org_admin`, nor the platform operator, who may act in any
    workspace without a membership row."""
    return list(
        await session.scalars(
            select(Agent.name)
            .where(
                Agent.tenant_id == tenant_id,
                Agent.owner_id.is_not(None),
                Agent.owner_id.not_in(admins) if admins else true(),
                ~select(TenantMember.user_id)
                .where(
                    TenantMember.tenant_id == tenant_id,
                    TenantMember.user_id == Agent.owner_id,
                )
                .exists(),
                ~select(User.id)
                .where(User.id == Agent.owner_id, User.role == "admin")
                .exists(),
            )
            .order_by(Agent.name)
        )
    )


async def _directory_organization_deleted(
    session: AsyncSession, organization_id: str
) -> bool:
    """Whether the WorkOS organization this one follows now was reported
    deleted. A WorkOS organization, once deleted, can't be linked again, so a
    conflict naming the linked id settles it, whenever it was recorded."""
    linked = await session.scalar(
        select(Organization.workos_organization_id).where(
            Organization.id == organization_id
        )
    )
    if linked is None:
        return False
    found = await session.scalar(
        select(OrganizationAuditEvent.id)
        .where(
            OrganizationAuditEvent.organization_id == organization_id,
            OrganizationAuditEvent.action == OrganizationAuditAction.DIRECTORY_CONFLICT,
            OrganizationAuditEvent.details["kind"].astext
            == OrganizationIssueKind.DIRECTORY_ORGANIZATION_DELETED,
            OrganizationAuditEvent.details["workos_organization_id"].astext == linked,
        )
        .limit(1)
    )
    return found is not None
