from __future__ import annotations

import asyncio
import datetime
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Literal

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import HTTPConnection

from switch_core import room_admins, room_policy
from switch_core.authz import (
    ORGANIZATION_ADMIN_ROLE,
    ORGANIZATION_ADMIN_TENANT_ROLE,
    Principal,
    require_group_filing,
)
from switch_core.config import SwitchConfig
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import Organization, Room, Tenant, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import (
    all_tenant_ids,
    tenant_of_invitation,
    tenants_bindable_by_user,
    tenants_inviting_email,
    tenants_of_organization,
    tenants_of_user,
    tenants_open_to_domain,
)
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.schemas import (
    OrganizationSummary,
    SessionStateResponse,
    SessionStateUser,
    TenantMembershipResponse,
)
from switch_core.keys import Keyring, KeyringError, Purpose
from switch_core.logging_context import log_context
from switch_core.room_policy import RoomAction, RoomCaller, RoomDecision
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24
# The `users.session_version` a session was minted with. A cookie minted before
# the claim existed carries none and counts as 0, the value every account
# started at, so the deploy that added it signed nobody out.
SESSION_VERSION_CLAIM = "sv"
# When the person last proved who they are, as a UNIX time. Every re-mint
# (refresh, switching workspace) carries it forward, and no session outlives
# it by more than `SESSION_MAX_AGE`, however often it is refreshed: then the
# person signs in again. A cookie minted before the claim existed is taken
# to have signed in when it was minted (`iat`), the earliest moment it can
# vouch for, so the deploy that added it signed nobody out early.
AUTH_TIME_CLAIM = "auth_time"
SESSION_MAX_AGE = datetime.timedelta(days=14)

# The `error` discriminator on the three tenant-resolution failures a client
# has to tell apart. A bare `{"detail": [...]}` is indistinguishable from
# FastAPI's own validation failures, and the status code alone does not
# separate "choose a workspace" from "the one you chose is gone" — both of
# which the caller can fix without help, unlike the third.
TENANT_SELECTION_REQUIRED = "tenant_selection_required"
TENANT_SELECTION_INVALID = "tenant_selection_invalid"
TENANT_MEMBERSHIP_UNRESOLVED = "tenant_membership_unresolved"


SIGNUP_REFUSED_DETAIL = "New Switch accounts are not available in your country."


def signup_refused_by_edge(request: Request, config: SwitchConfig) -> bool:
    """Whether the edge in front of the server marked this request as one
    that may not create an account (`gateway_signup_refused_header`)."""
    header = config.gateway_signup_refused_header
    return header is not None and header in request.headers


def hash_password(password: str) -> str:
    result: bytes = bcrypt.hashpw(password.encode(), bcrypt.gensalt())
    return result.decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    # OIDC-provisioned users have no local password hash — password login must
    # fail cleanly for them rather than raising.
    if password_hash is None:
        return False
    result: bool = bcrypt.checkpw(password.encode(), password_hash.encode())
    return result


async def hash_password_off_loop(password: str) -> str:
    """`hash_password` on a worker thread.

    bcrypt is slow on purpose, a few hundred milliseconds of CPU per call, and
    it holds the event loop for all of it: on the loop, every other request in
    the process waits behind one login. Call it with no transaction open, too,
    or the connection waits with them.
    """
    return await asyncio.to_thread(hash_password, password)


async def verify_password_off_loop(password: str, password_hash: str | None) -> bool:
    """`verify_password` on a worker thread, for the same reason as
    `hash_password_off_loop`."""
    return await asyncio.to_thread(verify_password, password, password_hash)


def create_jwt(
    user_id: str,
    email: str,
    role: str,
    keyring: Keyring,
    tenant_id: str | None,
    *,
    session_version: int,
    auth_time: datetime.datetime,
) -> str:
    """Sign a session JWT. `tenant_id` is the caller's selected tenant, or
    `None` for a session that has not selected one yet (a fresh login, or a
    multi-membership account that has never called `/tenants/{id}/switch`).

    The claim only ever *selects*: `_resolve_tenant_id` re-checks it against a
    live membership row on every request, so a forged or stale value buys
    nothing (`docs/old/multi-tenancy-phase2-tenants.md`, §3).

    `auth_time` is when the person signed in: now, for a sign-in, and the
    presented session's own (`session_auth_time`) for a re-mint. A session
    signed in `SESSION_MAX_AGE` ago or longer is refused with 401 rather than
    minted again.
    """
    now = datetime.datetime.now(datetime.UTC)
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "tenant_id": tenant_id,
        SESSION_VERSION_CLAIM: session_version,
        AUTH_TIME_CLAIM: int(auth_time.timestamp()),
        "exp": session_expires_at(now, auth_time),
        "iat": now,
    }
    return jwt.encode(
        payload,
        keyring.derive(Purpose.SESSION),
        algorithm=JWT_ALGORITHM,
        headers={"kid": keyring.current.id},
    )


def session_expires_at(
    now: datetime.datetime, auth_time: datetime.datetime
) -> datetime.datetime:
    """When a session minted at `now` expires: `JWT_EXPIRY_HOURS` from now,
    or `SESSION_MAX_AGE` after its sign-in if that comes first. 401 for a
    session already past the second."""
    signed_in_until = auth_time + SESSION_MAX_AGE
    if signed_in_until <= now:
        raise HTTPException(status_code=401, detail="Session too old; sign in again")
    return min(now + datetime.timedelta(hours=JWT_EXPIRY_HOURS), signed_in_until)


