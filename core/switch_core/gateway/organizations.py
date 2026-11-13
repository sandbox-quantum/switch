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

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.registration_bootstrap import (
    SERVICE_ACCOUNT_ADMIN_REFUSAL,
    is_bootstrap_owner,
)
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.db.audit import (
    OrganizationAuditAction,
    list_organization_audit_events,
    record_organization_audit_event,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    get_authenticated_caller,
    get_authenticated_user_id,
    get_current_user,
    organization_candidates,
    organization_workspaces,
    organization_workspaces_bindable_by,
    organizations_bindable_by,
    rebind_if_left,
    session_auth_time,
    workspaces_in_organization,
    workspaces_reached_through_organization,
)
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_api_key_store,
    get_client_lifecycle,
    get_config,
    get_organization_directory,
    get_organization_store,
    get_protocol,
    get_room_store,
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
    OrganizationIssueDetail,
    OrganizationMemberDetail,
    OrganizationMemberListEntry,
    OrganizationMemberUpdateRequest,
    OrganizationMemberWorkspace,
    OrganizationRenameRequest,
    OrganizationRenameResponse,
    OrganizationSummary,
    OrganizationWorkspaceResponse,
    TenantMembershipResponse,
    WorkspaceCreateRequest,
)
from switch_core.gateway.service_connections import service_refusal
from switch_core.gateway.workos_sign_in_routes import (
    directory_access_token,
    directory_subject,
)
from switch_core.gateway.workspace_creation import (
    NOTHING_CHANGED,
    create_organization_for,
    create_workspace,
    directory_failed,
    lock_workspace_allowance,
)
from switch_core.organization_access import (
    AccessRevocation,
    end_access_through_organization,
    workspaces_where_they_own_agents,
)
from switch_core.organization_directory import (
    NO_DIRECTORY_CHANGE,
    DirectoryError,
    DirectorySignInRequired,
    MemberChange,
    OrganizationDirectory,
)
from switch_core.organization_issues import (
    organization_wide_issues,
    workspace_issues,
)
from switch_core.workos_sign_in import OrganizationToken

router = APIRouter()

logger = logging.getLogger(__name__)


def _member_detail(
    user: User,
    member: OrganizationMember,
    warning: str | None,
    *,
    access: OrganizationAccess | None,
    accepts_promotion: bool,
) -> OrganizationMemberDetail:
    """`member`, with what the caller, who passes the role-change gate as
    `access` says (None: they don't), may do with them: their own row
    included, so an `org_admin` steps down or leaves while another remains."""
    change = access is not None
    return OrganizationMemberDetail(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=member.role,
        created_at=str(member.created_at),
        warning=warning,
        service_account=is_bootstrap_owner(user),
        can_change_role=change,
        # Never the registration service account (`SERVICE_ACCOUNT_ADMIN_REFUSAL`).
        can_grant_org_admin=change
        and accepts_promotion
        and not is_bootstrap_owner(user),
        # Removing takes the organization's own admin; the operator restoring
        # one is let through to change roles only.
        can_remove=access is not None and not access.platform_access,
    )


def _accepts_promotion(
    organization_directory: OrganizationDirectory, organization: Organization
) -> bool:
    """Whether someone may be made `org_admin` from Switch at all: not in an
    organization whose members come from a directory Switch cannot change,
    where that is done in the directory (`OrganizationDirectory.prepare_change`).
    Whether the directory takes a given person is asked when it is done."""
    return not organization_directory.keeps_members_of(
        organization
    ) or organization_directory.sends_changes_for(organization)


async def _current_organization_id(session: AsyncSession) -> str:
    """The bound workspace's organization id; 404 when it belongs to none."""
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None or tenant.organization_id is None:
        raise HTTPException(
            status_code=404, detail="This workspace belongs to no organization"
        )
    return tenant.organization_id


class OrganizationAccess(NamedTuple):
    organization_id: str
    # Let through on the operator flag alone, to restore an `org_admin`,
    # rather than as one: what the organization's audit log marks as
    # `platform_access`.
    platform_access: bool


