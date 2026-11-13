"""An organization's admins acting on any of its workspaces, not only the one
their request is bound to: renaming one, choosing its admins, changing a
member's role or removing them, inviting people to it, adding someone already
in the organization, and archiving or restoring it.

A workspace's own routes (`gateway/tenants.py`) act on the bound workspace
alone, so the organization's Workspaces and Users pages would otherwise have
to switch the session into each workspace in turn. These do the same work,
through the same functions, on a session bound to the workspace named in the
path, once its organization is found to be the caller's and the caller its
`org_admin`. The platform operator, who may restore an `org_admin` to an
organization without one, is not let in: running its workspaces stays the
organization's.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.archived_workspace import WORKSPACE_ARCHIVED, archived_since
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.registration_bootstrap import (
    SERVICE_ACCOUNT_ADMIN_REFUSAL,
    is_bootstrap_owner,
)
from switch_core.config import SwitchConfig
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.db.audit import (
    AuditAction,
    OrganizationAuditAction,
    record_audit_event,
    record_organization_audit_event,
)
from switch_core.db.models import (
    OrganizationMember,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, rebind_if_left
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_api_key_store,
    get_config,
    get_invitation_store,
    get_invite_mailer,
    get_organization_store,
    get_protocol,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.invite_mail import InviteMailer
from switch_core.gateway.organizations import (
    OrganizationAccess,
    archive_blocked_reason,
    made_from,
    require_organization_admin,
)
from switch_core.gateway.schemas import (
    InvitationCreateRequest,
    InvitationCreateResponse,
    MemberUpdateRequest,
    OrganizationMemberAddRequest,
    OrganizationMemberWorkspace,
    TenantRenameRequest,
    TenantRenameResponse,
    WorkspaceAdminsRequest,
    WorkspaceAdminsResponse,
    WorkspaceArchiveResponse,
)
from switch_core.gateway.service_connections import service_refusal
from switch_core.gateway.tenants import (
    change_member_role,
    member_removal_preview,
    mint_invitation,
    remove_member_from_workspace,
    rename_workspace,
    validated_member_role,
)
from switch_core.gateway.workspace_creation import refuse_a_workspace_name_taken
from switch_core.organization_access import AccessRevocation
from switch_core.room_schedules import skip_missed_runs

router = APIRouter()

logger = logging.getLogger(__name__)

WORKSPACE = "/organizations/current/workspaces/{workspace_id}"
NOT_IN_ORGANIZATION = "That workspace isn't in this organization."


class _Acting:
    """An `org_admin` about to act on one of the organization's workspaces:
    how they got in, and where the request was made from, read while the
    request's own workspace is still the one bound (`made_from`)."""

    def __init__(self, access: OrganizationAccess, user: User) -> None:
        self.access = access
        self.user = user
        self.made_from = made_from(access)


