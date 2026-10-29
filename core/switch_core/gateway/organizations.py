"""The organization above the bound workspace: its members and their roles.

Every route acts on the organization the request's workspace belongs to
(`current`), which the policy on `organization_members` derives from the bound
workspace, and only its `org_admin`s may use them. Creating organizations and
workspaces in them comes later; see `docs/design/organizations-v1.md`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import OrganizationMember, Tenant, User, require_tenant_id
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_organization_store,
    get_session,
    get_user_store,
)
from switch_core.gateway.schemas import (
    OrganizationMemberDetail,
    OrganizationMemberUpdateRequest,
)

router = APIRouter()


def _member_detail(user: User, member: OrganizationMember) -> OrganizationMemberDetail:
    return OrganizationMemberDetail(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=member.role,
        created_at=str(member.created_at),
    )


async def _require_organization_admin(
    session: AsyncSession, user_store: UserStore, user: User
) -> str:
    """The bound workspace's organization id; 403 unless `user` is its
    `org_admin`, 404 when the workspace belongs to no organization."""
    tenant_id = require_tenant_id()
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or tenant.organization_id is None:
        raise HTTPException(
            status_code=404, detail="This workspace belongs to no organization"
        )
    if (
        await user_store.organization_role(session, tenant_id, user.id)
        != ORGANIZATION_ADMIN_ROLE
    ):
        raise HTTPException(
            status_code=403, detail="Only an organization admin may do this"
        )
    return tenant.organization_id


@router.get("/organizations/current/members")
async def list_organization_members(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[OrganizationMemberDetail]:
    """Every member of the organization and their role in it. `org_admin` only:
    the list spans every workspace of the organization, not only this one."""
    await _require_organization_admin(session, user_store, user)
    members = await organization_store.list_members(session)
    return [_member_detail(member_user, member) for member_user, member in members]


@router.patch("/organizations/current/members/{user_id}")
async def update_organization_member_role(
    user_id: str,
    req: OrganizationMemberUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationMemberDetail:
    """Make a member `org_admin`, or an `org_admin` a `member`. `org_admin` only,
    the one role that grants `org_admin`.

    Refuses to demote the last `org_admin`: nobody else could grant the role
    again. Recorded in the bound workspace's audit log.
    """
    organization_id = await _require_organization_admin(session, user_store, user)
    member = await session.get(OrganizationMember, (organization_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    if (
        member.role == ORGANIZATION_ADMIN_ROLE
        and req.role != ORGANIZATION_ADMIN_ROLE
        and await organization_store.count_admins(session) <= 1
    ):
        raise HTTPException(
            status_code=409, detail="Cannot demote the last organization admin"
        )

    if member.role != req.role:
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=user.id,
            action=AuditAction.ORGANIZATION_ROLE_CHANGED,
            target_type="user",
            target_id=user_id,
            details={
                "organization_id": organization_id,
                "from": member.role,
                "to": req.role,
            },
        )
    member.role = req.role
    await session.commit()

    target = await user_store.get(session, user_id)
    assert target is not None
    return _member_detail(target, member)
