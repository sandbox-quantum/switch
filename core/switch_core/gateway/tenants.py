from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.workspace_deletion import (
    WorkspaceDeletionRefused,
    delete_workspace,
)
from switch_core.authz import (
    ORGANIZATION_ADMIN_ROLE,
    ORGANIZATION_ADMIN_TENANT_ROLE,
    admin_by_own_membership,
    administers_tenant,
    can_change_workspace_member,
    can_delete_workspace,
    effective_tenant_role,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.registration_bootstrap import is_bootstrap_owner
from switch_core.clients.client_lifecycle_service import (
    ClientLifecycleService,
)
from switch_core.config import SwitchConfig
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.db.audit import (
    AuditAction,
    list_audit_events,
    record_audit_event,
)
from switch_core.db.models import (
    MAX_MESSAGE_RETENTION_DAYS,
    TENANT_ZERO_ID,
    AuditEvent,
    Invitation,
    Organization,
    OrganizationMember,
    PersonErasure,
    Tenant,
    TenantJoinDomain,
    TenantMember,
    UsageBudget,
    UsageMetric,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.budget_store import (
    BudgetNotFound,
    BudgetStanding,
    BudgetStore,
    bump_hosted_controllers,
)
from switch_core.db.stores.erasure_store import (
    ErasureAlreadyQueued,
    ErasureStore,
    UnknownIdentity,
)
from switch_core.db.stores.invitation_store import (
    InvitationNotUsableError,
    InvitationStore,
)
from switch_core.db.stores.join_domain_store import (
    JoinDomainAlreadyAdded,
    JoinDomainNotFound,
    JoinDomainStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.retention_store import RetentionStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    AuthenticatedSession,
    all_workspaces,
    get_authenticated_caller,
    get_authenticated_session,
    get_authenticated_user_id,
    get_current_user,
    get_tenant_is_admin,
    initial_tenant_claim,
    list_tenant_memberships,
    may_bind_tenant,
    rebind_if_left,
    record_operator_entry,
    require_tenant_admin,
    session_auth_time,
    set_session_cookie,
    tenant_of_invitation_token,
    tenants_bindable_by,
    tenants_open_to,
    tenants_with_invitations_for,
)
from switch_core.gateway.auth_routes import _session_response
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_agent_store,
    get_api_key_store,
    get_budget_store,
    get_client_lifecycle,
    get_config,
    get_erasure_store,
    get_invitation_store,
    get_invite_mailer,
    get_join_domain_store,
    get_organization_directory,
    get_organization_store,
    get_protocol,
    get_retention_store,
    get_session,
    get_session_factory,
    get_system_session,
    get_usage_store,
    get_user_store,
)
from switch_core.gateway.email_domains import email_domain, join_domain_refusal
from switch_core.gateway.invite_mail import (
    InviteEmail,
    InviteEmailFailed,
    InviteMailer,
    invite_link,
)
from switch_core.gateway.schemas import (
    AddressedInvitation,
    AddressedInvitationAcceptRequest,
    AuditEventDetail,
    BudgetCreateRequest,
    BudgetResponse,
    BudgetUpdateRequest,
    ClaimantDetail,
    CurrentTenantResponse,
    ErasureCreateRequest,
    ErasureDetail,
    InvitationAcceptRequest,
    InvitationCreateRequest,
    InvitationCreateResponse,
    InvitationDetail,
    JoinableTenant,
    JoinDomainCreateRequest,
    JoinDomainDetail,
    JoinDomainsResponse,
    MemberDetail,
    MemberUpdateRequest,
    NamedAuditEventDetail,
    OperatorWorkspaceResponse,
    PersonDetail,
    RetentionPolicyRequest,
    RetentionPolicyResponse,
    RetentionPreviewResponse,
    SessionUserResponse,
    TenantCreateRequest,
    TenantDeleteRequest,
    TenantMembershipResponse,
    UsageTotalResponse,
    WorkspaceCountsResponse,
    daily_cap_problem,
)
from switch_core.gateway.service_connections import service_refusal
from switch_core.gateway.workspace_creation import (
    NOTHING_CHANGED,
    create_organization_for,
    directory_failed,
)
from switch_core.hosted_v2 import process_hosted_v2
from switch_core.organization_access import (
    AccessRevocation,
    removal_heir,
    remove_membership,
)
from switch_core.organization_directory import DirectoryError, OrganizationDirectory
from switch_core.telemetry import emit_safely
from switch_core.telemetry.ages import age_hours
from switch_core.tenant_context import current_tenant_id
from switch_core.visibility.activity_names import member_names, names_for
from switch_core.visibility.keyed_id import KeyedIdKey

logger = logging.getLogger(__name__)


router = APIRouter()

TENANT_MEMBER_ROLES = ("admin", "member")


def _member_role(role: str) -> str:
    """`role` as this server stores it. `owner` was a role of its own until it
    merged into `admin`; a client from before the merge may still ask for it,
    and gets the role that now carries everything it did."""
    if role == "owner":
        return "admin"
    if role not in TENANT_MEMBER_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {role}")
    return role


def _require_bound_tenant(tenant_id: str) -> None:
    """Raise 403 unless `tenant_id` names the tenant this request is bound to.

    Every write below this point uses the bound session, which writes into
    the caller's *bound* tenant regardless of what a path segment says —
    `TenantScoped.tenant_id` defaults to `require_tenant_id()`, not to
    anything an endpoint parses. Without this check, a member of workspace A
    naming workspace B in the path would not fail; it would silently act on A
    instead, which is the one thing the error-handling philosophy this
    codebase follows refuses to do.
    """
    if current_tenant_id() != tenant_id:
        raise HTTPException(status_code=403, detail="Not allowed in this workspace")


def _invitation_fields(invitation: Invitation) -> dict[str, object]:
    return {
        "id": invitation.id,
        "role": invitation.role,
        "email": invitation.email,
        "expires_at": str(invitation.expires_at),
        "uses_remaining": invitation.uses_remaining,
        "revoked_at": str(invitation.revoked_at) if invitation.revoked_at else None,
        "created_by": invitation.created_by,
        "created_at": str(invitation.created_at),
    }


def _invitation_detail(invitation: Invitation) -> InvitationDetail:
    return InvitationDetail(**_invitation_fields(invitation))


def _member_detail(
    user: User,
    membership: TenantMember,
    organization_role: str | None,
    *,
    caller_id: str,
    administers: bool,
) -> MemberDetail:
    may_change = can_change_workspace_member(
        administers=administers,
        member_is_organization_admin=organization_role == ORGANIZATION_ADMIN_ROLE,
    )
    return MemberDetail(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=membership.role,
        created_at=str(membership.created_at),
        service_account=is_bootstrap_owner(user),
        organization_role=organization_role,
        via_organization=False,
        can_change_role=may_change,
        can_remove=may_change,
        can_receive_transfer=user.id != caller_id,
    )


async def _refuse_organization_admin(
    session: AsyncSession, user_store: UserStore, tenant_id: str, user_id: str
) -> None:
    """Raise 409 if `user_id` is `org_admin` of the bound tenant's organization.

    Their standing here comes from the organization, not from their membership
    row, so changing or removing the row here would take nothing away while
    looking as if it had. It is changed in the organization's own members.
    """
    if (
        await user_store.organization_role(session, tenant_id, user_id)
        == ORGANIZATION_ADMIN_ROLE
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "This user administers the workspace's organization, which "
                "gives them admin rights in every one of its workspaces. Change "
                "their role in the organization's users first."
            ),
        )


