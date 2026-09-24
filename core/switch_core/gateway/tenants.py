from __future__ import annotations

import hashlib
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.models import Invitation, Tenant, TenantMember, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.invitation_store import (
    InvitationNotUsableError,
    InvitationStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    get_authenticated_caller,
    get_authenticated_user_id,
    get_current_user,
    get_tenant_is_owner,
    is_tenant_member,
    list_tenant_memberships,
    require_tenant_admin,
    set_session_cookie,
    tenant_of_invitation_token,
)
from switch_core.gateway.auth_routes import _session_response
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_agent_store,
    get_api_key_store,
    get_client_lifecycle,
    get_config,
    get_invitation_store,
    get_protocol,
    get_session,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.schemas import (
    InvitationAcceptRequest,
    InvitationCreateRequest,
    InvitationCreateResponse,
    InvitationDetail,
    MemberDetail,
    MemberUpdateRequest,
    SessionUserResponse,
    TenantCreateRequest,
    TenantMembershipResponse,
)
from switch_core.telemetry import emit_safely
from switch_core.telemetry.ages import age_hours
from switch_core.tenant_context import current_tenant_id

logger = logging.getLogger(__name__)


router = APIRouter()

TENANT_MEMBER_ROLES = ("owner", "admin", "member")

_SLUG_INVALID_CHARS = re.compile(r"[^a-z0-9]+")


def _derive_slug(name: str) -> str:
    """A URL-safe slug from a workspace name.

    A taken slug is a 409 (`create_tenant` below), never a silently
    suffixed alternative — the design is explicit that a caller must be told
    rather than handed a workspace under a name it did not ask for.
    """
    slug = _SLUG_INVALID_CHARS.sub("-", name.strip().lower()).strip("-")
    if not slug:
        raise HTTPException(
            status_code=400,
            detail="Name must contain at least one letter or digit",
        )
    return slug


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
        raise HTTPException(status_code=403, detail="Not authorized for this tenant")


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


def _member_detail(user: User, membership: TenantMember) -> MemberDetail:
    return MemberDetail(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=membership.role,
        created_at=str(membership.created_at),
    )


def _require_owner(is_owner: bool, action: str) -> None:
    """Raise 403 unless the caller owns the bound tenant.

    The three actions this guards — granting `owner`, changing an owner's
    role, removing an owner — are the ones that move a workspace's ownership
    set, and none of them is reachable by a last-owner guard: an admin who
    promotes themselves first leaves two owners standing at every subsequent
    step, so each individual request looks safe while the sequence takes the
    workspace. `require_tenant_admin` still gates getting this far; this is
    the narrower bit on top (`authz.owns_tenant`).
    """
    if not is_owner:
        raise HTTPException(
            status_code=403, detail=f"Only a workspace owner may {action}"
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


@router.post("/tenants", status_code=201)
async def create_tenant(
    req: TenantCreateRequest,
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
) -> TenantMembershipResponse:
    """Create a workspace. The caller becomes its `owner`.

    Provisioning goes through `ClientLifecycleService.create_tenant` — "the
    one seam a tenant comes into existence through" — rather than inserting a
    `Tenant` row here, so a workspace created through this route gets the same
    admin client every other tenant does. The membership row is not part of
    that call (it provisions the tenant, not any particular person's place in
    it), so it is written here, in its own session bound to the new tenant.

    Two transactions, therefore, and the gap between them is real: the tenant
    is committed before the membership is attempted, so a failure in the
    second leaves a workspace nobody belongs to and a slug nobody can reuse.
    It is not folded into one because the tenant row has to be committed
    before `ensure_system_client` can provision against it, and that call is
    inside the seam. What the gap gets instead is a log line naming the
    workspace and the person who should have owned it, because the alternative
    — a 500 with the orphan unrecorded — is the silent degradation this
    codebase refuses. An operator repairs it by inserting the membership.
    """
    slug = _derive_slug(req.name)
    try:
        tenant = await client_lifecycle.create_tenant(req.name, slug)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409, detail=f"Slug already taken: {slug}"
        ) from exc

    try:
        async with tenant_session(session_factory, tenant.id) as session:
            await user_store.add_membership(
                session, tenant_id=tenant.id, user_id=user_id, role="owner"
            )
            await session.commit()
    except Exception:
        logger.error(
            "Workspace %s (slug %s) was created but its owner membership for "
            "user %s was not written: it now has no members and its slug is "
            "taken. Insert the membership to repair it.",
            tenant.id,
            slug,
            user_id,
        )
        raise

    return TenantMembershipResponse(
        id=tenant.id, slug=tenant.slug, name=tenant.name, role="owner"
    )