async def _org_admin(
    session: AsyncSession,
    user_store: UserStore,
    organization_store: OrganizationStore,
    user: User,
) -> _Acting:
    """The caller as the bound workspace's organization's `org_admin`, or 403;
    then the request's connection let go, as the work is done on a session
    of the target workspace's own."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    acting = _Acting(access, user)
    await session.commit()
    return acting


@asynccontextmanager
async def _in_workspace(
    session_factory: async_sessionmaker[AsyncSession],
    acting: _Acting,
    workspace_id: str,
) -> AsyncIterator[tuple[AsyncSession, Tenant]]:
    """A session bound to `workspace_id`, and its row, locked until the
    session commits; 404 when it is not one of the caller's organization's,
    as when it does not exist, so a workspace elsewhere is not confirmed.

    The lock is `FOR NO KEY UPDATE`, which another change to the workspace
    (an archive, a rename) waits on and a row written in it does not: every
    write there checks its foreign key to `tenants` with `FOR KEY SHARE`,
    which `FOR UPDATE` would hold up for as long as this runs."""
    async with tenant_session(session_factory, workspace_id) as bound:
        tenant = await bound.get(
            Tenant, workspace_id, with_for_update={"key_share": True}
        )
        if tenant is None or tenant.organization_id != acting.access.organization_id:
            raise HTTPException(status_code=404, detail=NOT_IN_ORGANIZATION)
        yield bound, tenant


@router.patch(WORKSPACE)
async def rename_organization_workspace(
    workspace_id: str,
    req: TenantRenameRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> TenantRenameResponse:
    """Rename one of the organization's workspaces, as its own General page
    does (`tenants.rename_workspace`), recorded in both audit logs. Refused,
    409, for a name another of its workspaces has in any case."""
    acting = await _org_admin(session, user_store, organization_store, user)
    await refuse_a_workspace_name_taken(
        session,
        session_factory,
        acting.access.organization_id,
        req.name,
        renaming=workspace_id,
    )
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, _):
        if await rename_workspace(
            bound,
            workspace_id,
            req.name,
            actor_id=user.id,
            made_from=acting.made_from,
        ):
            await bound.commit()
    return TenantRenameResponse(id=workspace_id, name=req.name)


@router.put(f"{WORKSPACE}/admins")
async def set_organization_workspace_admins(
    workspace_id: str,
    req: WorkspaceAdminsRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> WorkspaceAdminsResponse:
    """Make exactly `req.user_ids` the workspace's admins among its members
    who are not the organization's `org_admin`s, the others members: the
    Workspaces page's Manage admins. The registration service account is
    neither, and is left as it is. All of it or none of it, each change
    checked as one made on the workspace's own page
    (`tenants.change_member_role`): never its last admin demoted. Someone
    named who is not such a member is refused, 400, with nothing changed."""
    acting = await _org_admin(session, user_store, organization_store, user)
    wanted = set(req.user_ids)
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, tenant):
        organization_admins = await organization_store.admin_ids(
            bound, acting.access.organization_id
        )
        members = {
            person.id: membership
            for person, membership in await user_store.list_tenant_members(bound)
            if person.id not in organization_admins and not is_bootstrap_owner(person)
        }
        unknown = wanted - set(members)
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Only members of the workspace who are not organization "
                    f"admins can be chosen: {', '.join(sorted(unknown))}"
                ),
            )
        # Promotions first, so a demotion never finds itself the last admin
        # when the workspace is to keep one.
        changes = sorted(
            (
                (user_id, "admin" if user_id in wanted else "member")
                for user_id, membership in members.items()
                if (membership.role == "admin") != (user_id in wanted)
            ),
            key=lambda change: change[1] != "admin",
        )
        for user_id, role in changes:
            await change_member_role(
                bound, user_store, workspace_id, user_id, role, actor_id=user.id
            )
        admins = await user_store.admin_names(bound, tenant)
        response = WorkspaceAdminsResponse(
            id=workspace_id, name=tenant.name, admins=admins
        )
        await bound.commit()
    return response


@router.post(f"{WORKSPACE}/members", status_code=201)
async def add_organization_member_to_workspace(
    workspace_id: str,
    req: OrganizationMemberAddRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationMemberWorkspace:
    """Add someone already in the organization to one of its workspaces, as
    `req.role`. Refused for someone outside the organization, who joins
    through an invitation; for someone already in the workspace; for an
    archived workspace; and for making the registration service account an
    admin. Recorded in the workspace's audit log and the organization's."""
    acting = await _org_admin(session, user_store, organization_store, user)
    organization_id = acting.access.organization_id
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, tenant):
        if await bound.get(OrganizationMember, (organization_id, req.user_id)) is None:
            raise HTTPException(
                status_code=404,
                detail="Not a member of this organization: invite them to a workspace.",
            )
        if tenant.archived_at is not None:
            raise HTTPException(status_code=409, detail=WORKSPACE_ARCHIVED)
        if await user_store.tenant_role(bound, workspace_id, req.user_id) is not None:
            raise HTTPException(
                status_code=409, detail=f"They're already in {tenant.name}."
            )
        person = await user_store.get(bound, req.user_id)
        assert person is not None
        if req.role == "admin" and is_bootstrap_owner(person):
            raise HTTPException(status_code=409, detail=SERVICE_ACCOUNT_ADMIN_REFUSAL)
        await user_store.add_membership(
            bound,
            tenant_id=workspace_id,
            user_id=req.user_id,
            role=req.role,
            organization_role="member",
        )
        await record_audit_event(
            bound,
            tenant_id=workspace_id,
            actor_user_id=user.id,
            action=AuditAction.MEMBER_ADDED_BY_ORGANIZATION,
            target_type="user",
            target_id=req.user_id,
            details={"role": req.role},
        )
        await record_organization_audit_event(
            bound,
            organization_id=organization_id,
            actor_user_id=user.id,
            action=OrganizationAuditAction.MEMBER_ADDED_TO_WORKSPACE,
            target_type="user",
            target_id=req.user_id,
            details={
                "workspace": workspace_id,
                "workspace_name": tenant.name,
                "role": req.role,
                **acting.made_from,
            },
        )
        added = OrganizationMemberWorkspace(
            id=tenant.id, name=tenant.name, role=req.role, archived=False
        )
        await bound.commit()
    return added


@router.patch(f"{WORKSPACE}/members/{{user_id}}")
async def change_organization_workspace_member_role(
    workspace_id: str,
    user_id: str,
    req: MemberUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationMemberWorkspace:
    """Change someone's role in one of the organization's workspaces, as its
    own Users page does (`tenants.change_member_role`)."""
    role = validated_member_role(req.role)
    acting = await _org_admin(session, user_store, organization_store, user)
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, tenant):
        _, membership = await change_member_role(
            bound, user_store, workspace_id, user_id, role, actor_id=user.id
        )
        changed = OrganizationMemberWorkspace(
            id=tenant.id,
            name=tenant.name,
            role=membership.role,
            archived=tenant.archived_at is not None,
        )
        await bound.commit()
    return changed


@router.get(f"{WORKSPACE}/members/{{user_id}}/removal")
async def preview_organization_workspace_member_removal(
    workspace_id: str,
    user_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict:
    """Who would receive what someone owns in one of the organization's
    workspaces if the caller removed them now (`tenants.member_removal_preview`)."""
    acting = await _org_admin(session, user_store, organization_store, user)
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, _):
        return await member_removal_preview(
            bound, user_store, workspace_id, user_id, actor_id=user.id
        )


@router.delete(f"{WORKSPACE}/members/{{user_id}}", response_model=None)
async def remove_organization_workspace_member(
    workspace_id: str,
    user_id: str,
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict | JSONResponse:
    """Remove someone from one of the organization's workspaces, as its own
    Users page does (`tenants.remove_member_from_workspace`): their keys and
    connections there revoked, what they own handed over, refused while they
    own agents there or are its last admin."""
    acting = await _org_admin(session, user_store, organization_store, user)
    revocation = AccessRevocation(
        agent_store=agent_store,
        api_key_store=api_key_store,
        broker=broker,
        protocol=protocol,
        sign_in_flows=request.app.state.sign_in_flows,
    )
    try:
        async with _in_workspace(session_factory, acting, workspace_id) as (bound, _):
            removed = await remove_member_from_workspace(
                bound, user_store, revocation, workspace_id, user_id, actor_id=user.id
            )
    except ServiceError as error:
        return service_refusal(error)
    if user_id == user.id:
        await rebind_if_left(
            request, response, session_factory, user_store, user, config
        )
    return removed


@router.post(f"{WORKSPACE}/invitations", status_code=201)
async def invite_to_organization_workspace(
    workspace_id: str,
    req: InvitationCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    mailer: Annotated[InviteMailer | None, Depends(get_invite_mailer)],
    user: Annotated[User, Depends(get_current_user)],
) -> InvitationCreateResponse:
    """Make an invite link to one of the organization's workspaces, as its own
    Users page does (`tenants.mint_invitation`): the Organization › Users
    page's Invite, for the workspace and role chosen there."""
    acting = await _org_admin(session, user_store, organization_store, user)
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, _):
        return await mint_invitation(
            bound, invitation_store, config, mailer, workspace_id, req, actor=user
        )