async def organization_access(
    session: AsyncSession,
    user_store: UserStore,
    organization_store: OrganizationStore,
    user: User,
    *,
    operator_restores: bool,
) -> OrganizationAccess | None:
    """How `user` gets into the bound workspace's organization as its admin,
    or None when they don't; 404 when the workspace belongs to no
    organization.

    With `operator_restores`, the platform operator gets in too while the
    organization has no `org_admin`, so that someone can be made one. That is
    the organization's own decision, not the workspace's: an operator who
    administers the bound workspace by role still has no role here.
    """
    organization_id = await _current_organization_id(session)
    if (
        await user_store.organization_role(session, require_tenant_id(), user.id)
        == ORGANIZATION_ADMIN_ROLE
    ):
        return OrganizationAccess(organization_id, platform_access=False)
    if (
        operator_restores
        and user.role == "admin"
        and await organization_store.count_admins(session, organization_id) == 0
    ):
        return OrganizationAccess(organization_id, platform_access=True)
    return None


async def require_organization_admin(
    session: AsyncSession,
    user_store: UserStore,
    organization_store: OrganizationStore,
    user: User,
    *,
    operator_restores: bool,
) -> OrganizationAccess:
    """`organization_access`, refused with 403 when there is none."""
    access = await organization_access(
        session,
        user_store,
        organization_store,
        user,
        operator_restores=operator_restores,
    )
    if access is None:
        raise HTTPException(
            status_code=403, detail="Only an organization admin may do this"
        )
    return access


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
    request: Request,
    response: Response,
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> OrganizationCreateResponse:
    """Create an organization with its first workspace. The caller becomes the
    organization's `org_admin` and the workspace's `admin`, and their session
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
        organization_directory,
        client_lifecycle,
        config,
        name=req.name,
        workspace_name=req.workspace_name or req.name,
        auth_time=session_auth_time(request),
    )


@router.get("/organizations/current")
async def current_organization(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> CurrentOrganizationResponse:
    """The organization the bound workspace belongs to, and the caller's role
    in it. Unlike `GET /organizations`, it answers for anyone bound to the
    workspace, the platform operator included."""
    organization_id = await _current_organization_id(session)
    organization = await session.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    role = await user_store.organization_role(session, require_tenant_id(), user.id)
    return CurrentOrganizationResponse(
        id=organization.id,
        slug=organization.slug,
        name=organization.name,
        role=role,
        members_from_directory=organization_directory.keeps_members_of(organization),
        directory_takes_changes=organization_directory.sends_changes_for(organization),
        administers=role == ORGANIZATION_ADMIN_ROLE,
        can_manage_members=await organization_access(
            session, user_store, organization_store, user, operator_restores=True
        )
        is not None,
    )


@router.patch("/organizations/current")
async def rename_current_organization(
    req: OrganizationRenameRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationRenameResponse:
    """Rename the organization. Its `org_admin`s only: the operator who may
    restore one is let in to change roles, not this. The slug stays as it
    is, being an identifier. One whose members come from a directory such
    as WorkOS keeps its own name here: Switch writes nothing about the
    organization there, and reads no name back. The name it already has
    changes and records nothing; a rename is recorded in its audit log."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    # Locked, so renames made at the same moment each record the name they
    # replaced.
    organization = await session.get(
        Organization, access.organization_id, with_for_update=True
    )
    if organization is None:
        raise RuntimeError(f"Organization {access.organization_id} is not visible here")
    if req.name != organization.name:
        await record_organization_audit_event(
            session,
            organization_id=organization.id,
            actor_user_id=user.id,
            action=OrganizationAuditAction.ORGANIZATION_RENAMED,
            target_type="organization",
            target_id=organization.id,
            details={
                "name": req.name,
                "previous_name": organization.name,
                **made_from(access),
            },
        )
        organization.name = req.name
        await session.commit()
        logger.info("User %s renamed organization %s", user.id, organization.id)
    return OrganizationRenameResponse(id=access.organization_id, name=req.name)