def _require_invitation_usable(invitation: Invitation, caller_email: str) -> None:
    """Raise 403 unless `invitation` may still be accepted by `caller_email`.

    Checked in this order, but every branch is independent: revocation,
    expiry, remaining uses and an addressed email are four separate ways an
    invitation stops working, none of them optional
    (`docs/old/multi-tenancy-phase2-tenants.md`, §5).

    This is for the message, not for the decision. Three of the four gates are
    re-checked inside `InvitationStore.consume`'s own `UPDATE`, which is what
    actually settles a race between two acceptances; read here, they can only
    say why an invitation that is already unusable is unusable, in words the
    invitee can act on. The fourth — the addressed email — is the one gate
    only this function applies, because the store has no idea who is asking.
    """
    if invitation.revoked_at is not None:
        raise HTTPException(status_code=403, detail="This invitation has been revoked")
    if invitation.expires_at < datetime.now(UTC):
        raise HTTPException(status_code=403, detail="This invitation has expired")
    if invitation.uses_remaining <= 0:
        raise HTTPException(
            status_code=403, detail="This invitation has already been used"
        )
    if (
        invitation.email is not None
        and invitation.email.lower() != caller_email.lower()
    ):
        raise HTTPException(
            status_code=403,
            detail="This invitation is addressed to a different email",
        )