def set_session_cookie(
    response: Response,
    user: User,
    keyring: Keyring,
    secure: bool,
    tenant_id: str | None,
    auth_time: datetime.datetime,
) -> None:
    """Mint the switch_auth session cookie for an authenticated user.

    Shared by password login, the OIDC callback, `/auth/refresh` and
    `/tenants/{id}/switch` so the session contract stays identical regardless
    of how the user proved their identity or picked their tenant. Every one of
    those four must pass `tenant_id` explicitly — `/auth/refresh` is the path
    most likely to get this wrong, because it re-mints from the still-valid
    `User` alone otherwise, silently dropping whatever tenant was selected.

    `secure` gates the Secure flag: True on HTTPS deployments so the JWT is
    never sent over plain HTTP, False for local dev served over http://.

    `auth_time` is the same as `create_jwt`'s: now for a sign-in, and
    `session_auth_time(request)` for every re-mint, so refreshing or switching
    workspace never extends a session past `SESSION_MAX_AGE`.
    """
    now = datetime.datetime.now(datetime.UTC)
    expires_at = session_expires_at(now, auth_time)
    token = create_jwt(
        user.id,
        user.email,
        user.role,
        keyring,
        tenant_id,
        session_version=user.session_version,
        auth_time=auth_time,
    )
    response.set_cookie(
        key="switch_auth",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=int((expires_at - now).total_seconds()),
        path="/",
    )


def _session_key(token: str, keyring: Keyring) -> bytes | str:
    """The key a session token was signed with, named by its `kid`.

    A token with no `kid` was signed with `JWT_SECRET_KEY` before
    `SECRET_KEYS`, and verifies only while that is still set.
    """
    key_id = jwt.get_unverified_header(token).get("kid")
    if key_id is None:
        if keyring.legacy_secret is None:
            raise jwt.InvalidTokenError("session predates SECRET_KEYS")
        return keyring.legacy_secret
    if not isinstance(key_id, str):
        raise jwt.InvalidTokenError("malformed kid")
    try:
        return keyring.derive(Purpose.SESSION, key_id)
    except KeyringError as exc:
        raise jwt.InvalidTokenError(str(exc)) from exc


def session_subject(token: str, keyring: Keyring) -> str | None:
    """The user a session token names, if its signature checks out and it has
    not expired; None otherwise. Reads nothing: whether the session was ended
    since, or the user is still there, is for authentication to ask."""
    try:
        payload = jwt.decode(
            token, _session_key(token, keyring), algorithms=[JWT_ALGORITHM]
        )
    except jwt.InvalidTokenError:
        return None
    subject = payload.get("sub")
    return subject if isinstance(subject, str) else None