@router.get("/organizations/current/workspaces")
async def list_organization_workspaces(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[OrganizationWorkspaceResponse]:
    """The organization's workspaces the caller may enter, and their role in
    each: every one for an `org_admin`, their own for a member, and every one
    for the platform operator, who may enter any. Each with what the
    Workspaces page shows of it: when it was made, its counts, and its admins
    by membership."""
    organization_id = await _current_organization_id(session)
    current_id = require_tenant_id()
    # Let go of the request's connection while each workspace is read on a
    # session of its own.
    await session.commit()
    workspaces = await organization_workspaces_bindable_by(
        session_factory,
        user_store,
        user.id,
        organization_id,
        is_operator=user.role == "admin",
    )
    administers = (
        await organization_access(
            session, user_store, organization_store, user, operator_restores=False
        )
        is not None
    )
    await session.commit()
    described: list[OrganizationWorkspaceResponse] = []
    for workspace in workspaces:
        async with tenant_session(session_factory, workspace.id) as bound:
            tenant = await bound.get(Tenant, workspace.id)
            if tenant is None:
                logger.warning(
                    "Workspace %s of organization %s was gone by the time it "
                    "was described",
                    workspace.id,
                    organization_id,
                )
                continue
            blocked = (
                _ARCHIVE_ADMINS_ONLY
                if not administers
                else archive_blocked_reason(tenant.id, current_id)
            )
            described.append(
                OrganizationWorkspaceResponse(
                    **workspace.model_dump(),
                    created_at=str(tenant.created_at),
                    users=await user_store.count_people(bound, tenant),
                    agents=await agent_store.count(bound),
                    rooms=await room_store.count(bound),
                    admins=await user_store.admin_names(bound, tenant),
                    can_archive=tenant.archived_at is None and blocked is None,
                    archive_blocked_reason=(
                        blocked if tenant.archived_at is None else None
                    ),
                    can_restore=tenant.archived_at is not None and administers,
                )
            )
    return described


# Why a workspace can't be archived, as the Workspaces page shows it.
_ARCHIVE_ADMINS_ONLY = "Only an organization admin can archive a workspace."
_ARCHIVE_CURRENT = "You're working in this workspace. Switch to another one first."
_ARCHIVE_DEFAULT = (
    "Everyone who signs up joins this workspace, so it can't be archived."
)


def archive_blocked_reason(workspace_id: str, current_id: str) -> str | None:
    """Why an organization admin may not archive `workspace_id` from
    `current_id`, the workspace their request is bound to, or None when they
    may."""
    if workspace_id == current_id:
        return _ARCHIVE_CURRENT
    if workspace_id == TENANT_ZERO_ID:
        return _ARCHIVE_DEFAULT
    return None


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
    becomes its `admin`. The session stays where it is: an `org_admin` adds
    workspaces for others as often as for themselves.

    Counts against the creator's allowance as every workspace does, and is
    refused where the deployment allows none, but not by `invite_only`
    sign-up, which governs who comes onto the server rather than what an
    organization adds. The platform operator is exempt, as everywhere.
    """
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    organization_id = access.organization_id
    await _refuse_a_name_taken(
        session, session_factory, organization_id, user.id, req.name
    )
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
        role="admin",
        organization_role=ORGANIZATION_ADMIN_ROLE,
        organization_id=organization_id,
        archived_at=None,
    )


async def _refuse_a_name_taken(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    organization_id: str,
    admin_id: str,
    name: str,
) -> None:
    """409 when the organization already has a workspace called `name`, in any
    case: two of the same name could not be told apart in the switcher. A
    check before creating, not a constraint, so two made at the same moment
    could still share one, which nothing breaks."""
    wanted = name.strip().casefold()
    taken = [
        tenant.name
        for tenant in await organization_workspaces(
            session_factory, admin_id, organization_id
        )
        if tenant.name.strip().casefold() == wanted
    ]
    if taken:
        organization = await _organization(session, organization_id)
        raise HTTPException(
            status_code=409,
            detail=f"{organization.name} already has a workspace called “{taken[0]}”.",
        )


def made_from(access: OrganizationAccess) -> dict[str, object]:
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
    access = await require_organization_admin(
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


@router.get("/organizations/current/issues")
async def list_organization_issues(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[OrganizationIssueDetail]:
    """What in the organization needs an admin's attention now
    (`organization_issues.py`), read from how things stand rather than from
    the audit log, so an issue is gone once fixed. `org_admin` only, and the
    platform operator while the organization has none."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=True
    )
    issues, admins = await organization_wide_issues(session, access.organization_id)
    # Let go of the request's connection while each workspace is read on a
    # session of its own.
    await session.commit()
    issues += await workspace_issues(
        session_factory,
        user_store,
        organization_id=access.organization_id,
        admins=admins,
        candidates=await organization_candidates(
            session_factory,
            user.id,
            access.organization_id,
            is_operator=access.platform_access,
        ),
    )
    return [
        OrganizationIssueDetail(
            kind=issue.kind,
            workspace_id=issue.workspace_id,
            workspace_name=issue.workspace_name,
            agents=issue.agents,
        )
        for issue in issues
    ]


