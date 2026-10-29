"""Organizations: creating them, their workspaces, and their members.

`GET` and `POST /organizations` need no workspace: they list the caller's
organizations and create a new one. Every other route acts on the
organization the request's workspace belongs to (`current`), which the policy
on `organization_members` derives from the bound workspace. Its workspaces
are listed to anyone in it; creating a workspace and managing members is for
its `org_admin`s. The one exception is an organization with no `org_admin`
left: the platform operator may list its members and make one of them
`org_admin`, and being there on the operator flag alone, does so on
`platform_access`, recorded as every operator write is (`gateway/auth.py`).

Changes to the organization itself are recorded in its own audit log
(`organization_audit_events`), whichever workspace they were made from, and
read back by its `org_admin`s. See `docs/design/organizations-v1.md`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.audit import (
    OrganizationAuditAction,
    list_organization_audit_events,
    record_organization_audit_event,
)
from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    get_authenticated_caller,
    get_authenticated_user_id,
    get_current_user,
    organization_workspaces_bindable_by,
    organizations_bindable_by,
    workspaces_in_organization,
)
from switch_core.gateway.dependencies import (
    get_client_lifecycle,
    get_config,
    get_organization_store,
    get_session,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.schemas import (
    CurrentOrganizationResponse,
    OrganizationAuditEventDetail,
    OrganizationCreateRequest,
    OrganizationCreateResponse,
    OrganizationMemberDetail,
    OrganizationMemberUpdateRequest,
    OrganizationSummary,
    TenantMembershipResponse,
    WorkspaceCreateRequest,
)
from switch_core.gateway.workspace_creation import (
    create_organization_for,
    create_workspace,
    lock_workspace_allowance,
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


async def _current_organization_id(session: AsyncSession) -> str:
    """The bound workspace's organization id; 404 when it belongs to none."""
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None or tenant.organization_id is None:
        raise HTTPException(
            status_code=404, detail="This workspace belongs to no organization"
        )
    return tenant.organization_id


class _OrganizationAccess(NamedTuple):
    organization_id: str
    # Let through on the operator flag alone, to restore an `org_admin`,
    # rather than as one: what the organization's audit log marks as
    # `platform_access`.
    platform_access: bool


async def _require_organization_admin(
    session: AsyncSession,
    user_store: UserStore,
    organization_store: OrganizationStore,
    user: User,
    *,
    operator_restores: bool,
) -> _OrganizationAccess:
    """The bound workspace's organization, and how `user` got in; 403 unless
    they are its `org_admin`, 404 when the workspace belongs to no
    organization.

    With `operator_restores`, the platform operator passes too while the
    organization has no `org_admin`, so that someone can be made one. That is
    the organization's own decision, not the workspace's: an operator who
    administers the bound workspace by role still has no role here.
    """
    organization_id = await _current_organization_id(session)
    if (
        await user_store.organization_role(session, require_tenant_id(), user.id)
        == ORGANIZATION_ADMIN_ROLE
    ):
        return _OrganizationAccess(organization_id, platform_access=False)
    if (
        operator_restores
        and user.role == "admin"
        and await organization_store.count_admins(session, organization_id) == 0
    ):
        return _OrganizationAccess(organization_id, platform_access=True)
    raise HTTPException(
        status_code=403, detail="Only an organization admin may do this"
    )