async def _set_archived(
    session_factory: async_sessionmaker[AsyncSession],
    acting: _Acting,
    workspace_id: str,
    *,
    archived: bool,
) -> WorkspaceArchiveResponse:
    """Archive or restore one of the organization's workspaces, with both
    audit logs' records of it in the same commit. One already as asked
    changes and records nothing."""
    user = acting.user
    async with _in_workspace(session_factory, acting, workspace_id) as (bound, tenant):
        if (tenant.archived_at is not None) != archived:
            # The database's clock, as the scheduler's (`RoomScheduler`): the
            # runs skipped on restore are those due by its now, not this
            # process's.
            now = (await bound.execute(select(func.clock_timestamp()))).scalar_one()
            tenant.archived_at = now if archived else None
            tenant.archived_by = user.id if archived else None
            if not archived:
                # In the commit that opens it, so the scheduler never sees it
                # open with the runs it missed still due.
                await skip_missed_runs(bound, RoomScheduleStore(), now)
            await record_audit_event(
                bound,
                tenant_id=workspace_id,
                actor_user_id=user.id,
                action=(
                    AuditAction.TENANT_ARCHIVED
                    if archived
                    else AuditAction.TENANT_RESTORED
                ),
                target_type="tenant",
                target_id=workspace_id,
                details={},
            )
            await record_organization_audit_event(
                bound,
                organization_id=acting.access.organization_id,
                actor_user_id=user.id,
                action=(
                    OrganizationAuditAction.WORKSPACE_ARCHIVED
                    if archived
                    else OrganizationAuditAction.WORKSPACE_RESTORED
                ),
                target_type="workspace",
                target_id=workspace_id,
                details={"name": tenant.name, **acting.made_from},
            )
        response = WorkspaceArchiveResponse(
            id=tenant.id, name=tenant.name, archived_at=archived_since(tenant)
        )
        await bound.commit()
    return response