def decode_jwt(token: str, keyring: Keyring) -> dict:
    try:
        return jwt.decode(
            token, _session_key(token, keyring), algorithms=[JWT_ALGORITHM]
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def _authenticate(
    request: Request,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> dict:
    """Decode the switch_auth cookie and confirm its subject still exists.

    Nothing here binds a tenant — both reads are on `users`, which carries no
    tenant column and so no policy, so a session with nothing bound is the
    honest way to read it. Shared by `get_current_user` (which goes on to bind
    one) and `get_authenticated_user_id` (which deliberately does not).
    """
    payload = _session_claims(request, config)
    await _require_current_session(session_factory, user_store, payload)
    return payload


def _session_claims(request: HTTPConnection, config: SwitchConfig) -> dict:
    """The session cookie's claims, verified. Also records on the request
    when the session signed in, for a route that mints it again
    (`session_auth_time`)."""
    token = request.cookies.get("switch_auth")
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_jwt(token, config.keyring)
    request.state.session_auth_time = datetime.datetime.fromtimestamp(
        payload.get(AUTH_TIME_CLAIM, payload["iat"]), datetime.UTC
    )
    return payload


def session_auth_time(request: Request) -> datetime.datetime:
    """When the request's session signed in, for minting it again.

    Set by every dependency that authenticates the session cookie, so a route
    that re-mints one without having authenticated it is a bug, and fails here
    rather than starting the session's lifetime over.
    """
    auth_time: datetime.datetime | None = getattr(
        request.state, "session_auth_time", None
    )
    if auth_time is None:
        raise RuntimeError(
            "session_auth_time read on a request whose session was not authenticated"
        )
    return auth_time


def _session_version(payload: dict) -> int:
    return int(payload.get(SESSION_VERSION_CLAIM, 0))


def _refuse_ended_session(current_version: int, payload: dict) -> None:
    """401 for a cookie minted before the account's sessions were ended: a
    password change, losing the server-admin role, or "Sign out of all
    devices" (`users.session_version`)."""
    if current_version != _session_version(payload):
        raise HTTPException(status_code=401, detail="Session ended")


async def _require_current_session(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    payload: dict,
) -> None:
    """The cookie's subject still exists and its sessions were not ended
    since this one was minted."""
    async with session_factory() as system_session:
        version = await user_store.session_version(system_session, payload["sub"])
    if version is None:
        raise HTTPException(status_code=401, detail="User not found")
    _refuse_ended_session(version, payload)


async def session_is_current(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    session_version: int,
) -> bool:
    """Whether a session minted with `session_version` still stands: the
    account exists and its sessions have not been ended since. Asked again
    by a socket or stream that stays open long after it was authenticated."""
    async with session_factory() as system_session:
        current = await user_store.session_version(system_session, user_id)
    return current == session_version


async def _require_user_exists(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> None:
    async with session_factory() as system_session:
        if not await user_store.exists(system_session, user_id):
            raise HTTPException(status_code=401, detail="User not found")


async def get_authenticated_user_id(
    request: Request,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> str:
    """The caller's user id, authenticated but with no tenant bound.

    For the one route that must answer before a tenant can be chosen:
    `GET /tenants` and `POST /tenants/{id}/switch` (`gateway/tenants.py`). A
    caller with several memberships and no selection cannot reach
    `get_current_user` at all — that is the whole point of the 409 it raises —
    so listing and switching have to authenticate independently of it.
    """
    payload = await _authenticate(request, session_factory, user_store, config)
    return payload["sub"]  # type: ignore[no-any-return]


@dataclass(frozen=True)
class AuthenticatedSession:
    """An authenticated caller's id and the tenant their session selects, if
    any — the claim as minted, not yet checked against a membership."""

    user_id: str
    tenant_claim: str | None


async def get_authenticated_session(
    request: Request,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> AuthenticatedSession:
    """Like `get_authenticated_user_id`, plus the session's tenant claim.

    Backs `GET /auth/session`, which reports what tenant resolution *would*
    do with this session rather than doing it — so it needs the claim that
    `get_current_user` would resolve, without the 403 or 409 that resolving
    it can raise.
    """
    payload = await _authenticate(request, session_factory, user_store, config)
    return AuthenticatedSession(
        user_id=payload["sub"], tenant_claim=payload.get("tenant_id")
    )


@dataclass(frozen=True)
class AuthenticatedCaller:
    """An authenticated caller with no tenant bound — read from `users`, which
    carries neither a tenant nor a policy.

    `is_operator` is `users.role == "admin"`, the same global bit
    `require_admin` gates on and the same one `authz.administers_tenant` takes
    as its bypass. It is meaningful here, before any tenant is bound, precisely
    because it is not granted per tenant: a route that has no tenant to ask
    about can still ask whether the caller runs the deployment.
    """

    id: str
    email: str
    is_operator: bool


async def get_authenticated_caller(
    request: Request,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> AuthenticatedCaller:
    """Like `get_authenticated_user_id`, but with the whole `users` row's worth
    of the caller that routes with no tenant bound actually need.

    Backs `POST /invitations/accept` (`gateway/tenants.py`) and
    `POST /organizations` (`gateway/organizations.py`): the first checks an email-bound invitation against
    the caller's *current* address, the second asks whether the caller runs the
    deployment. Both decide before any tenant is bound — the same "no tenant
    chosen yet" shape as `get_authenticated_user_id` — and both read the same
    global, unscoped `users` row. Read fresh rather than trusting the JWT's own
    claims, which are a snapshot from login: an address can change, and a
    revoked operator bit must not stay valid for the life of a cookie.
    """
    payload = _session_claims(request, config)
    async with session_factory() as system_session:
        user = await user_store.get(system_session, payload["sub"])
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    _refuse_ended_session(user.session_version, payload)
    return AuthenticatedCaller(
        id=user.id, email=user.email, is_operator=user.role == "admin"
    )


async def tenant_of_invitation_token(
    session_factory: async_sessionmaker[AsyncSession], token_hash: str
) -> str | None:
    """Which tenant an invitation token belongs to, or `None` if it names none.

    A thin wrapper around `db.tenant_lookup.tenant_of_invitation`, kept here
    rather than called directly from `gateway/tenants.py`: the exemption from
    row-level security is meant to be reachable through this one module,
    never through a store or lookup any endpoint could reach for itself (see
    `db/tenant_lookup.py` and `test_tenant_exemption_allowlist.py`) — the same
    reason `_resolve_tenant_id` and `list_tenant_memberships` live here rather
    than being called from the gateway directly.
    """
    return await tenant_of_invitation(session_factory, token_hash)


async def tenants_with_invitations_for(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> list[str]:
    """Which tenants hold a live invitation addressed to `email`.

    A thin wrapper around `db.tenant_lookup.tenants_inviting_email`, here for
    the same reason as `tenant_of_invitation_token` above: the exemption is
    reached through this one module. The only caller passes the signed-in
    caller's own address, never one taken from a request.
    """
    return await tenants_inviting_email(session_factory, email)


async def tenants_open_to(
    session_factory: async_sessionmaker[AsyncSession], domain: str
) -> list[str]:
    """Which tenants let anyone at `domain` join them without an invitation.

    A thin wrapper around `db.tenant_lookup.tenants_open_to_domain`, for the
    same reason as the wrappers above. The only caller passes the domain of
    the signed-in caller's own address.
    """
    return await tenants_open_to_domain(session_factory, domain)


async def tenants_bindable_by(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> list[str]:
    """Every tenant `user_id` may bind: those they are a member of, and those
    they administer as their organization's `org_admin`. Sorted, each once.
    One lookup, read on every authenticated request."""
    return await tenants_bindable_by_user(session_factory, user_id)


async def _in_organization(
    session_factory: async_sessionmaker[AsyncSession],
    candidates: list[str],
    organization_id: str,
) -> list[Tenant]:
    """Those of `candidates` in `organization_id`, in their order. A
    workspace's organization is readable only bound to it, so each is read
    on its own short session, one after another: the caller holds no other
    connection while this runs."""
    found: list[Tenant] = []
    for tenant_id in candidates:
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
        if tenant is not None and tenant.organization_id == organization_id:
            found.append(tenant)
    return found


async def organization_candidates(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    organization_id: str,
    *,
    is_operator: bool,
) -> list[str]:
    """Where to look for `organization_id`'s workspaces: its own, for the
    platform operator, who may bind any workspace and holds no membership to
    narrow by (`tenants_of_organization`); those `user_id` may bind,
    otherwise. Either way a caller keeps only those still in the
    organization when it reads them."""
    if is_operator:
        return await tenants_of_organization(session_factory, organization_id)
    return await tenants_bindable_by(session_factory, user_id)


async def workspaces_in_organization(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    organization_id: str,
) -> list[Tenant]:
    """The workspaces of `organization_id` that `user_id` holds a membership
    row in. Each workspace is read on its own short session, one after
    another, so the caller holds no other connection while this runs."""
    return await _in_organization(
        session_factory,
        await tenants_of_user(session_factory, user_id),
        organization_id,
    )


async def organization_workspaces(
    session_factory: async_sessionmaker[AsyncSession],
    admin_id: str,
    organization_id: str,
) -> list[Tenant]:
    """Every workspace of `organization_id`, as its `org_admin` `admin_id`
    reaches them, each read on its own short session."""
    return await _in_organization(
        session_factory,
        await tenants_bindable_by_user(session_factory, admin_id),
        organization_id,
    )


async def organization_workspace_ids(
    session_factory: async_sessionmaker[AsyncSession],
    admin_id: str,
    organization_id: str,
) -> list[str]:
    """The ids of `organization_workspaces`."""
    return [
        tenant.id
        for tenant in await organization_workspaces(
            session_factory, admin_id, organization_id
        )
    ]


async def workspaces_reached_through_organization(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    organization_id: str,
) -> list[Tenant]:
    """The workspaces of `organization_id` that `user_id` stands in only as
    its `org_admin`, holding no membership row there: what they lose on being
    demoted or removed. Each read on its own short session, as
    `workspaces_in_organization` does."""
    members_of = set(await tenants_of_user(session_factory, user_id))
    return await _in_organization(
        session_factory,
        [
            tenant_id
            for tenant_id in await tenants_bindable_by_user(session_factory, user_id)
            if tenant_id not in members_of
        ],
        organization_id,
    )


async def organizations_bindable_by(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> list[OrganizationSummary]:
    """The organizations of the workspaces `user_id` may bind, and their role
    in each, sorted by name.

    One short session per workspace, one after another; the organization's
    row is read on the first session bound to one of its workspaces, where
    its policy lets it be read, and skipped on the rest. An organization
    `user_id` belongs to without being able to bind any of its workspaces is
    left out: there is nothing in it they could open.
    """
    found: dict[str, OrganizationSummary] = {}
    for tenant_id in await tenants_bindable_by(session_factory, user_id):
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            if tenant is None or tenant.organization_id is None:
                continue
            if tenant.organization_id in found:
                continue
            organization = await session.get(Organization, tenant.organization_id)
            role = await user_store.organization_role(session, tenant_id, user_id)
        if organization is None or role is None:
            logger.warning(
                "User %s may bind workspace %s, but its organization %s or "
                "their role there was gone by the time it was read",
                user_id,
                tenant_id,
                tenant.organization_id,
            )
            continue
        found[organization.id] = OrganizationSummary(
            id=organization.id,
            slug=organization.slug,
            name=organization.name,
            role=role,
        )
    return sorted(found.values(), key=lambda row: (row.name, row.id))


async def organization_workspaces_bindable_by(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    organization_id: str,
    *,
    is_operator: bool,
) -> list[TenantMembershipResponse]:
    """The workspaces of `organization_id` that `user_id` may bind, and their
    role in each: every one for its `org_admin`, their own for a member.

    The platform operator may bind any workspace, and is shown every one of
    the organization's, as `admin` where they hold no role, the standing
    `platform_access` gives them. Each candidate is read on its own short
    session, and only those in the organization are described further.
    """
    candidates = await organization_candidates(
        session_factory, user_id, organization_id, is_operator=is_operator
    )
    found: list[TenantMembershipResponse] = []
    for tenant in await _in_organization(session_factory, candidates, organization_id):
        tenant_id = tenant.id
        async with tenant_session(session_factory, tenant_id) as session:
            role = await user_store.effective_tenant_role(session, tenant_id, user_id)
            organization_role = await user_store.organization_role(
                session, tenant_id, user_id
            )
        if role is None and is_operator:
            role = ORGANIZATION_ADMIN_TENANT_ROLE
        if role is None:
            logger.warning(
                "tenants_bindable_by named tenant %s for user %s, but their "
                "role there was gone by the time it was read",
                tenant_id,
                user_id,
            )
            continue
        found.append(
            TenantMembershipResponse(
                id=tenant.id,
                slug=tenant.slug,
                name=tenant.name,
                role=role,
                organization_role=organization_role,
                organization_id=tenant.organization_id,
            )
        )
    return found


async def _operator_may_enter(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    tenant_id: str,
) -> bool:
    """Whether `user_id` is the platform operator and `tenant_id` exists: the
    operator may bind any workspace, on `platform_access`."""
    async with session_factory() as system_session:
        user = await user_store.get(system_session, user_id)
    if user is None or user.role != "admin":
        return False
    async with tenant_session(session_factory, tenant_id) as session:
        return await session.get(Tenant, tenant_id) is not None


async def operator_entered_workspace(
    session_factory: async_sessionmaker[AsyncSession],
    user: User,
    tenant_claim: str | None,
    tenants: list[TenantMembershipResponse],
) -> TenantMembershipResponse | None:
    """The workspace the platform operator's claim names, when it is none of
    their own and exists: one they entered on the operator flag alone, which
    `_resolve_tenant_id` binds. None for anyone else."""
    if (
        user.role != "admin"
        or tenant_claim is None
        or any(t.id == tenant_claim for t in tenants)
    ):
        return None
    async with tenant_session(session_factory, tenant_claim) as session:
        tenant = await session.get(Tenant, tenant_claim)
    if tenant is None:
        return None
    return TenantMembershipResponse(
        id=tenant.id,
        slug=tenant.slug,
        name=tenant.name,
        role="admin",
        organization_role=None,
        organization_id=tenant.organization_id,
    )


async def record_operator_entry(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    tenant_id: str,
) -> None:
    """Record the operator entering `tenant_id`, when they hold no role that
    administers it: `platform_access` in the workspace's own audit log, where
    its admins read it."""
    async with tenant_session(session_factory, tenant_id) as session:
        if await user_store.administers_by_role(session, tenant_id, user_id):
            return
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=user_id,
            action=AuditAction.PLATFORM_ACCESS,
            target_type="tenant",
            target_id=tenant_id,
            details={"event": "entered"},
        )
        await session.commit()


async def all_workspaces(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[tuple[Tenant, Organization | None]]:
    """Every workspace on the server, oldest first, with its organization,
    each read on its own short session. For the platform operator's list
    only."""
    found: list[tuple[Tenant, Organization | None]] = []
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            organization = (
                await session.get(Organization, tenant.organization_id)
                if tenant is not None and tenant.organization_id is not None
                else None
            )
        if tenant is not None:
            found.append((tenant, organization))
    return found


async def may_bind_tenant(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    tenant_id: str,
) -> bool:
    """Whether `user_id` may bind `tenant_id`: one of `tenants_bindable_by`,
    or any workspace for the platform operator.

    Backs `POST /tenants/{id}/switch`: the claim it goes on to mint never
    authorises by itself (`_resolve_tenant_id` re-checks it on every request
    regardless), but switching still must not let someone select a tenant
    they may not bind.
    """
    if tenant_id in await tenants_bindable_by(session_factory, user_id):
        return True
    return await _operator_may_enter(session_factory, user_store, user_id, tenant_id)


async def _describe_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    tenant_ids: list[str],
) -> list[TenantMembershipResponse]:
    """Name and role for each of `tenant_ids`, as the caller holds them.

    Takes the ids rather than looking them up so the one caller that already
    has them — `_resolve_tenant_id`, which reads them to decide the case it is
    in — does not ask the exemption a second question it already knows the
    answer to.

    Never holds two connections at once: each tenant is read on its own short
    `tenant_session`, opened and closed before the next one starts. A request
    reaching this has no other session open — `get_current_user` is exactly
    what this exists to run *before* — so nothing here needs the guarantee,
    but the shape is worth keeping anyway: looping bound sessions from inside
    a request that already holds one is the mistake this design explicitly
    rejects.
    """
    memberships: list[TenantMembershipResponse] = []
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            role = await user_store.effective_tenant_role(session, tenant_id, user_id)
            organization_role = await user_store.organization_role(
                session, tenant_id, user_id
            )
        if tenant is None or role is None:
            # tenants_bindable_by just said this user may bind this tenant;
            # either read failing to confirm it a moment later is a genuine
            # race (removed between the two calls), not a bug to paper over by
            # including a tenant we can no longer describe.
            logger.warning(
                "tenants_bindable_by named tenant %s for user %s, but it or the "
                "role there was gone by the time it was read",
                tenant_id,
                user_id,
            )
            continue
        memberships.append(
            TenantMembershipResponse(
                id=tenant.id,
                slug=tenant.slug,
                name=tenant.name,
                role=role,
                organization_role=organization_role,
                organization_id=tenant.organization_id,
            )
        )
    return memberships


async def list_tenant_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> list[TenantMembershipResponse]:
    """Every tenant `user_id` belongs to: id, slug, name, and their role in it.

    Backs `GET /tenants`. `_resolve_tenant_id` builds the same list for the
    409 it raises — the same question asked at a different moment
    (`docs/old/multi-tenancy-phase2-tenants.md`, §7) — but goes straight to
    `_describe_memberships` with ids it has already read.
    """
    return await _describe_memberships(
        session_factory,
        user_store,
        user_id,
        await tenants_bindable_by(session_factory, user_id),
    )


async def initial_tenant_claim(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user: User,
) -> str | None:
    """The tenant a freshly signed-in session should select, if one is
    unambiguous: the workspace the user last selected, while they still
    belong to it; otherwise their only workspace; otherwise none.

    A null claim would ask a person with two workspaces to choose again on
    every visit. This stays a selection, not a
    grant — `_resolve_tenant_id` re-checks the claim on every request — and it
    is checked against current memberships here too, so signing in again is
    still how a session whose workspace was taken away recovers.
    """
    memberships = await tenants_bindable_by(session_factory, user.id)
    last = user_store.last_tenant_id(user)
    if last is not None and last in memberships:
        return last
    if len(memberships) == 1:
        return memberships[0]
    return None


async def rebind_if_left(
    request: Request,
    response: Response,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user: User,
    config: SwitchConfig,
) -> None:
    """After the caller changed their own membership: when the workspace the
    session is bound to is no longer one they may enter, re-mint the session
    onto the one `initial_tenant_claim` picks, or none, as deleting a
    workspace does, rather than leave it naming one they left. A re-mint, so
    it keeps the session's sign-in time (`session_auth_time`)."""
    if require_tenant_id() in await tenants_bindable_by(session_factory, user.id):
        return
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        await initial_tenant_claim(session_factory, user_store, user),
        session_auth_time(request),
    )


def workspace_creation_refusal(
    config: SwitchConfig,
    *,
    is_operator: bool,
    workspaces_created: int,
    new_organization: bool,
) -> str | None:
    """Why this caller may not create a workspace, or None if they may.

    Operators always may. Otherwise every mode allows
    `gateway_max_workspaces_per_user` creations over a person's lifetime —
    each workspace is work for every per-tenant sweep
    (`docs/old/multi-tenancy-phase2-tenants.md`, §5) — and `invite_only`
    sign-up refuses a `new_organization` outright. It decides who comes onto
    the server, not what an organization's `org_admin` adds to theirs.
    Returned as a message rather than raised so `GET /auth/session` can report
    the same answer `POST /organizations` enforces.
    """
    if is_operator:
        return None
    if new_organization and config.gateway_signup_mode == "invite_only":
        return (
            "Creating organizations is turned off here. Ask a "
            "workspace admin for an invitation."
        )
    limit = config.gateway_max_workspaces_per_user
    if limit == 0:
        return "Workspace creation is disabled on this deployment"
    if workspaces_created >= limit:
        return (
            f"You have created {workspaces_created} workspaces, and "
            f"this deployment allows {limit}"
        )
    return None


def describe_session_state(
    config: SwitchConfig,
    user: User,
    tenant_claim: str | None,
    tenants: list[TenantMembershipResponse],
    operator_entered: TenantMembershipResponse | None,
    tenants_isolated: bool,
) -> SessionStateResponse:
    """What `_resolve_tenant_id` would make of this session, as data.

    Follows its order exactly — a claim is honoured only if it names one of
    `tenants`, or is the workspace the platform operator entered
    (`operator_entered`, which `_resolve_tenant_id` binds on
    `_operator_may_enter`), and a bad claim is *not* rescued by a sole
    membership — so a client told "ready" is never refused by the next
    request, and one told otherwise knows which of `/tenants/{id}/switch`,
    `POST /organizations` or `/invitations/accept` gets it unstuck.
    """
    tenant: TenantMembershipResponse | None = None
    if tenant_claim is not None:
        tenant = next((t for t in tenants if t.id == tenant_claim), None)
        if tenant is None and operator_entered is not None:
            tenant = operator_entered if operator_entered.id == tenant_claim else None
    elif len(tenants) == 1:
        tenant = tenants[0]

    if tenant is not None:
        state: Literal["ready", "needs_selection", "needs_workspace"] = "ready"
    elif tenants:
        state = "needs_selection"
    else:
        state = "needs_workspace"

    is_operator = user.role == "admin"

    def refusal(new_organization: bool) -> str | None:
        return workspace_creation_refusal(
            config,
            is_operator=is_operator,
            workspaces_created=user.workspaces_created,
            new_organization=new_organization,
        )

    return SessionStateResponse(
        user=SessionStateUser(
            id=user.id, name=user.name, email=user.email, is_operator=is_operator
        ),
        tenant=tenant,
        tenants=tenants,
        state=state,
        # A deployment that is not isolating tenants keeps to the one it has,
        # for operators too: creating would refuse any name.
        can_create_workspace=tenants_isolated and refusal(True) is None,
        can_add_workspace=tenants_isolated
        and tenant is not None
        and tenant.organization_role == ORGANIZATION_ADMIN_ROLE
        and refusal(False) is None,
        invite_email_enabled=config.invite_email_enabled,
    )


async def _resolve_tenant_id(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    tenant_claim: str | None,
    choice_enabled: bool,
) -> str:
    """Which tenant a request binds, in the order set out in
    `docs/old/multi-tenancy-phase2-tenants.md`, §4:

    "Membership" below is any tenant the caller may bind
    (`tenants_bindable_by`): one they hold a membership row in, or one their
    organization's `org_admin` role covers.

    1. A claim naming a tenant the caller belongs to → bind it.
    2. A claim naming a tenant the caller does not belong to → 403
       `tenant_selection_invalid`. The caller can fix this unaided — `GET
       /tenants` and `POST /tenants/{id}/switch` both authenticate without
       binding a tenant, and signing in again selects only from current
       memberships — so the message says so rather than sending them to an
       administrator. It is not a rare state either: removing a member puts
       everyone it touches here on their next request.

       The cookie is not cleared here: it is `lax`, so a cross-site
       navigation can reach this path, and any page resetting someone's
       selection on a stale or forged claim would be a worse failure than
       answering 403 and leaving the session alone. Clearing belongs on a
       dedicated endpoint.
    3. No claim, exactly one membership → bind it. Every session issued before
       this change, and every single-workspace account forever, lands here.
    4. No claim, several memberships → 409 `tenant_selection_required`
       carrying the choices, gated on `choice_enabled` because it is a
       breaking change for a client that has never had to handle it. Off,
       this falls through to the same 403 as case 5 — the exact behaviour
       every account had before this change, since two memberships did not
       exist for anyone to reach it.
    5. No memberships → 403 `tenant_membership_unresolved`, the one of the
       three the caller genuinely cannot resolve alone.

    `tenants_bindable_by` is read once and used for every case below it,
    including the 409's body, so this is the same two lookups regardless of
    which case answers.

    It also stands in for the account check: a `tenant_members` or
    `organization_members` row references its `users` row, so a caller with a
    membership exists. Only with none is
    `users` asked, so a deleted account still gets 401 rather than a 403.
    """
    memberships = await tenants_bindable_by(session_factory, user_id)
    if not memberships:
        await _require_user_exists(session_factory, user_store, user_id)

    if tenant_claim is not None:
        if tenant_claim in memberships:
            return tenant_claim
        if await _operator_may_enter(
            session_factory, user_store, user_id, tenant_claim
        ):
            return tenant_claim
        logger.warning(
            "Tenant claim %s for user %s names no membership", tenant_claim, user_id
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": TENANT_SELECTION_INVALID,
                "message": (
                    "The workspace selected on this session is not one you "
                    "belong to. Choose another, or sign in again."
                ),
            },
        )

    if len(memberships) == 1:
        return memberships[0]

    if len(memberships) > 1 and choice_enabled:
        choices = await _describe_memberships(
            session_factory, user_store, user_id, memberships
        )
        raise HTTPException(
            status_code=409,
            detail={
                "error": TENANT_SELECTION_REQUIRED,
                "tenants": [choice.model_dump() for choice in choices],
            },
        )

    logger.error(
        "Cannot resolve a tenant for user %s: %d memberships and no selection",
        user_id,
        len(memberships),
    )
    raise HTTPException(
        status_code=403,
        detail={
            "error": TENANT_MEMBERSHIP_UNRESOLVED,
            "message": (
                "This account is not a member of exactly one workspace; "
                "ask an administrator to check its membership."
            ),
        },
    )


@asynccontextmanager
async def _bound_user(
    request: Request,
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> AsyncIterator[User]:
    payload = _session_claims(request, config)
    user_id = payload["sub"]
    tenant_claim = payload.get("tenant_id")

    tenant_id = await _resolve_tenant_id(
        session_factory,
        user_store,
        user_id,
        tenant_claim,
        config.gateway_tenant_choice_enabled,
    )
    request.state.tenant_id = tenant_id

    with tenant_scope(tenant_id), log_context(user_id=user_id, tenant_id=tenant_id):
        user = await user_store.get(session, user_id)
        if user is None:
            # Deleted between the two reads; rare, and still not a 500.
            raise HTTPException(status_code=401, detail="User not found")
        _refuse_ended_session(user.session_version, payload)
        request.state.platform_access = (
            user.role == "admin"
            and not await user_store.administers_by_role(session, tenant_id, user_id)
        )
        if request.state.platform_access and request.method not in _SAFE_METHODS:
            route = request.scope.get("route")
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=user_id,
                action=AuditAction.PLATFORM_ACCESS,
                target_type="tenant",
                target_id=tenant_id,
                details={
                    "event": "write",
                    "method": request.method,
                    "route": getattr(route, "path", request.url.path),
                },
            )
            # Committed before the route runs, so the attempt is recorded
            # whether or not the write succeeds.
            await session.commit()
        yield user


@dataclass(frozen=True)
class SocketCaller:
    """Who opened a gateway WebSocket, and the tenant their session binds."""

    user_id: str
    tenant_id: str
    # When the session cookie the socket was opened with expires, as a UNIX
    # time: the socket is closed then, and the client opens it again with the
    # cookie it has renewed meanwhile.
    expires_at: float
    # The `users.session_version` the cookie was minted with, checked again
    # while the socket is open (`session_is_current`).
    session_version: int


async def authenticate_socket(
    connection: HTTPConnection,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> SocketCaller:
    """`get_current_user`'s checks for a WebSocket, which has no request
    session to load the user on and must not keep one for its lifetime.

    The cookie, the account and the tenant resolution are exactly
    `get_current_user`'s, each on a short session of its own that is closed
    before this returns. Raises the same `HTTPException`s.
    """
    payload = _session_claims(connection, config)
    user_id: str = payload["sub"]
    await _require_current_session(session_factory, user_store, payload)
    tenant_id = await _resolve_tenant_id(
        session_factory,
        user_store,
        user_id,
        payload.get("tenant_id"),
        config.gateway_tenant_choice_enabled,
    )
    return SocketCaller(
        user_id=user_id,
        tenant_id=tenant_id,
        expires_at=float(payload["exp"]),
        session_version=_session_version(payload),
    )


async def get_current_user(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> AsyncIterator[User]:
    """Authenticate the caller, bind their tenant, and load them on the
    request's own session.

    The order is the whole design. Resolving the tenant needs only the user id
    the JWT already carries, so it happens first, on a separate short-lived
    session (`_resolve_tenant_id`) that is closed before this one is touched.
    Only then is the tenant bound and the `User` read — from `get_session`,
    the same session FastAPI hands the endpoint, so an endpoint that mutates
    this object and commits that session persists the change. Loading it from
    anywhere else silently discards writes.

    The resolved tenant is stamped on `request.state` so `/auth/refresh` can
    re-mint the cookie carrying it forward — the one mint that has no other
    way to learn which tenant this session had selected.
    """
    async with _bound_user(
        request, session, session_factory, user_store, config
    ) as user:
        # Return the auth read's connection before an endpoint borrows another
        # session or waits on external I/O. expire_on_commit=False keeps this
        # User attached and readable; endpoint mutations still commit normally.
        await session.commit()
        yield user


async def get_current_user_in_transaction(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> AsyncIterator[User]:
    """`get_current_user`, with the user read's transaction left open.

    For a hot endpoint whose next step is one more read on the same session,
    and which ends the transaction itself before it waits on anything: the
    read then shares the transaction and connection checkout instead of
    opening its own. Every check is `get_current_user`'s.
    """
    async with _bound_user(
        request, session, session_factory, user_store, config
    ) as user:
        yield user


async def require_admin(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    """Raise 403 unless `user` is a deployment operator.

    ``User.role == "admin"`` is deliberately global and deliberately not
    self-service: it names the person who runs the server, not a role any
    tenant can grant. Gate deployment-wide actions on this — creating or
    listing every user in the deployment — never a single tenant's resources.
    Those use ``require_tenant_admin``.
    """
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def get_tenant_is_admin(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> bool:
    """Whether `user` may administer the tenant this request is bound to.

    This is the boolean every ``Principal.is_admin`` in a gateway request
    should be built from — see ``UserStore.administers`` for what it actually
    checks.

    Ends the read's transaction before returning, the way `get_current_user`
    does, so the connection is back in the pool before the route body runs. A
    route that went on to open a second session, or to call a messaging
    platform, would otherwise do it holding this one. So it must not be called
    on a session with writes pending.
    """
    is_admin = await user_store.administers(session, user)
    await session.commit()
    return is_admin


async def require_tenant_admin(
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> User:
    """Raise 403 unless `user` may administer the tenant this request is bound to.

    Unlike ``require_admin``, this is granted by ``tenant_members.role`` as
    well as the operator bit — use it for routes that manage one tenant's
    resources (a collaboration bridge, a room) rather than the deployment
    itself.
    """
    if not is_admin:
        raise HTTPException(status_code=403, detail="Tenant admin access required")
    return user


async def require_room_access(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    action: RoomAction,
    is_admin: bool,
    *,
    owns_target: bool = False,
) -> Room:
    """Load a room (404 if missing) and authorize `action` for `user` by the
    room policy (`room_policy`), raising HTTP 403 with its reason if denied.

    Shared chokepoint for gateway routers that act on a room they receive by
    id (attaching references, linking rooms, …) so they cannot operate on a
    room the caller lacks access to.

    `is_admin` comes from ``get_tenant_is_admin``; it is a parameter rather
    than a read of its own so that a route cannot end up authorizing against
    a different admin bit than the one its own dependencies resolved. A
    workspace admin is in the owner tier of every room in their workspace,
    private ones included.
    """
    return await authorize_room(
        session,
        room_store,
        room_id,
        Principal(user.id, is_admin),
        action,
        owns_target=owns_target,
    )


async def authorize_room(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    principal: Principal,
    action: RoomAction,
    *,
    owns_target: bool = False,
) -> Room:
    """`require_room_access` for a caller who already holds a `Principal`: the
    one place a room's access rule is applied, for every gateway route."""
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    await ensure_room_action(
        session, room_store, room, principal, action, owns_target=owns_target
    )
    return room


async def ensure_room_action(
    session: AsyncSession,
    room_store: RoomStore,
    room: Room,
    principal: Principal,
    action: RoomAction,
    *,
    owns_target: bool = False,
) -> None:
    """Raise HTTP 403 with the policy's reason unless `principal` may do
    `action` to `room`."""
    decision = await decide_room_action(
        session, room_store, room, principal, action, owns_target=owns_target
    )
    if not decision.allowed:
        raise HTTPException(status_code=403, detail=decision.reason)


async def decide_room_action(
    session: AsyncSession,
    room_store: RoomStore,
    room: Room,
    principal: Principal,
    action: RoomAction,
    *,
    owns_target: bool = False,
) -> RoomDecision:
    """`room_policy.decide` for a gateway caller. Whether they are in the room,
    and one of its room admins, is asked only when the answer could change the
    outcome."""
    outside = room_policy.decide(
        RoomCaller(principal, in_room=False), room, action, owns_target=owns_target
    )
    if outside.allowed:
        return outside
    where = await room_admins.standing(session, room_store, room.id, principal.id)
    if not where.in_room:
        return outside
    return room_policy.decide(
        RoomCaller(principal, in_room=True, room_admin=where.room_admin),
        room,
        action,
        owns_target=owns_target,
    )


async def require_room_unlink(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    is_admin: bool,
    *,
    owns_target: bool,
) -> Room:
    """Load a room and authorize unlinking a reference, document or package
    from it: raise HTTP 403 unless `user` is its owner or a tenant admin, or
    owns what is unlinked and is in the room. `owns_target` is whether `user`
    owns it."""
    return await require_room_access(
        session, room_store, room_id, user, "unlink", is_admin, owns_target=owns_target
    )


async def takes_part_in_room(
    session: AsyncSession, room_store: RoomStore, room_id: str, user_id: str | None
) -> bool:
    """Whether the user owns the room, is in it (in Switch Console or through a
    platform account they claimed), or owns an agent in it. A caller with no
    user (an agent nobody owns) takes part in nothing."""
    if user_id is None:
        return False
    return bool(await room_store.involved_room_ids(session, user_id, [room_id]))


async def readable_room_ids(
    session: AsyncSession, room_store: RoomStore, user: User, is_admin: bool
) -> set[str]:
    """Ids of every room `user` may read, archived ones included.

    For endpoints that list rooms reached through something else (a document,
    a package, a reference) so they do not name rooms the caller cannot see.
    """
    rooms = await room_store.list_readable(
        session, user.id, is_admin=is_admin, include_archived=True
    )
    return {r.id for r in rooms}


def require_group_filing_or_403(is_admin: bool) -> None:
    """`authz.require_group_filing` as HTTP 403, for gateway routes."""
    try:
        require_group_filing(is_admin)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