@router.get("/tenants")
async def list_tenants(
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> list[TenantMembershipResponse]:
    """The caller's own tenants: id, slug, name, and their role in each.

    Authenticated with `get_authenticated_user_id`, not `get_current_user`:
    the caller may belong to several tenants and have none selected on their
    session, which is exactly the state `get_current_user` cannot resolve
    without this list existing first (`docs/old/multi-tenancy-phase2-tenants.md`,
    §7). This route never holds a bound request session open while it reads
    the others — see `list_tenant_memberships`.
    """
    return await list_tenant_memberships(session_factory, user_store, user_id)


@router.get("/tenants/counts")
async def workspace_counts(
    auth: Annotated[AuthenticatedSession, Depends(get_authenticated_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
) -> list[WorkspaceCountsResponse]:
    """How many people and agents each workspace the caller may enter has:
    those of `GET /tenants`, and the one the platform operator entered on the
    operator flag alone, which their session is in without being one of them.

    For the dashboard's workspace switcher, which asks when it opens rather
    than on every page: each workspace is read on its own short session, as
    `GET /tenants` reads them, so this costs as much again.
    """
    tenant_ids = await tenants_bindable_by(session_factory, auth.user_id)
    claim = auth.tenant_claim
    if (
        claim is not None
        and claim not in tenant_ids
        and await may_bind_tenant(session_factory, user_store, auth.user_id, claim)
    ):
        tenant_ids.append(claim)
    counts: list[WorkspaceCountsResponse] = []
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            if tenant is None:
                logger.warning(
                    "User %s may enter workspace %s, but it was gone by the "
                    "time its counts were read",
                    auth.user_id,
                    tenant_id,
                )
                continue
            counts.append(
                WorkspaceCountsResponse(
                    id=tenant_id,
                    users=await user_store.count_people(session, tenant),
                    agents=await agent_store.count(session),
                )
            )
    return counts


@router.get("/tenants/current")
async def current_tenant(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> CurrentTenantResponse:
    """The tenant this request is bound to, and the caller's standing in it.

    A client needs the id for every `/tenants/{tenant_id}/...` path, and the
    binding is settled server-side (see `_resolve_tenant_id`), so this is the
    one place it can ask rather than guess from `GET /tenants`. The two roles
    are read once each, and every answer below is worked out from them.
    """
    tenant_id = require_tenant_id()
    tenant = await session.get(Tenant, tenant_id)
    tenant_role = await user_store.tenant_role(session, tenant_id, user.id)
    organization_role = await user_store.organization_role(session, tenant_id, user.id)
    role = effective_tenant_role(
        tenant_role=tenant_role, organization_role=organization_role
    )
    if role is None and request.state.platform_access:
        # The platform operator, there on the operator flag alone, acts as
        # an admin and holds no role to report.
        role = ORGANIZATION_ADMIN_TENANT_ROLE
    if tenant is None or role is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return CurrentTenantResponse(
        id=tenant.id,
        slug=tenant.slug,
        name=tenant.name,
        role=role,
        organization_role=organization_role,
        organization_id=tenant.organization_id,
        administers=administers_tenant(
            is_operator=user.role == "admin",
            tenant_role=tenant_role,
            organization_role=organization_role,
        ),
        can_delete=can_delete_workspace(
            tenant_role=tenant_role, is_default=tenant.id == TENANT_ZERO_ID
        ),
        can_manage_data_protection=admin_by_own_membership(tenant_role),
    )


@router.post("/tenants", status_code=201, deprecated=True)
async def create_tenant(
    req: TenantCreateRequest,
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
) -> TenantMembershipResponse:
    """`POST /organizations` under its old name, kept for one release for
    clients that still call it: an organization and its first workspace, both
    named `name`, with the caller switched into the workspace. Answers with the
    workspace alone, as it always has.
    """
    created = await create_organization_for(
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
        workspace_name=req.name,
        auth_time=session_auth_time(request),
    )
    return created.workspace


@router.delete("/tenants/{tenant_id}")
async def delete_tenant(
    tenant_id: str,
    req: TenantDeleteRequest,
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Delete the bound workspace, once it has been emptied.

    Its admins only, by their own admin membership: not the deployment
    operator's bypass, and not an organization admin acting as one, since
    deleting a workspace is the one act that cannot be undone by anyone. The
    caller confirms by typing its name.
    A workspace that still holds anything is refused, 409, with what is left
    by kind and count (`accounts/workspace_deletion.py`). The session cookie
    is re-minted without it, onto the caller's only other workspace if there
    is exactly one.
    """
    _require_bound_tenant(tenant_id)
    if not admin_by_own_membership(
        await user_store.tenant_role(session, tenant_id, user.id)
    ):
        raise HTTPException(
            status_code=403, detail="Only a workspace admin may delete the workspace"
        )
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        # Deleted by a request that got here first.
        raise HTTPException(status_code=404, detail="That workspace doesn't exist.")
    if req.name.strip() != tenant.name:
        raise HTTPException(
            status_code=400, detail="That name doesn't match this workspace."
        )
    try:
        key_hashes = await delete_workspace(session, tenant_id, user.id, user.id)
    except WorkspaceDeletionRefused as refused:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(refused)) from None
    await session.commit()
    logger.info("Admin %s deleted workspace %s", user.id, tenant_id)

    for key_hash in key_hashes:
        protocol.api_key_cache.invalidate(key_hash)
    # The clients the server ran for it stop here, and everywhere else on the
    # announcement.
    await client_lifecycle.reconcile_tenant(tenant_id)
    client_lifecycle.announce(tenant_id)

    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        await initial_tenant_claim(session_factory, user_store, user),
        session_auth_time(request),
    )
    return {"ok": True}


@router.post("/tenants/{tenant_id}/switch")
async def switch_tenant(
    tenant_id: str,
    request: Request,
    response: Response,
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> SessionUserResponse:
    """Select `tenant_id` for this session: verify the caller may bind it,
    then re-mint the cookie carrying it as the tenant claim.

    The check is what keeps the claim from being a way in on its own:
    `_resolve_tenant_id` re-checks it on every request regardless of what the
    cookie says, so a forged or stale claim already buys nothing — but this
    route is the one place a *caller* picks the value that goes into it, and
    it must not let them pick a tenant they may not bind: one they are a
    member of, one their organization's `org_admin` role covers, or, for the
    platform operator, any.

    The platform operator entering a workspace on the operator flag alone is
    recorded in that workspace's audit log. Signing in never selects such a
    workspace (`initial_tenant_claim`), so every visit starts here.
    """
    if not await may_bind_tenant(session_factory, user_store, user_id, tenant_id):
        raise HTTPException(status_code=403, detail="Not a member of this workspace")

    user = await user_store.get(session, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    if user.role == "admin":
        await record_operator_entry(session_factory, user_store, user_id, tenant_id)

    await user_store.record_last_tenant(session, user, tenant_id)
    await session.commit()
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        tenant_id,
        session_auth_time(request),
    )
    return _session_response(user)


@router.get("/operator/workspaces")
async def list_every_workspace(
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
) -> list[OperatorWorkspaceResponse]:
    """Every workspace on the server, for the platform operator to enter one
    with `POST /tenants/{id}/switch`. Kept apart from `GET /tenants`, which
    stays the caller's own, so the ordinary picker never lists customers'
    workspaces. Listing records nothing; entering does."""
    if not caller.is_operator:
        raise HTTPException(status_code=403, detail="Admin access required")
    return [
        OperatorWorkspaceResponse(
            id=tenant.id,
            slug=tenant.slug,
            name=tenant.name,
            organization_id=tenant.organization_id,
            organization_name=organization.name if organization is not None else None,
        )
        for tenant, organization in await all_workspaces(session_factory)
    ]


# ── Invitations ───────────────────────────────────────────────────────────────


@router.post("/tenants/{tenant_id}/invitations", status_code=201)
async def create_invitation(
    tenant_id: str,
    req: InvitationCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    mailer: Annotated[InviteMailer | None, Depends(get_invite_mailer)],
) -> InvitationCreateResponse:
    """Mint an invitation to the bound tenant. Admins only.

    An invitation naming an e-mail is also sent there when a relay is
    configured. The e-mail is a convenience on top of the link, not a
    condition of the invitation: when it cannot go out the invitation still
    stands, and `email_delivery` tells the admin to share the link instead.
    """
    _require_bound_tenant(tenant_id)
    role = _member_role(req.role)
    if req.email is not None and mailer is not None and user.role != "admin":
        sent_today = await invitation_store.count_addressed_since(
            session, datetime.now(UTC) - timedelta(days=1)
        )
        if sent_today >= config.gateway_invite_emails_per_day:
            await session.commit()
            raise HTTPException(
                status_code=429,
                detail=(
                    "This workspace has sent its daily limit of "
                    f"{config.gateway_invite_emails_per_day} invitation e-mails; "
                    "try again tomorrow, or create an invitation without an "
                    "e-mail and share the link"
                ),
            )

    expires_at = datetime.now(UTC) + timedelta(hours=req.expires_in_hours)
    invitation, token = await invitation_store.create(
        session,
        role=role,
        email=req.email,
        expires_at=expires_at,
        uses_remaining=req.uses_remaining,
        created_by=user.id,
    )
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.INVITATION_CREATED,
        target_type="invitation",
        target_id=invitation.id,
        details={
            "role": invitation.role,
            "email": invitation.email,
            "uses_remaining": invitation.uses_remaining,
        },
    )
    tenant = await session.get(Tenant, tenant_id)
    assert tenant is not None
    await session.commit()

    delivery = await _deliver_invitation(
        mailer,
        config,
        invitation,
        token,
        workspace_name=tenant.name,
        inviter_name=user.name,
    )
    emit_safely(current_telemetry(), "invitation_sent", {"delivery": delivery})
    return InvitationCreateResponse(
        token=token, email_delivery=delivery, **_invitation_fields(invitation)
    )


async def _deliver_invitation(
    mailer: InviteMailer | None,
    config: SwitchConfig,
    invitation: Invitation,
    token: str,
    *,
    workspace_name: str,
    inviter_name: str,
) -> Literal["sent", "not_configured", "failed", "not_requested"]:
    if invitation.email is None:
        return "not_requested"
    if mailer is None:
        logger.warning(
            "Invitation %s to tenant %s names an e-mail, but no SMTP relay is "
            "configured (GATEWAY_SMTP_HOST); nothing was sent",
            invitation.id,
            invitation.tenant_id,
        )
        return "not_configured"
    assert config.dashboard_base_url is not None
    try:
        await mailer.send_invitation(
            InviteEmail(
                to=invitation.email,
                link=invite_link(config.dashboard_base_url, token),
                workspace_name=workspace_name,
                inviter_name=inviter_name,
                role=invitation.role,
                expires_at=invitation.expires_at,
            )
        )
    except InviteEmailFailed:
        logger.exception(
            "Invitation %s to tenant %s was created but its e-mail was not sent",
            invitation.id,
            invitation.tenant_id,
        )
        return "failed"
    return "sent"


@router.get("/tenants/{tenant_id}/usage")
async def get_usage(
    tenant_id: str,
    since: Annotated[datetime, Query()],
    until: Annotated[datetime, Query()],
    session: Annotated[AsyncSession, Depends(get_session)],
    usage_store: Annotated[UsageStore, Depends(get_usage_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> list[UsageTotalResponse]:
    """The bound tenant's usage per metric, consumer and model over `[since, until)`.

    Admins only. Usage is counted in whole UTC hours, so `since` is
    widened to the start of its hour. Both bounds must carry a timezone: a
    naive time would be read in the server's zone and quietly shift the window.
    """
    _require_bound_tenant(tenant_id)
    if since.tzinfo is None or until.tzinfo is None:
        raise HTTPException(
            status_code=400, detail="since and until must include a timezone offset"
        )
    if since >= until:
        raise HTTPException(status_code=400, detail="since must be before until")
    totals = await usage_store.totals(
        session, tenant_id=tenant_id, since=since, until=until
    )
    return [
        UsageTotalResponse(
            metric=t.metric,
            client_id=t.client_id,
            client_name=t.client_name,
            client_type=t.client_type,
            model=t.model,
            amount=t.amount,
        )
        for t in totals
    ]


def _budget_response(standing: BudgetStanding) -> BudgetResponse:
    return BudgetResponse(
        id=standing.id,
        agent_id=standing.agent_id,
        agent_name=standing.agent_name,
        metric=standing.metric,
        model=standing.model,
        amount_limit=standing.amount_limit,
        period_hours=standing.period_hours,
        spent=standing.spent,
        resets_at=standing.resets_at,
        exhausted=standing.exhausted,
    )


async def _budget_standing(
    session: AsyncSession, budget_store: BudgetStore, tenant_id: str, budget_id: str
) -> BudgetResponse:
    for standing in await budget_store.standings(
        session, tenant_id=tenant_id, agent_id=None
    ):
        if standing.id == budget_id:
            return _budget_response(standing)
    raise HTTPException(status_code=404, detail="Budget not found")


def _budget_terms(budget: UsageBudget) -> dict:
    """What a budget covers and allows, for its audit entry: ids, a fixed
    metric, numbers and the model name, never anything a person typed."""
    return {
        "metric": budget.metric,
        "model": budget.model,
        "agent_id": budget.agent_id,
        "amount_limit": budget.amount_limit,
        "period_hours": budget.period_hours,
    }


async def _audit_budget(
    session: AsyncSession,
    *,
    tenant_id: str,
    actor_id: str,
    action: AuditAction,
    budget_id: str,
    details: dict,
) -> None:
    """Every budget change is recorded in the workspace's Activity, in the
    change's own transaction, so a change that doesn't
    commit leaves no entry and one that does always has one. With hosted
    agents v2 off, none, as before v2."""
    if not process_hosted_v2():
        return
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=actor_id,
        action=action,
        target_type="budget",
        target_id=budget_id,
        details=details,
    )


def _nudge_controllers(
    request: Request, tenant_id: str, revisions: dict[str, int]
) -> None:
    """After the commit: tell the workspace's hosted controllers their
    assignment changed (the daily cap). The wiring in `switch_core.main`
    hands the gateway this hook, so this module needn't import management."""
    nudge = getattr(request.app.state, "assignment_nudge", None)
    if nudge is None:
        return
    for controller_id, revision in revisions.items():
        nudge(tenant_id, controller_id, revision)


async def _daily_cap_changed(
    session: AsyncSession, tenant_id: str, metric: str
) -> dict[str, int]:
    """Bump the workspace's hosted controllers when the daily AI cap changes.
    With hosted agents v2 off, none, as before v2."""
    if not process_hosted_v2() or metric != UsageMetric.HOSTED_AI_CALLS.value:
        return {}
    return await bump_hosted_controllers(session, tenant_id)


async def _budget_row(
    session: AsyncSession, tenant_id: str, budget_id: str
) -> UsageBudget | None:
    budget: UsageBudget | None = await session.scalar(
        select(UsageBudget).where(
            UsageBudget.tenant_id == tenant_id, UsageBudget.id == budget_id
        )
    )
    return budget


@router.get("/tenants/{tenant_id}/budgets")
async def list_budgets(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    budget_store: Annotated[BudgetStore, Depends(get_budget_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> list[BudgetResponse]:
    """Every budget of the bound tenant with its spend in the current period.
    Admins only."""
    _require_bound_tenant(tenant_id)
    standings = await budget_store.standings(
        session, tenant_id=tenant_id, agent_id=None
    )
    return [_budget_response(s) for s in standings]


@router.post("/tenants/{tenant_id}/budgets", status_code=201)
async def create_budget(
    tenant_id: str,
    body: BudgetCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    budget_store: Annotated[BudgetStore, Depends(get_budget_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(require_tenant_admin)],
    request: Request,
) -> BudgetResponse:
    """Add a budget to the bound tenant. Admins only.

    404 when `agent_id` names no agent in this workspace; 409 when the same
    agent (or the whole workspace), metric and model already has one — edit
    that one instead.
    """
    _require_bound_tenant(tenant_id)
    if (
        body.metric is UsageMetric.AWAKE_MINUTES
        and not config.hosted_awake_budgets_enabled
    ):
        # Off until every hosted box is split (`hosted_awake_budgets`).
        raise HTTPException(
            status_code=422,
            detail="Awake-time budgets aren't available on this server yet",
        )
    if body.agent_id is not None:
        agent = await agent_store.get(session, body.agent_id)
        if agent is None or agent.tenant_id != tenant_id:
            raise HTTPException(status_code=404, detail="Agent not found")
    try:
        budget = await budget_store.create(
            session,
            tenant_id=tenant_id,
            agent_id=body.agent_id,
            metric=body.metric,
            model=body.model,
            amount_limit=body.amount_limit,
            period_hours=body.period_hours,
        )
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="A budget for this agent, metric and model already exists",
        ) from exc
    await _audit_budget(
        session,
        tenant_id=tenant_id,
        actor_id=user.id,
        action=AuditAction.BUDGET_CREATED,
        budget_id=budget.id,
        details={"after": _budget_terms(budget)},
    )
    revisions = await _daily_cap_changed(session, tenant_id, budget.metric)
    await session.commit()
    _nudge_controllers(request, tenant_id, revisions)
    return await _budget_standing(session, budget_store, tenant_id, budget.id)


@router.put("/tenants/{tenant_id}/budgets/{budget_id}")
async def update_budget(
    tenant_id: str,
    budget_id: str,
    body: BudgetUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    budget_store: Annotated[BudgetStore, Depends(get_budget_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    request: Request,
) -> BudgetResponse:
    """Change a budget's limit and period. Admins only. What it
    covers is fixed; to cover something else, add another budget."""
    _require_bound_tenant(tenant_id)
    # Only v2 needs the row before the change (its audit entry, the daily cap
    # and the nudge); with v2 off, no extra read, as before v2.
    before = (
        await _budget_row(session, tenant_id, budget_id)
        if process_hosted_v2()
        else None
    )
    before_terms = None if before is None else _budget_terms(before)
    if before is not None and before.metric == UsageMetric.HOSTED_AI_CALLS.value:
        # The daily AI cap stays daily.
        try:
            daily_cap_problem(
                agent_id=None,
                model="",
                amount_limit=body.amount_limit,
                period_hours=body.period_hours,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        updated = await budget_store.update(
            session,
            tenant_id=tenant_id,
            budget_id=budget_id,
            amount_limit=body.amount_limit,
            period_hours=body.period_hours,
        )
    except BudgetNotFound as exc:
        raise HTTPException(status_code=404, detail="Budget not found") from exc
    await _audit_budget(
        session,
        tenant_id=tenant_id,
        actor_id=user.id,
        action=AuditAction.BUDGET_UPDATED,
        budget_id=budget_id,
        details={"before": before_terms, "after": _budget_terms(updated)},
    )
    revisions = await _daily_cap_changed(session, tenant_id, updated.metric)
    await session.commit()
    _nudge_controllers(request, tenant_id, revisions)
    return await _budget_standing(session, budget_store, tenant_id, budget_id)


@router.delete("/tenants/{tenant_id}/budgets/{budget_id}", status_code=204)
async def delete_budget(
    tenant_id: str,
    budget_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    budget_store: Annotated[BudgetStore, Depends(get_budget_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    request: Request,
) -> Response:
    """Remove a budget. Admins only."""
    _require_bound_tenant(tenant_id)
    # Only v2 needs the row before the change (its audit entry, the daily cap
    # and the nudge); with v2 off, no extra read, as before v2.
    before = (
        await _budget_row(session, tenant_id, budget_id)
        if process_hosted_v2()
        else None
    )
    before_terms = None if before is None else _budget_terms(before)
    try:
        await budget_store.delete(session, tenant_id=tenant_id, budget_id=budget_id)
    except BudgetNotFound as exc:
        raise HTTPException(status_code=404, detail="Budget not found") from exc
    await _audit_budget(
        session,
        tenant_id=tenant_id,
        actor_id=user.id,
        action=AuditAction.BUDGET_DELETED,
        budget_id=budget_id,
        details={"before": before_terms},
    )
    revisions = (
        {}
        if before is None
        else await _daily_cap_changed(session, tenant_id, before.metric)
    )
    await session.commit()
    _nudge_controllers(request, tenant_id, revisions)
    return Response(status_code=204)


def _retention_response(
    days: int | None, updated_at: datetime | None, updated_by: str | None
) -> RetentionPolicyResponse:
    return RetentionPolicyResponse(
        message_retention_days=days,
        updated_at=updated_at,
        updated_by_user_id=updated_by,
    )


@router.get("/tenants/{tenant_id}/retention")
async def get_retention_policy(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    retention_store: Annotated[RetentionStore, Depends(get_retention_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> RetentionPolicyResponse:
    """How long the bound tenant keeps room messages. Admins only."""
    _require_bound_tenant(tenant_id)
    policy = await retention_store.get_policy(session)
    if policy is None:
        return _retention_response(None, None, None)
    return _retention_response(
        policy.message_retention_days, policy.updated_at, policy.updated_by_user_id
    )


@router.get("/tenants/{tenant_id}/retention/preview")
async def preview_retention_policy(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    retention_store: Annotated[RetentionStore, Depends(get_retention_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
    days: Annotated[int, Query(ge=1, le=MAX_MESSAGE_RETENTION_DAYS)],
) -> RetentionPreviewResponse:
    """How many messages a window of `days` would delete if it applied now,
    so the change can be confirmed before it is made. Admins only."""
    _require_bound_tenant(tenant_id)
    count = await retention_store.count_messages_before(
        session, datetime.now(UTC) - timedelta(days=days)
    )
    return RetentionPreviewResponse(
        message_retention_days=days, messages_to_delete=count
    )


@router.put("/tenants/{tenant_id}/retention")
async def set_retention_policy(
    tenant_id: str,
    body: RetentionPolicyRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    retention_store: Annotated[RetentionStore, Depends(get_retention_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> RetentionPolicyResponse:
    """Delete the bound tenant's room messages once they are older than
    `message_retention_days`. Admins only, by their own admin membership:
    the messages it deletes cannot be brought back.

    Takes effect at the next hourly retention pass, not in this request.
    """
    _require_bound_tenant(tenant_id)
    await _require_admin_membership(
        session, user_store, tenant_id, user, "set when messages are deleted"
    )
    previous = await retention_store.get_policy(session)
    previous_days = None if previous is None else previous.message_retention_days
    policy = await retention_store.set_policy(
        session, message_retention_days=body.message_retention_days, user_id=user.id
    )
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.RETENTION_POLICY_SET,
        target_type="tenant",
        target_id=tenant_id,
        details={
            "message_retention_days": body.message_retention_days,
            "previous_message_retention_days": previous_days,
        },
    )
    await session.commit()
    return _retention_response(
        policy.message_retention_days, policy.updated_at, policy.updated_by_user_id
    )


@router.delete("/tenants/{tenant_id}/retention")
async def clear_retention_policy(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    retention_store: Annotated[RetentionStore, Depends(get_retention_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
) -> RetentionPolicyResponse:
    """Keep the bound tenant's messages forever. Admins only.

    Messages already deleted stay deleted. Clearing a policy that is not set
    succeeds and records nothing.
    """
    _require_bound_tenant(tenant_id)
    previous = await retention_store.get_policy(session)
    if previous is not None:
        previous_days = previous.message_retention_days
        await retention_store.clear_policy(session)
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=user.id,
            action=AuditAction.RETENTION_POLICY_CLEARED,
            target_type="tenant",
            target_id=tenant_id,
            details={"previous_message_retention_days": previous_days},
        )
        await session.commit()
    return _retention_response(None, None, None)


#: The `platform` a person taking part from Switch Console is listed under.
SWITCH_CONSOLE_PLATFORM = "switch"


def _erasure_detail(erasure: PersonErasure) -> ErasureDetail:
    return ErasureDetail(
        id=erasure.id,
        state=erasure.state,  # type: ignore[arg-type]
        identities=len(erasure.external_user_ids)
        + len(erasure.former_sender_ids)
        + len(erasure.member_client_ids),
        identities_erased=erasure.identities_erased,
        messages_deleted=erasure.messages_deleted,
        files_deleted=erasure.files_deleted,
        error=erasure.error,
        requested_by_user_id=erasure.requested_by_user_id,
        created_at=erasure.created_at,
        completed_at=erasure.completed_at,
    )


async def _require_admin_membership(
    session: AsyncSession,
    user_store: UserStore,
    tenant_id: str,
    user: User,
    action: str,
) -> None:
    """What cannot be undone, erasing a person or setting messages to be
    deleted, takes, like deleting the workspace, the caller's own admin
    membership: not the deployment operator's bypass, and not an organization
    admin acting as one. `action` completes "Only a workspace admin may"."""
    if not admin_by_own_membership(
        await user_store.tenant_role(session, tenant_id, user.id)
    ):
        raise HTTPException(
            status_code=403, detail=f"Only a workspace admin may {action}"
        )


@router.get("/tenants/{tenant_id}/people")
async def list_people(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    erasure_store: Annotated[ErasureStore, Depends(get_erasure_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> list[PersonDetail]:
    """Everyone seen in the bound tenant's rooms: through a chat app, with how
    many messages each sent and which members claim them, including former
    participants from apps since disconnected, and from Switch Console,
    including deleted accounts. Admins only, by their own admin membership:
    this is the list a person is erased from."""
    _require_bound_tenant(tenant_id)
    await _require_admin_membership(
        session, user_store, tenant_id, user, "erase people"
    )
    people = [
        PersonDetail(
            id=person.external_user_id,
            kind="identity",
            username=person.username,
            platform=person.platform,
            bridge_name=person.bridge_name,
            message_count=person.message_count,
            claimed_by=[
                ClaimantDetail(user_id=c.user_id, name=c.name)
                for c in person.claimed_by
            ],
        )
        for person in await erasure_store.list_people(session)
    ]
    people += [
        PersonDetail(
            id=former.sender_id,
            kind="former",
            username=", ".join(former.names) or former.sender_id,
            platform=former.platform,
            bridge_name=None,
            message_count=former.message_count,
            claimed_by=[],
        )
        for former in await erasure_store.list_former_participants(session)
    ]
    people += [
        PersonDetail(
            id=member.client_id,
            kind="member",
            username=member.name,
            platform=SWITCH_CONSOLE_PLATFORM,
            bridge_name=None,
            message_count=member.message_count,
            claimed_by=[],
        )
        for member in await erasure_store.list_members(session)
    ]
    return sorted(people, key=lambda p: (p.username.lower(), p.id))


@router.get("/tenants/{tenant_id}/erasures")
async def list_erasures(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    erasure_store: Annotated[ErasureStore, Depends(get_erasure_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> list[ErasureDetail]:
    """The bound tenant's erasure requests, newest first. Admins only, by
    their own admin membership."""
    _require_bound_tenant(tenant_id)
    await _require_admin_membership(
        session, user_store, tenant_id, user, "erase people"
    )
    return [
        _erasure_detail(e) for e in await erasure_store.list_erasures(session, limit=50)
    ]


@router.post("/tenants/{tenant_id}/erasures", status_code=202)
async def create_erasure(
    tenant_id: str,
    body: ErasureCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    erasure_store: Annotated[ErasureStore, Depends(get_erasure_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> ErasureDetail:
    """Queue the erasure of one person: every message the named identities
    and member clients sent, their files, and the platform identities
    themselves. Admins only, by their own admin membership.

    Answered once queued; the work runs in the background within seconds and
    `GET .../erasures` reports its progress. 404 names an identity that is not
    in this workspace; 409 means one is already being erased.
    """
    _require_bound_tenant(tenant_id)
    await _require_admin_membership(
        session, user_store, tenant_id, user, "erase people"
    )
    ids = list(dict.fromkeys(body.external_user_ids))
    former_ids = list(dict.fromkeys(body.former_sender_ids))
    member_ids = list(dict.fromkeys(body.member_client_ids))
    try:
        erasure = await erasure_store.queue(
            session,
            external_user_ids=ids,
            former_sender_ids=former_ids,
            member_client_ids=member_ids,
            requested_by_user_id=user.id,
        )
    except UnknownIdentity as exc:
        raise HTTPException(
            status_code=404, detail="Person not found in this workspace"
        ) from exc
    except ErasureAlreadyQueued as exc:
        raise HTTPException(
            status_code=409, detail="This person is already being erased"
        ) from exc
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.PERSON_ERASURE_REQUESTED,
        target_type="person_erasure",
        target_id=erasure.id,
        details={
            "external_user_ids": ids,
            "former_participants": len(former_ids),
            "member_client_ids": member_ids,
        },
    )
    await session.commit()
    return _erasure_detail(erasure)


@router.get("/tenants/{tenant_id}/invitations")
async def list_invitations(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> list[InvitationDetail]:
    """Every invitation of the bound tenant. Admins only."""
    _require_bound_tenant(tenant_id)
    invitations = await invitation_store.list_for_tenant(session)
    return [_invitation_detail(i) for i in invitations]


def _keyed_id_key_or_none(request: Request) -> KeyedIdKey | None:
    key = getattr(request.app.state, "keyed_id_key", None)
    return key if isinstance(key, KeyedIdKey) else None


@router.get("/tenants/{tenant_id}/audit-events", response_model=list[AuditEventDetail])
async def list_tenant_audit_events(
    tenant_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(require_tenant_admin)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: Annotated[datetime | None, Query()] = None,
) -> list[AuditEventDetail] | JSONResponse:
    """The bound tenant's audit log, newest first. Admins only.

    Page back by passing the oldest `occurred_at` returned as `before`.
    """
    _require_bound_tenant(tenant_id)
    events = await list_audit_events(
        session, tenant_id=tenant_id, limit=limit, before=before
    )

    def _entry(event: AuditEvent) -> AuditEventDetail:
        return AuditEventDetail(
            id=event.id,
            occurred_at=event.occurred_at.isoformat(),
            actor_user_id=event.actor_user_id,
            action=event.action,
            target_type=event.target_type,
            target_id=event.target_id,
            details=event.details,
        )

    if not process_hosted_v2():
        # The v1/v2 switch: upstream's entries, with no names looked up or sent.
        return [_entry(event) for event in events]
    # Names for the workspace's own members, whom its admins already see.
    names = names_for(
        events,
        members=await member_names(session, tenant_id),
        key=_keyed_id_key_or_none(request),
    )
    named = [
        NamedAuditEventDetail(
            **_entry(event).model_dump(),
            actor_name=actor_name,
            target_name=target_name,
        )
        for event, (actor_name, target_name) in zip(events, names, strict=True)
    ]
    # Sent as they are: the declared response model is upstream's entry, which
    # would drop the names on the way out. The schema stays upstream's.
    return JSONResponse(jsonable_encoder(named))


@router.delete("/tenants/{tenant_id}/invitations/{invitation_id}")
async def revoke_invitation(
    tenant_id: str,
    invitation_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
) -> InvitationDetail:
    """Revoke an invitation of the bound tenant. Admins only."""
    _require_bound_tenant(tenant_id)
    try:
        invitation = await invitation_store.revoke(session, invitation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvitationNotUsableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.INVITATION_REVOKED,
        target_type="invitation",
        target_id=invitation.id,
        details=None,
    )
    await session.commit()
    return _invitation_detail(invitation)


@router.post("/invitations/accept")
async def accept_invitation(
    req: InvitationAcceptRequest,
    request: Request,
    response: Response,
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> TenantMembershipResponse:
    """Accept an invitation, joining its tenant, and switch the caller's
    session into it — someone who follows an invite link means to be there.

    Authenticated with `get_authenticated_caller`, not `get_current_user`:
    the caller's own session may be bound to a different tenant than the
    invitation names, or to none at all, and inserting a membership for a
    tenant other than the one a session is bound to is refused by the
    policy — rebinding an already-open session raises
    (`TenantBindingDriftError`, `db/tenant_session.py`). So this handler
    resolves the token's tenant through the exempt lookup and does all of its
    own work inside a fresh `tenant_session` bound to exactly that tenant,
    rather than touching the request's session at all
    (`docs/old/multi-tenancy-phase2-tenants.md`, §5).

    The token arrives in the body, not the path: it is a bearer credential,
    and a path segment is written to proxy and access logs, kept in browser
    history, and sent onward in `Referer`.

    A use is spent only when a membership is actually granted. Accepting an
    invitation you already hold is a no-op that returns your existing role —
    a double-clicked shared link must not cost the invite a slot — and the
    `consume` that does spend one is a conditional `UPDATE` that arbitrates
    between simultaneous acceptances, so a single-use link grants exactly one
    membership however many people race for it.
    """
    token_hash = hashlib.sha256(req.token.encode()).hexdigest()
    tenant_id = await tenant_of_invitation_token(session_factory, token_hash)
    if tenant_id is None:
        raise HTTPException(status_code=404, detail="Invitation not found")

    async with tenant_session(session_factory, tenant_id) as session:
        invitation = await invitation_store.get_by_token_hash(session, token_hash)
        if invitation is None:
            raise HTTPException(status_code=404, detail="Invitation not found")
        _require_invitation_usable(invitation, caller.email)

        membership, user = await _join_through(
            session,
            invitation,
            caller,
            user_store,
            invitation_store,
            organization_directory,
        )

    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        tenant_id,
        session_auth_time(request),
    )
    return membership


async def _organization_to_join(
    session: AsyncSession, tenant_id: str, user_id: str
) -> Organization | None:
    """`tenant_id`'s organization, if joining the workspace makes `user_id` a
    new member of it, for the directory to be asked (`_join_in_directory`)."""
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise RuntimeError(f"Workspace {tenant_id} is not visible to this session")
    if tenant.organization_id is None:
        return None
    if await session.get(OrganizationMember, (tenant.organization_id, user_id)):
        return None
    return await session.get(Organization, tenant.organization_id)


async def _join_in_directory(
    organization_directory: OrganizationDirectory,
    organization: Organization | None,
    user_id: str,
) -> None:
    """Ask the directory to make `user_id` a member of `organization`, after
    every write of the join and before its commit (`organization_directory.py`).
    A refusal is answered with its reason, and the join is rolled back."""
    if organization is None:
        return
    try:
        await organization_directory.join(organization, user_id, "member")
    except DirectoryError as error:
        raise directory_failed(error, NOTHING_CHANGED) from None


async def _join_through(
    session: AsyncSession,
    invitation: Invitation,
    caller: AuthenticatedCaller,
    user_store: UserStore,
    invitation_store: InvitationStore,
    organization_directory: OrganizationDirectory,
) -> tuple[TenantMembershipResponse, User]:
    """Make `caller` a member of the invitation's tenant, spending one use,
    select that tenant for them, and commit.

    `session` is bound to the invitation's tenant, and `invitation` has
    already passed `_require_invitation_usable` for this caller. Both ways of
    accepting — with the token, or by id for an invitation addressed to the
    caller — end here, so they grant membership identically.
    """
    tenant_id = invitation.tenant_id
    existing_role = await user_store.tenant_role(session, tenant_id, caller.id)
    if existing_role is None:
        try:
            await invitation_store.consume(session, invitation.id)
        except InvitationNotUsableError as exc:
            raise HTTPException(
                status_code=403, detail="This invitation has already been used"
            ) from exc
        role = invitation.role
        joining = await _organization_to_join(session, tenant_id, caller.id)
        await user_store.add_membership(
            session,
            tenant_id=tenant_id,
            user_id=caller.id,
            role=role,
            organization_role="member",
        )
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=caller.id,
            action=AuditAction.INVITATION_ACCEPTED,
            target_type="invitation",
            target_id=invitation.id,
            details={"role": role},
        )
        # Only on the branch that actually joined someone. A caller who
        # was already a member takes the `else` below and has accepted
        # nothing — reporting it there would count re-clicking a link as
        # onboarding.
        emit_safely(
            current_telemetry(),
            "invitation_accepted",
            {"age_hours": age_hours(invitation.created_at)},
        )
        await _join_in_directory(organization_directory, joining, caller.id)

    return await _enter(session, tenant_id, caller, user_store)


async def _enter(
    session: AsyncSession,
    tenant_id: str,
    caller: AuthenticatedCaller,
    user_store: UserStore,
) -> tuple[TenantMembershipResponse, User]:
    """Select the tenant `session` is bound to for `caller`, and commit.

    The last step of every way of joining a workspace, run once the caller is
    a member of it. Returns the caller's standing there, read before the
    commit expires what the session holds.
    """
    tenant = await session.get(Tenant, tenant_id)
    assert tenant is not None
    role = await user_store.effective_tenant_role(session, tenant_id, caller.id)
    assert role is not None
    membership = TenantMembershipResponse(
        id=tenant.id,
        slug=tenant.slug,
        name=tenant.name,
        role=role,
        organization_role=await user_store.organization_role(
            session, tenant_id, caller.id
        ),
        organization_id=tenant.organization_id,
    )
    # `users` is global, so the caller's row is writable from a session
    # bound to any tenant — this one included.
    user = await user_store.get(session, caller.id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    await user_store.record_last_tenant(session, user, tenant_id)
    await session.commit()
    return membership, user


@router.get("/invitations/mine")
async def list_my_invitations(
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
) -> list[AddressedInvitation]:
    """The live invitations addressed to the caller's own e-mail, in
    workspaces they do not already belong to.

    Authenticated without a tenant, like `accept_invitation`: these are
    invitations to workspaces the caller is not in, so no session they could
    hold is bound to them. `tenants_with_invitations_for` names the tenants;
    each is then read on its own bound session, one after another.

    The address is the caller's, as their account holds it. An account's
    address is either asserted verified by the identity provider or set by
    the operator who created it (`gateway_oidc_require_email_verified`), so
    an invitation addressed to it is theirs to see.
    """
    found: list[AddressedInvitation] = []
    for tenant_id in await tenants_with_invitations_for(session_factory, caller.email):
        async with tenant_session(session_factory, tenant_id) as session:
            if await user_store.tenant_role(session, tenant_id, caller.id) is not None:
                continue
            invitations = await invitation_store.list_live_addressed_to(
                session, tenant_id, caller.email
            )
            if not invitations:
                continue
            tenant = await session.get(Tenant, tenant_id)
            assert tenant is not None
            for invitation in invitations:
                inviter = await user_store.get(session, invitation.created_by)
                assert inviter is not None
                found.append(
                    AddressedInvitation(
                        id=invitation.id,
                        tenant_id=tenant.id,
                        tenant_slug=tenant.slug,
                        tenant_name=tenant.name,
                        role=invitation.role,
                        expires_at=str(invitation.expires_at),
                        invited_by=inviter.name,
                        created_at=str(invitation.created_at),
                    )
                )
    return found


@router.post("/invitations/mine/accept")
async def accept_my_invitation(
    req: AddressedInvitationAcceptRequest,
    request: Request,
    response: Response,
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> TenantMembershipResponse:
    """Accept an invitation addressed to the caller, by id, without its token,
    and switch the caller's session into its workspace.

    Only for an invitation that names the caller's address: that address is
    what stands in for the token. A shareable link names no one, so its id
    alone grants nothing, and it is answered as not found — as is an
    invitation addressed to someone else, so an id does not confirm that an
    invitation exists. Everything past that is `accept_invitation`'s.
    """
    async with tenant_session(session_factory, req.tenant_id) as session:
        invitation = await invitation_store.get_in_tenant(
            session, req.tenant_id, req.invitation_id
        )
        if (
            invitation is None
            or invitation.email is None
            or invitation.email.lower() != caller.email.lower()
        ):
            raise HTTPException(status_code=404, detail="Invitation not found")
        _require_invitation_usable(invitation, caller.email)
        membership, user = await _join_through(
            session,
            invitation,
            caller,
            user_store,
            invitation_store,
            organization_directory,
        )

    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        req.tenant_id,
        session_auth_time(request),
    )
    return membership


# ── Joining by e-mail domain ──────────────────────────────────────────────────


def _join_domain_detail(row: TenantJoinDomain) -> JoinDomainDetail:
    return JoinDomainDetail(
        domain=row.domain, created_by=row.created_by, created_at=str(row.created_at)
    )


@router.get("/tenants/{tenant_id}/join-domains")
async def list_join_domains(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    join_domain_store: Annotated[JoinDomainStore, Depends(get_join_domain_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
) -> JoinDomainsResponse:
    """The e-mail domains the bound tenant lets people join from, and whether
    the caller could add their own. Admins only."""
    _require_bound_tenant(tenant_id)
    own_domain = email_domain(user.email)
    rows = await join_domain_store.list_for_tenant(session, tenant_id)
    return JoinDomainsResponse(
        domains=[_join_domain_detail(row) for row in rows],
        own_domain=own_domain,
        own_domain_refusal=join_domain_refusal(own_domain),
    )


@router.post("/tenants/{tenant_id}/join-domains", status_code=201)
async def add_join_domain(
    tenant_id: str,
    req: JoinDomainCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    join_domain_store: Annotated[JoinDomainStore, Depends(get_join_domain_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
) -> JoinDomainDetail:
    """Let anyone signed in with an address at a domain join the bound tenant
    as a member, without an invitation. Admins only.

    Only the domain of the admin's own address. That is the proof the domain
    is theirs to open: their account's address is either asserted verified by
    the identity provider or set by the operator who created the account. A
    public e-mail provider's domain is refused even then, since nobody's
    address there says anything about who else has one.
    """
    _require_bound_tenant(tenant_id)
    domain = req.domain.strip().lower()
    own_domain = email_domain(user.email)
    if domain != own_domain:
        raise HTTPException(
            status_code=400,
            detail=(
                f"You can only open the workspace to the domain of your own "
                f"address, {own_domain}"
            ),
        )
    refusal = join_domain_refusal(domain)
    if refusal is not None:
        raise HTTPException(status_code=400, detail=refusal.capitalize())
    try:
        row = await join_domain_store.add(session, domain=domain, created_by=user.id)
    except JoinDomainAlreadyAdded as exc:
        raise HTTPException(
            status_code=409, detail=f"The workspace is already open to {domain}"
        ) from exc
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.JOIN_DOMAIN_ADDED,
        target_type="join_domain",
        target_id=row.domain,
        details=None,
    )
    await session.commit()
    return _join_domain_detail(row)


@router.delete("/tenants/{tenant_id}/join-domains/{domain}", status_code=204)
async def remove_join_domain(
    tenant_id: str,
    domain: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    join_domain_store: Annotated[JoinDomainStore, Depends(get_join_domain_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
) -> None:
    """Stop letting people at a domain join the bound tenant. Admins
    only, and any domain: closing a workspace needs no proof of anything.
    Members who already joined stay members."""
    _require_bound_tenant(tenant_id)
    try:
        await join_domain_store.remove(session, tenant_id, domain)
    except JoinDomainNotFound as exc:
        raise HTTPException(
            status_code=404, detail=f"The workspace is not open to {domain}"
        ) from exc
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.JOIN_DOMAIN_REMOVED,
        target_type="join_domain",
        target_id=domain.lower(),
        details=None,
    )
    await session.commit()


@router.get("/joinable-tenants")
async def list_joinable_tenants(
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> list[JoinableTenant]:
    """The workspaces open to the domain of the caller's own address, that
    they do not already belong to.

    Authenticated without a tenant, like `list_my_invitations` and for the
    same reason: none of these is a workspace any session of theirs is bound
    to. `tenants_open_to` names the tenants; each is read on its own bound
    session.
    """
    domain = email_domain(caller.email)
    found: list[JoinableTenant] = []
    for tenant_id in await tenants_open_to(session_factory, domain):
        async with tenant_session(session_factory, tenant_id) as session:
            if await user_store.tenant_role(session, tenant_id, caller.id) is not None:
                continue
            tenant = await session.get(Tenant, tenant_id)
            assert tenant is not None
            found.append(
                JoinableTenant(
                    tenant_id=tenant.id,
                    tenant_slug=tenant.slug,
                    tenant_name=tenant.name,
                    domain=domain,
                )
            )
    return found


@router.post("/joinable-tenants/{tenant_id}/join")
async def join_tenant_by_domain(
    tenant_id: str,
    request: Request,
    response: Response,
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    join_domain_store: Annotated[JoinDomainStore, Depends(get_join_domain_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> TenantMembershipResponse:
    """Join a workspace open to the domain of the caller's address, as a
    member, and switch the caller's session into it.

    A workspace that is not open to that domain is answered as not found, so
    the route does not confirm that a workspace exists. Joining one you are
    already in returns your existing role and changes nothing.
    """
    domain = email_domain(caller.email)
    async with tenant_session(session_factory, tenant_id) as session:
        if not await join_domain_store.is_open_to(session, tenant_id, domain):
            raise HTTPException(status_code=404, detail="Workspace not found")
        role = await user_store.tenant_role(session, tenant_id, caller.id)
        if role is None:
            role = "member"
            joining = await _organization_to_join(session, tenant_id, caller.id)
            await user_store.add_membership(
                session,
                tenant_id=tenant_id,
                user_id=caller.id,
                role=role,
                organization_role="member",
            )
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=caller.id,
                action=AuditAction.MEMBER_JOINED_BY_DOMAIN,
                target_type="user",
                target_id=caller.id,
                details={"role": role, "domain": domain},
            )
            await _join_in_directory(organization_directory, joining, caller.id)
        membership, user = await _enter(session, tenant_id, caller, user_store)

    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        tenant_id,
        session_auth_time(request),
    )
    return membership


# ── Members ───────────────────────────────────────────────────────────────────


@router.get("/tenants/{tenant_id}/members")
async def list_members(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[MemberDetail]:
    """Every member of the bound tenant, then every `org_admin` of its
    organization who is not one, as `admin` via the organization. Any member
    may list their own workspace's roster; changing or removing one is
    admin-gated below."""
    caller_id = user.id
    _require_bound_tenant(tenant_id)
    tenant = await session.get(Tenant, tenant_id)
    organization_roles: dict[str, str] = {}
    organization_admins: list[tuple[User, OrganizationMember]] = []
    if tenant is not None and tenant.organization_id is not None:
        for person, member in await organization_store.list_members(
            session, tenant.organization_id
        ):
            organization_roles[person.id] = member.role
            if member.role == ORGANIZATION_ADMIN_ROLE:
                organization_admins.append((person, member))
    members = await user_store.list_tenant_members(session)
    roster = [
        _member_detail(
            person,
            membership,
            organization_roles.get(person.id),
            caller_id=caller_id,
            administers=is_admin,
        )
        for person, membership in members
    ]
    listed = {person.id for person, _ in members}
    roster.extend(
        MemberDetail(
            user_id=person.id,
            name=person.name,
            email=person.email,
            role=ORGANIZATION_ADMIN_TENANT_ROLE,
            created_at=str(member.created_at),
            service_account=is_bootstrap_owner(person),
            organization_role=member.role,
            via_organization=True,
            # Changed only through the organization's members; and a transfer
            # needs a membership here, which they don't hold.
            can_change_role=False,
            can_remove=False,
            can_receive_transfer=False,
        )
        for person, member in organization_admins
        if person.id not in listed
    )
    return roster


@router.patch("/tenants/{tenant_id}/members/{user_id}")
async def update_member_role(
    tenant_id: str,
    user_id: str,
    req: MemberUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    admin: Annotated[User, Depends(require_tenant_admin)],
) -> MemberDetail:
    """Change a member's role. Admins only, their own included, so an admin
    steps down while another remains.

    Refuses to demote the last admin: a workspace with none has nobody who
    can manage it, and getting one back takes the server's operator.
    """
    _require_bound_tenant(tenant_id)
    role = _member_role(req.role)

    membership = await session.get(TenantMember, (tenant_id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="Not a member of this workspace")
    await _refuse_organization_admin(session, user_store, tenant_id, user_id)

    if membership.role == "admin" and role != "admin":
        if await user_store.lock_admins(session) <= 1:
            raise HTTPException(status_code=409, detail="Cannot demote the last admin")

    if membership.role != role:
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=admin.id,
            action=AuditAction.MEMBER_ROLE_CHANGED,
            target_type="user",
            target_id=user_id,
            details={"from": membership.role, "to": role},
        )
    membership.role = role
    await session.commit()

    user = await user_store.get(session, user_id)
    assert user is not None
    return _member_detail(
        user,
        membership,
        await user_store.organization_role(session, tenant_id, user_id),
        caller_id=admin.id,
        administers=True,
    )


async def _heir_detail(
    session: AsyncSession, user_store: UserStore, heir_id: str | None
) -> dict[str, str] | None:
    """Who receives what a removed member owns, as the Gateway names them."""
    if heir_id is None:
        return None
    heir = await user_store.get(session, heir_id)
    if heir is None:
        raise RuntimeError(f"The heir {heir_id} of a member removal has no user")
    return {"user_id": heir.id, "name": heir.name, "email": heir.email}


@router.get("/tenants/{tenant_id}/members/{user_id}/removal")
async def preview_member_removal(
    tenant_id: str,
    user_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    admin: Annotated[User, Depends(require_tenant_admin)],
) -> dict:
    """Who would receive what `user_id` owns here if the caller removed them
    now (`organization_access.removal_heir`), for the Gateway to say so before
    the caller confirms: `handed_over_to` names them, or is None when the
    workspace has no other admin and what they own would stay theirs."""
    _require_bound_tenant(tenant_id)
    if await session.get(TenantMember, (tenant_id, user_id)) is None:
        raise HTTPException(status_code=404, detail="Not a member of this workspace")
    heir = await removal_heir(session, tenant_id, user_id, admin.id, lock=False)
    return {"handed_over_to": await _heir_detail(session, user_store, heir)}


@router.delete("/tenants/{tenant_id}/members/{user_id}", response_model=None)
async def remove_member(
    request: Request,
    response: Response,
    tenant_id: str,
    user_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    admin: Annotated[User, Depends(require_tenant_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict | JSONResponse:
    """Remove a member from the bound tenant. Admins only, their own
    membership included, so an admin leaves while another remains; the
    session then moves off the workspace (`rebind_if_left`).

    Refuses to remove the last admin, as demoting one does.

    Removal also revokes what the member's own credentials in this tenant let
    them do here, in the same transaction as the membership row going away —
    a bearer credential resolves its tenant from its own row and never
    consults membership, so leaving it behind would leave the person with
    working, invisible access (`docs/old/multi-tenancy-phase2-tenants.md`,
    §3). Concretely, this deletes every personal API key the member holds
    here, and every service connection they hold here (their grants go with
    them), revoking what was issued on those once the removal has committed.

    What the member owns here (rooms, packages, references, reference types,
    library documents, templates) passes to the admin removing them, or to the
    workspace's longest-standing other admin when the remover is not a member
    of it (`organization_access.removal_heir`), so nothing is left owned by
    someone who can no longer reach it. Chats and a room's own documents stay
    as they are, as a transfer refuses them. The response names who received
    them (`handed_over_to`, None when the workspace has no other admin) and
    how many of each kind passed (`handed_over`); `GET …/removal` names the
    recipient beforehand.

    It does **not** touch any agent the member owns — it refuses instead, 409,
    naming them. An agent is not that member's private property to lose along
    with their membership: it sits in rooms with other people, it may be the
    only copy of a working configuration, and its name is something other
    members already depend on. A personal key is trivially recoverable — mint
    another — but deleting an agent is not, and a member removal is routine
    enough, including by mistake, that it must not be the thing that makes an
    irreversible call about shared infrastructure. An admin who hits this
    deletes those agents deliberately, with the agent in front of them, then
    removes the member, or hands them to someone else first
    (`POST /ownership/transfer`, which refuses an agent still tied to its
    owner's own connections or machine).
    """
    _require_bound_tenant(tenant_id)
    # Locked until the removal commits, as handing the member something locks
    # it (`accounts/transfer.py`), so no agent reaches them after the check
    # below finds none.
    membership = await session.get(
        TenantMember,
        (tenant_id, user_id),
        with_for_update=True,
        populate_existing=True,
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="Not a member of this workspace")
    await _refuse_organization_admin(session, user_store, tenant_id, user_id)

    if membership.role == "admin":
        if await user_store.lock_admins(session) <= 1:
            raise HTTPException(status_code=409, detail="Cannot remove the last admin")

    owned_agents = await agent_store.get_by_owner(session, user_id)
    if owned_agents:
        names = ", ".join(sorted(agent.name for agent in owned_agents))
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot remove: this user owns agents in this workspace. "
                f"Transfer or delete them first: {names}"
            ),
        )

    revocation = AccessRevocation(
        agent_store=agent_store,
        api_key_store=api_key_store,
        broker=broker,
        protocol=protocol,
        sign_in_flows=request.app.state.sign_in_flows,
    )
    try:
        removal = await remove_membership(
            session,
            revocation,
            membership,
            actor_id=admin.id,
            details={},
            keep_agent_keys=False,
        )
    except ServiceError as error:
        return service_refusal(error)
    await session.commit()

    warning = await revocation.finish(session, user_id, removal.revoked)
    handed_over_to = await _heir_detail(session, user_store, removal.heir)
    if user_id == admin.id:
        await rebind_if_left(
            request, response, session_factory, user_store, admin, config
        )
    return {
        "ok": True,
        "warning": warning,
        "handed_over_to": handed_over_to,
        "handed_over": removal.handed,
    }