@router.post(f"{WORKSPACE}/archive")
async def archive_organization_workspace(
    workspace_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> WorkspaceArchiveResponse:
    """Archive one of the organization's workspaces: closed, with nothing in
    it deleted, until it is restored (`workspace_archive.py`). Not the
    workspace this request is bound to, which the caller would be shut in,
    nor the one everyone signing up joins.

    What archiving shuts is shut once it has committed, here and in every
    other process; asked again of a workspace already archived, that is done
    again, so a call that failed part way is finished by repeating it."""
    blocked = archive_blocked_reason(workspace_id, require_tenant_id())
    acting = await _org_admin(session, user_store, organization_store, user)
    if blocked is not None:
        raise HTTPException(status_code=409, detail=blocked)
    response = await _set_archived(session_factory, acting, workspace_id, archived=True)
    await request.app.state.workspace_archive.closed(workspace_id)
    logger.info("User %s archived workspace %s", user.id, workspace_id)
    return response


@router.post(f"{WORKSPACE}/restore")
async def restore_organization_workspace(
    workspace_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> WorkspaceArchiveResponse:
    """Restore one of the organization's archived workspaces: its members may
    enter it again, its agents connect, its bridges and its devices' agents
    start, and its schedules go on from their next run, the runs missed
    meanwhile skipped in the same commit. As archiving, done again when
    repeated."""
    acting = await _org_admin(session, user_store, organization_store, user)
    response = await _set_archived(
        session_factory, acting, workspace_id, archived=False
    )
    await request.app.state.workspace_archive.reopened(workspace_id)
    logger.info("User %s restored workspace %s", user.id, workspace_id)
    return response