@router.get("/organizations")
async def list_organizations(
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> list[OrganizationSummary]:
    """The organizations of the workspaces the caller may enter, and their
    role in each. Like `GET /tenants`, it needs no workspace selected.
    An organization the caller belongs to without being in any of its
    workspaces is left out (`gateway/auth.organizations_bindable_by`).
    """
    return await organizations_bindable_by(session_factory, user_store, user_id)


@router.post("/organizations", status_code=201)
async def create_organization(
    req: OrganizationCreateRequest,
    response: Response,
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> OrganizationCreateResponse:
    """Create an organization with its first workspace. The caller becomes the
    organization's `org_admin` and the workspace's `owner`, and their session
    switches into the workspace.

    Anyone signed in may, as `workspace_creation_refusal` decides: sign-up
    mode, and a per-person cap on workspaces created, with the platform
    operator exempt. Authenticated with `get_authenticated_caller`, because
    the caller who most needs this, someone who has just signed up, has no
    workspace for `get_current_user` to bind.
    """
    return await create_organization_for(
        response,
        caller,
        session,
        session_factory,
        user_store,
        organization_store,
        client_lifecycle,
        config,
        name=req.name,
        workspace_name=req.workspace_name or req.name,
    )


@router.get("/organizations/current")
async def current_organization(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> CurrentOrganizationResponse:
    """The organization the bound workspace belongs to, and the caller's role
    in it. Unlike `GET /organizations`, it answers for anyone bound to the
    workspace, the platform operator included."""
    organization_id = await _current_organization_id(session)
    organization = await session.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return CurrentOrganizationResponse(
        id=organization.id,
        slug=organization.slug,
        name=organization.name,
        role=await user_store.organization_role(session, require_tenant_id(), user.id),
    )


@router.get("/organizations/current/workspaces")
async def list_organization_workspaces(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[TenantMembershipResponse]:
    """The organization's workspaces the caller may enter, and their role in
    each: every one for an `org_admin`, their own for a member, and every one
    for the platform operator, who may enter any."""
    organization_id = await _current_organization_id(session)
    # Let go of the request's connection while each workspace is read on a
    # session of its own.
    await session.commit()
    return await organization_workspaces_bindable_by(
        session_factory,
        user_store,
        user.id,
        organization_id,
        is_operator=user.role == "admin",
    )


@router.post("/organizations/current/workspaces", status_code=201)
async def create_organization_workspace(
    req: WorkspaceCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
) -> TenantMembershipResponse:
    """Add a workspace to the organization. `org_admin` only; the creator
    becomes its `owner`. The session stays where it is: an `org_admin` adds
    workspaces for others as often as for themselves.

    Counts against the creator's allowance as every workspace does, and is
    refused where the deployment allows none, but not by `invite_only`
    sign-up, which governs who comes onto the server rather than what an
    organization adds. The platform operator is exempt, as everywhere.
    """
    access = await _require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    organization_id = access.organization_id
    allowance = (
        None
        if user.role == "admin"
        else await lock_workspace_allowance(
            session, user.id, config, new_organization=False
        )
    )
    if allowance is None:
        # Not held across provisioning, which opens a session per tenant.
        await session.commit()
    tenant = await create_workspace(
        session_factory,
        user_store,
        client_lifecycle,
        organization_id,
        user.id,
        req.name,
    )
    if allowance is not None:
        allowance.workspaces_created += 1
        await session.commit()
    return TenantMembershipResponse(
        id=tenant.id,
        slug=tenant.slug,
        name=tenant.name,
        role="owner",
        organization_role=ORGANIZATION_ADMIN_ROLE,
        organization_id=organization_id,
    )


def _made_from(access: _OrganizationAccess) -> dict[str, object]:
    """Where an organization change was made: the workspace the request was
    bound to, and whether the platform operator made it on the operator flag
    alone."""
    details: dict[str, object] = {"workspace_id": require_tenant_id()}
    if access.platform_access:
        details["platform_access"] = True
    return details


@router.get("/organizations/current/audit-events")
async def list_organization_audit_log(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: Annotated[datetime | None, Query()] = None,
) -> list[OrganizationAuditEventDetail]:
    """The organization's audit log, newest first. `org_admin` only.

    Page back by passing the oldest `occurred_at` returned as `before`. The
    actor, and a target that is a person, come with their names, read from
    `users`, which outlives membership.
    """
    access = await _require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    organization_id = access.organization_id
    events = await list_organization_audit_events(
        session, organization_id=organization_id, limit=limit, before=before
    )
    names = await user_store.names_by_id(
        session,
        {event.actor_user_id for event in events if event.actor_user_id}
        | {
            event.target_id
            for event in events
            if event.target_type == "user" and event.target_id
        },
    )
    return [
        OrganizationAuditEventDetail(
            id=event.id,
            occurred_at=event.occurred_at.isoformat(),
            actor_user_id=event.actor_user_id,
            actor_name=names.get(event.actor_user_id) if event.actor_user_id else None,
            action=event.action,
            target_type=event.target_type,
            target_id=event.target_id,
            target_name=(
                names.get(event.target_id)
                if event.target_type == "user" and event.target_id
                else None
            ),
            details=event.details,
        )
        for event in events
    ]


@router.get("/organizations/current/members")
async def list_organization_members(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[OrganizationMemberDetail]:
    """Every member of the organization and their role in it. `org_admin` only:
    the list spans every workspace of the organization, not only this one."""
    access = await _require_organization_admin(
        session, user_store, organization_store, user, operator_restores=True
    )
    organization_id = access.organization_id
    members = await organization_store.list_members(session, organization_id)
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
    again. Recorded in the organization's audit log.
    """
    access = await _require_organization_admin(
        session, user_store, organization_store, user, operator_restores=True
    )
    organization_id = access.organization_id
    member = await session.get(OrganizationMember, (organization_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    if (
        member.role == ORGANIZATION_ADMIN_ROLE
        and req.role != ORGANIZATION_ADMIN_ROLE
        and await organization_store.count_admins(session, organization_id) <= 1
    ):
        raise HTTPException(
            status_code=409, detail="Cannot demote the last organization admin"
        )

    if member.role != req.role:
        await record_organization_audit_event(
            session,
            organization_id=organization_id,
            actor_user_id=user.id,
            action=OrganizationAuditAction.ROLE_CHANGED,
            target_type="user",
            target_id=user_id,
            details={
                "from": member.role,
                "to": req.role,
                **_made_from(access),
            },
        )
    member.role = req.role
    await session.commit()

    target = await user_store.get(session, user_id)
    assert target is not None
    return _member_detail(target, member)


@router.delete("/organizations/current/members/{user_id}")
async def remove_organization_member(
    user_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    """Remove someone from the organization. `org_admin` only.

    Refuses while they still belong to any of its workspaces, naming them:
    leaving a workspace revokes their keys and connections there and refuses
    while they own agents, and that is the workspace member route's to do,
    one workspace at a time. Refuses the last `org_admin` too. Recorded in
    the organization's audit log.
    """
    access = await _require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    organization_id = access.organization_id
    member = await session.get(OrganizationMember, (organization_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    if (
        member.role == ORGANIZATION_ADMIN_ROLE
        and await organization_store.count_admins(session, organization_id) <= 1
    ):
        raise HTTPException(
            status_code=409, detail="Cannot remove the last organization admin"
        )
    role = member.role
    # Let go of the request's connection while each workspace is read on a
    # session of its own.
    await session.commit()

    workspaces = await workspaces_in_organization(
        session_factory, user_id, organization_id
    )
    if workspaces:
        names = ", ".join(sorted(tenant.name for tenant in workspaces))
        raise HTTPException(
            status_code=409,
            detail=(f"Remove them from the organization's workspaces first: {names}"),
        )

    await session.execute(
        delete(OrganizationMember).where(
            OrganizationMember.organization_id == organization_id,
            OrganizationMember.user_id == user_id,
        )
    )
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.MEMBER_REMOVED,
        target_type="user",
        target_id=user_id,
        details={"role": role, **_made_from(access)},
    )
    await session.commit()
    return {"ok": True}