@router.get("/organizations/current/members")
async def list_organization_members(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> list[OrganizationMemberListEntry]:
    """Every member of the organization, their role in it and the workspaces
    of it they hold a membership in. `org_admin` only: the list spans every
    workspace of the organization, not only this one."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=True
    )
    organization_id = access.organization_id
    accepts_promotion = _accepts_promotion(
        organization_directory, await _organization(session, organization_id)
    )
    members = await organization_store.list_members(session, organization_id)
    details = [
        _member_detail(
            member_user,
            member,
            None,
            access=access,
            accepts_promotion=accepts_promotion,
        )
        for member_user, member in members
    ]
    # Let go of the request's connection while each workspace is read on a
    # session of its own.
    await session.commit()
    held = await _memberships_in_organization(
        session_factory, user_store, user, organization_id
    )
    return [
        OrganizationMemberListEntry(
            **detail.model_dump(), workspaces=held.get(detail.user_id, [])
        )
        for detail in details
    ]


async def _memberships_in_organization(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user: User,
    organization_id: str,
) -> dict[str, list[OrganizationMemberWorkspace]]:
    """Each person's memberships in the organization's workspaces, by user id,
    the workspaces in name order: every workspace of it the caller reaches,
    which for its `org_admin` and the operator is every one."""
    held: dict[str, list[OrganizationMemberWorkspace]] = {}
    workspaces = await organization_workspaces_bindable_by(
        session_factory,
        user_store,
        user.id,
        organization_id,
        is_operator=user.role == "admin",
    )
    for workspace in sorted(workspaces, key=lambda w: (w.name.casefold(), w.id)):
        async with tenant_session(session_factory, workspace.id) as bound:
            rows = (
                await bound.execute(
                    select(TenantMember.user_id, TenantMember.role).where(
                        TenantMember.tenant_id == workspace.id
                    )
                )
            ).all()
        for user_id, role in rows:
            held.setdefault(user_id, []).append(
                OrganizationMemberWorkspace(
                    id=workspace.id,
                    name=workspace.name,
                    role=role,
                    archived=workspace.archived_at is not None,
                )
            )
    return held


# Why a change the directory did not make still took something away.
_ACCESS_ALREADY_ENDED = (
    "They keep their place in the organization, but what they held in "
    "workspaces they reached only as an organization admin has already been "
    "taken away."
)


async def _ask_directory(
    change: Callable[..., Awaitable[None]],
    organization: Organization,
    *args: str,
    member_change: MemberChange,
    access_ended: bool,
) -> None:
    """Ask the directory to make `change` to a member of `organization`, with
    `args` and `member_change`: after every check that can refuse, under the
    lock on the organization's admins, and before the write and its commit
    (`organization_directory.py`). `access_ended` says the person's access
    through the organization was ended on the way, which a refusal does not
    give back."""
    outcome = _ACCESS_ALREADY_ENDED if access_ended else NOTHING_CHANGED
    try:
        await change(organization, *args, member_change)
    except DirectorySignInRequired as error:
        raise _sign_in_required(error, outcome, access_ended) from None
    except DirectoryError as error:
        raise directory_failed(error, outcome) from None


def _sign_in_required(
    error: DirectorySignInRequired, outcome: str, access_ended: bool
) -> HTTPException:
    """403 the dashboard tells apart by its `error`: it sends the admin to
    sign in to the organization's WorkOS account and back to make the change
    again (`gateway/workos_sign_in_routes.py`). With `access_ended`, part of
    the change was made already, so the dashboard says so before it sends
    them anywhere."""
    return HTTPException(
        status_code=403,
        detail={
            "error": "directory_sign_in_required",
            "message": f"{error.message} {outcome}",
            "access_ended": access_ended,
        },
    )


# Why an operator restoring an `org_admin` can't make the change in WorkOS.
_OPERATOR_CANNOT_SIGN_IN = (
    "This organization's admins are kept in its account settings, and an "
    "operator can't change them there. Have someone made org_admin in the "
    "organization's account settings; Switch follows once it reads them "
    "again. Nothing was changed."
)


async def _member_change(
    session: AsyncSession,
    user_store: UserStore,
    organization_directory: OrganizationDirectory,
    token: OrganizationToken | None,
    access: OrganizationAccess,
    organization: Organization,
    user_id: str,
    role: str | None,
) -> MemberChange:
    """What giving `user_id` `role` in `organization`, or removing them when
    `role` is None, needs of the directory, with the admin's token when it
    was issued for the organization's WorkOS organization. Asked before
    anything is changed and before any lock is taken, so a refusal or a
    sign-in costs nothing. An operator let in to restore an `org_admin` has
    no token to sign in for, and is told who can make the change instead."""
    access_token = (
        token.access_token
        if token is not None
        and token.workos_organization_id == organization.workos_organization_id
        else None
    )
    subject = await directory_subject(
        session, user_store, organization_directory, user_id
    )
    # Let go of the request's connection while the directory is asked.
    await session.commit()
    try:
        return await organization_directory.prepare_change(
            organization, subject, role, access_token
        )
    except DirectorySignInRequired as error:
        if access.platform_access:
            raise HTTPException(
                status_code=409, detail=_OPERATOR_CANNOT_SIGN_IN
            ) from None
        raise _sign_in_required(error, NOTHING_CHANGED, access_ended=False) from None
    except DirectoryError as error:
        raise directory_failed(error, NOTHING_CHANGED) from None


async def _organization(session: AsyncSession, organization_id: str) -> Organization:
    organization = await session.get(Organization, organization_id)
    if organization is None:
        raise RuntimeError(f"Organization {organization_id} is not visible here")
    return organization


async def _lock_admins_keeping_one(
    session: AsyncSession,
    organization_store: OrganizationStore,
    organization_id: str,
    user_id: str,
    *,
    last_admin: str,
) -> OrganizationMember:
    """Lock the organization's `org_admin` rows on `session` until the change
    commits (`OrganizationStore.lock_admins`), and refuse, 409 `last_admin`,
    if taking `user_id` out of the role would leave none.

    Taken once the directory has been asked what the change needs, which lets
    go of the request's transaction (`_member_change`), and before anything is
    changed or taken away; held to the commit. Of two admins demoting or
    removing each other at once, the second then counts after the first has
    committed, and is refused with nothing of the other's touched. Nothing
    after it may commit before the change. Returns their membership as it
    stands once locked: the other may have changed it meanwhile."""
    admins = await organization_store.lock_admins(session, organization_id)
    member = await session.get(
        OrganizationMember, (organization_id, user_id), populate_existing=True
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    if member.role == ORGANIZATION_ADMIN_ROLE and admins <= 1:
        raise HTTPException(status_code=409, detail=last_admin)
    return member


async def _end_access_through_organization(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str,
    organization_id: str,
    actor_id: str,
    reason: str,
    revocation: AccessRevocation,
) -> str | None:
    """Take away what `user_id` holds in the workspaces they stand in only as
    the organization's `org_admin`, before they stop being one
    (`organization_access.end_access_through_organization`).

    Refuses, 409 naming the workspaces, while they own agents in any of them,
    as removing a workspace member does.
    """
    reached = await workspaces_reached_through_organization(
        session_factory, user_id, organization_id
    )
    with_agents = await workspaces_where_they_own_agents(
        session_factory, revocation.agent_store, user_id, reached
    )
    if with_agents:
        raise HTTPException(
            status_code=409,
            detail=(
                "They own agents in workspaces they're in only as an "
                "organization admin. Delete those agents first: "
                f"{', '.join(sorted(tenant.name for tenant in with_agents))}"
            ),
        )
    return await end_access_through_organization(
        session_factory,
        revocation,
        user_id=user_id,
        reached=reached,
        actor_id=actor_id,
        details={"reason": reason},
    )


@router.patch("/organizations/current/members/{user_id}", response_model=None)
async def update_organization_member_role(
    request: Request,
    response: Response,
    user_id: str,
    req: OrganizationMemberUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    directory_token: Annotated[
        OrganizationToken | None, Depends(directory_access_token)
    ],
    user: Annotated[User, Depends(get_current_user)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> OrganizationMemberDetail | JSONResponse:
    """Make a member `org_admin`, or an `org_admin` a `member`. `org_admin` only,
    the one role that grants `org_admin`; their own role included, so an
    `org_admin` steps down while another remains, and the session moves off
    a workspace they could enter only as one (`rebind_if_left`).

    Refuses to demote the last `org_admin`: nobody else could grant the role
    again. Demoting someone first takes away what they hold in the workspaces
    they were in only as `org_admin` (`_end_access_through_organization`).
    The directory is asked last, once every check has passed
    (`_ask_directory`). Recorded in the organization's audit log.
    """
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=True
    )
    organization_id = access.organization_id
    member = await session.get(OrganizationMember, (organization_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    if req.role == ORGANIZATION_ADMIN_ROLE and member.role != ORGANIZATION_ADMIN_ROLE:
        target = await user_store.get(session, user_id)
        if target is None:
            raise RuntimeError(f"Organization member {user_id} has no user")
        if is_bootstrap_owner(target):
            raise HTTPException(status_code=409, detail=SERVICE_ACCOUNT_ADMIN_REFUSAL)
    last_admin = "Cannot demote the last organization admin"
    # Before the directory is asked, so the plain case costs no sign-in; the
    # count that decides is taken under the lock below.
    if (
        member.role == ORGANIZATION_ADMIN_ROLE
        and req.role != ORGANIZATION_ADMIN_ROLE
        and await organization_store.count_admins(session, organization_id) <= 1
    ):
        raise HTTPException(status_code=409, detail=last_admin)
    organization = await _organization(session, organization_id)
    member_change = (
        await _member_change(
            session,
            user_store,
            organization_directory,
            directory_token,
            access,
            organization,
            user_id,
            req.role,
        )
        if member.role != req.role
        else NO_DIRECTORY_CHANGE
    )
    if member.role == ORGANIZATION_ADMIN_ROLE and req.role != ORGANIZATION_ADMIN_ROLE:
        member = await _lock_admins_keeping_one(
            session,
            organization_store,
            organization_id,
            user_id,
            last_admin=last_admin,
        )
    demoting = (
        member.role == ORGANIZATION_ADMIN_ROLE and req.role != ORGANIZATION_ADMIN_ROLE
    )

    warning = None
    if demoting:
        # On sessions of its own, while this one holds the admins' lock.
        try:
            warning = await _end_access_through_organization(
                session_factory,
                user_id=user_id,
                organization_id=organization_id,
                actor_id=user.id,
                reason="demoted",
                revocation=AccessRevocation(
                    agent_store=agent_store,
                    api_key_store=api_key_store,
                    broker=broker,
                    protocol=protocol,
                    sign_in_flows=request.app.state.sign_in_flows,
                ),
            )
        except ServiceError as error:
            return service_refusal(error)

    if member.role != req.role:
        await _ask_directory(
            organization_directory.set_role,
            organization,
            user_id,
            req.role,
            member_change=member_change,
            access_ended=demoting,
        )
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
                **made_from(access),
            },
        )
    member.role = req.role
    await session.commit()

    target = await user_store.get(session, user_id)
    assert target is not None
    if user_id == user.id:
        await rebind_if_left(
            request, response, session_factory, user_store, user, config
        )
    return _member_detail(
        target,
        member,
        warning,
        # Read again: the change may be what let the caller in, or the
        # operator's way in may have closed with it.
        access=await organization_access(
            session, user_store, organization_store, user, operator_restores=True
        ),
        accepts_promotion=_accepts_promotion(organization_directory, organization),
    )


@router.delete("/organizations/current/members/{user_id}", response_model=None)
async def remove_organization_member(
    request: Request,
    response: Response,
    user_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    directory_token: Annotated[
        OrganizationToken | None, Depends(directory_access_token)
    ],
    user: Annotated[User, Depends(get_current_user)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict | JSONResponse:
    """Remove someone from the organization. `org_admin` only, themselves
    included, so an `org_admin` leaves while another remains; the session
    then moves off a workspace they could enter only as one (`rebind_if_left`).

    Refuses while they still belong to any of its workspaces, naming them:
    leaving a workspace revokes their keys and connections there and refuses
    while they own agents, and that is the workspace member route's to do,
    one workspace at a time. An `org_admin` also stands in workspaces they
    hold no membership row in, and what they hold there is taken away first
    (`_end_access_through_organization`). Refuses the last `org_admin` too.
    The directory is asked last, once every check has passed
    (`_ask_directory`). Recorded in the organization's audit log.
    """
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    organization_id = access.organization_id
    member = await session.get(OrganizationMember, (organization_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    last_admin = "Cannot remove the last organization admin"
    # As for a demotion: early, then decided under the lock below.
    if (
        member.role == ORGANIZATION_ADMIN_ROLE
        and await organization_store.count_admins(session, organization_id) <= 1
    ):
        raise HTTPException(status_code=409, detail=last_admin)
    organization = await _organization(session, organization_id)

    workspaces = await workspaces_in_organization(
        session_factory, user_id, organization_id
    )
    if workspaces:
        names = ", ".join(sorted(tenant.name for tenant in workspaces))
        raise HTTPException(
            status_code=409,
            detail=(f"Remove them from the organization's workspaces first: {names}"),
        )
    member_change = await _member_change(
        session,
        user_store,
        organization_directory,
        directory_token,
        access,
        organization,
        user_id,
        None,
    )
    if member.role == ORGANIZATION_ADMIN_ROLE:
        member = await _lock_admins_keeping_one(
            session,
            organization_store,
            organization_id,
            user_id,
            last_admin=last_admin,
        )
    was_admin = member.role == ORGANIZATION_ADMIN_ROLE
    warning = None
    if was_admin:
        try:
            warning = await _end_access_through_organization(
                session_factory,
                user_id=user_id,
                organization_id=organization_id,
                actor_id=user.id,
                reason="removed",
                revocation=AccessRevocation(
                    agent_store=agent_store,
                    api_key_store=api_key_store,
                    broker=broker,
                    protocol=protocol,
                    sign_in_flows=request.app.state.sign_in_flows,
                ),
            )
        except ServiceError as error:
            return service_refusal(error)

    await _ask_directory(
        organization_directory.remove,
        organization,
        user_id,
        member_change=member_change,
        access_ended=was_admin,
    )
    role = member.role
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
        details={"role": role, **made_from(access)},
    )
    await session.commit()
    if user_id == user.id:
        await rebind_if_left(
            request, response, session_factory, user_store, user, config
        )
    return {"ok": True, "warning": warning}