@router.post("/tenants/{tenant_id}/switch")
async def switch_tenant(
    tenant_id: str,
    response: Response,
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> SessionUserResponse:
    """Select `tenant_id` for this session: verify membership, then re-mint
    the cookie carrying it as the tenant claim.

    The membership check is what keeps the claim from being a way in on its
    own: `_resolve_tenant_id` re-reads `tenant_members` on every request
    regardless of what the cookie says, so a forged or stale claim already
    buys nothing — but this route is the one place a *caller* picks the
    value that goes into it, and it must not let them pick a tenant they do
    not belong to.
    """
    if not await is_tenant_member(session_factory, user_id, tenant_id):
        raise HTTPException(status_code=403, detail="Not a member of this tenant")

    user = await user_store.get(session, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    set_session_cookie(
        response, user, config.jwt_secret_key, config.gateway_cookie_secure, tenant_id
    )
    return _session_response(user)


# ── Invitations ───────────────────────────────────────────────────────────────


@router.post("/tenants/{tenant_id}/invitations", status_code=201)
async def create_invitation(
    tenant_id: str,
    req: InvitationCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    user: Annotated[User, Depends(require_tenant_admin)],
    is_owner: Annotated[bool, Depends(get_tenant_is_owner)],
) -> InvitationCreateResponse:
    """Mint an invitation to the bound tenant. `owner`/`admin` only.

    An `owner` invitation is owner-only: minting one is granting ownership
    with a step of indirection, so it answers to the same gate the direct
    grant does (`_require_owner`).
    """
    _require_bound_tenant(tenant_id)
    if req.role not in TENANT_MEMBER_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {req.role}")
    if req.role == "owner":
        _require_owner(is_owner, "invite another owner")

    expires_at = datetime.now(UTC) + timedelta(hours=req.expires_in_hours)
    invitation, token = await invitation_store.create(
        session,
        role=req.role,
        email=req.email,
        expires_at=expires_at,
        uses_remaining=req.uses_remaining,
        created_by=user.id,
    )
    await session.commit()
    emit_safely(current_telemetry(), "invitation_sent", {})
    return InvitationCreateResponse(token=token, **_invitation_fields(invitation))


@router.get("/tenants/{tenant_id}/invitations")
async def list_invitations(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> list[InvitationDetail]:
    """Every invitation of the bound tenant. `owner`/`admin` only."""
    _require_bound_tenant(tenant_id)
    invitations = await invitation_store.list_for_tenant(session)
    return [_invitation_detail(i) for i in invitations]


@router.delete("/tenants/{tenant_id}/invitations/{invitation_id}")
async def revoke_invitation(
    tenant_id: str,
    invitation_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> InvitationDetail:
    """Revoke an invitation of the bound tenant. `owner`/`admin` only."""
    _require_bound_tenant(tenant_id)
    try:
        invitation = await invitation_store.revoke(session, invitation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await session.commit()
    return _invitation_detail(invitation)


@router.post("/invitations/accept")
async def accept_invitation(
    req: InvitationAcceptRequest,
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    invitation_store: Annotated[InvitationStore, Depends(get_invitation_store)],
) -> TenantMembershipResponse:
    """Accept an invitation, joining its tenant.

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

        existing_role = await user_store.tenant_role(session, tenant_id, caller.id)
        if existing_role is None:
            try:
                await invitation_store.consume(session, invitation.id)
            except InvitationNotUsableError as exc:
                raise HTTPException(
                    status_code=403, detail="This invitation has already been used"
                ) from exc
            role = invitation.role
            await user_store.add_membership(
                session, tenant_id=tenant_id, user_id=caller.id, role=role
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
        else:
            role = existing_role

        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None
        await session.commit()

    return TenantMembershipResponse(
        id=tenant.id, slug=tenant.slug, name=tenant.name, role=role
    )


# ── Members ───────────────────────────────────────────────────────────────────


@router.get("/tenants/{tenant_id}/members")
async def list_members(
    tenant_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[MemberDetail]:
    """Every member of the bound tenant. Any member may list their own
    workspace's roster; changing or removing one is admin-gated below."""
    _require_bound_tenant(tenant_id)
    members = await user_store.list_tenant_members(session)
    return [_member_detail(user, membership) for user, membership in members]


@router.patch("/tenants/{tenant_id}/members/{user_id}")
async def update_member_role(
    tenant_id: str,
    user_id: str,
    req: MemberUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
    is_owner: Annotated[bool, Depends(get_tenant_is_owner)],
) -> MemberDetail:
    """Change a member's role. `owner`/`admin` only.

    Both ends of the ownership set are owner-only: an admin may promote a
    member to admin, but not to `owner`, and may not touch an existing
    owner's role at all. See `_require_owner` for what an admin who could do
    either would be able to do in three requests.

    Refuses to demote the last `owner` on top of that: with no workspace
    deletion in this phase, there is no legitimate route to a workspace with
    none.
    """
    _require_bound_tenant(tenant_id)
    if req.role not in TENANT_MEMBER_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {req.role}")

    membership = await session.get(TenantMember, (tenant_id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="Not a member of this tenant")

    if req.role == "owner" and membership.role != "owner":
        _require_owner(is_owner, "grant ownership")

    if membership.role == "owner" and req.role != "owner":
        _require_owner(is_owner, "change an owner's role")
        if await user_store.count_owners(session) <= 1:
            raise HTTPException(status_code=409, detail="Cannot demote the last owner")

    membership.role = req.role
    await session.commit()

    user = await user_store.get(session, user_id)
    assert user is not None
    return _member_detail(user, membership)


@router.delete("/tenants/{tenant_id}/members/{user_id}")
async def remove_member(
    tenant_id: str,
    user_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
    is_owner: Annotated[bool, Depends(get_tenant_is_owner)],
) -> dict[str, bool]:
    """Remove a member from the bound tenant. `owner`/`admin` only.

    Removing an *owner* is owner-only, the same as demoting one and for the
    same reason (`_require_owner`), and refuses on the last owner besides.

    Removal also revokes what the member's own credentials in this tenant let
    them do here, in the same transaction as the membership row going away —
    a bearer credential resolves its tenant from its own row and never
    consults membership, so leaving it behind would leave the person with
    working, invisible access (`docs/old/multi-tenancy-phase2-tenants.md`,
    §3). Concretely, this deletes every personal API key the member holds
    here.

    It does **not** touch any agent the member owns — it refuses instead, 409,
    naming them. An agent is not that member's private property to lose along
    with their membership: it sits in rooms with other people, it may be the
    only copy of a working configuration, and its name is something other
    members already depend on. A personal key is trivially recoverable — mint
    another — but deleting an agent is not, and a member removal is routine
    enough, including by mistake, that it must not be the thing that makes an
    irreversible call about shared infrastructure. An admin who hits this
    deletes those agents deliberately, with the agent in front of them, then
    removes the member. The 409 says exactly that and nothing more: there is
    no route that reassigns an agent's owner in this phase, so offering
    reassignment as the way out would send an admin looking for a button that
    does not exist.
    """
    _require_bound_tenant(tenant_id)
    membership = await session.get(TenantMember, (tenant_id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="Not a member of this tenant")

    if membership.role == "owner":
        _require_owner(is_owner, "remove an owner")
        if await user_store.count_owners(session) <= 1:
            raise HTTPException(status_code=409, detail="Cannot remove the last owner")

    owned_agents = await agent_store.get_by_owner(session, user_id)
    if owned_agents:
        names = ", ".join(sorted(agent.name for agent in owned_agents))
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot remove: this member owns agents in this tenant — "
                f"delete them first: {names}"
            ),
        )

    keys = await api_key_store.get_by_user(session, user_id)
    revoked_key_hashes = [key.key_hash for key in keys]
    for key in keys:
        await api_key_store.delete(session, key.id)

    await session.delete(membership)
    await session.commit()

    for key_hash in revoked_key_hashes:
        protocol.api_key_cache.invalidate(key_hash)

    return {"ok": True}
