from __future__ import annotations

import datetime
import logging
from collections.abc import AsyncIterator
from typing import Annotated

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import Action, Principal, require
from switch_core.config import SwitchConfig
from switch_core.db.models import Room, Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import tenants_of_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.schemas import TenantMembershipResponse
from switch_core.logging_context import log_context
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24


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


def create_jwt(
    user_id: str, email: str, role: str, secret_key: str, tenant_id: str | None
) -> str:
    """Sign a session JWT. `tenant_id` is the caller's selected tenant, or
    `None` for a session that has not selected one yet (a fresh login, or a
    multi-membership account that has never called `/tenants/{id}/switch`).

    The claim only ever *selects*: `_resolve_tenant_id` re-checks it against a
    live membership row on every request, so a forged or stale value buys
    nothing (`docs/old/multi-tenancy-phase2-tenants.md`, §3).
    """
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "tenant_id": tenant_id,
        "exp": datetime.datetime.now(datetime.UTC)
        + datetime.timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.datetime.now(datetime.UTC),
    }
    return jwt.encode(payload, secret_key, algorithm=JWT_ALGORITHM)


def set_session_cookie(
    response: Response,
    user: User,
    secret_key: str,
    secure: bool,
    tenant_id: str | None,
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
    """
    token = create_jwt(user.id, user.email, user.role, secret_key, tenant_id)
    response.set_cookie(
        key="switch_auth",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=86400,
        path="/",
    )


def decode_jwt(token: str, secret_key: str) -> dict:
    try:
        return jwt.decode(token, secret_key, algorithms=[JWT_ALGORITHM])
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
    token = request.cookies.get("switch_auth")
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_jwt(token, config.jwt_secret_key)
    async with session_factory() as system_session:
        if not await user_store.exists(system_session, payload["sub"]):
            raise HTTPException(status_code=401, detail="User not found")
    return payload


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


async def is_tenant_member(
    session_factory: async_sessionmaker[AsyncSession], user_id: str, tenant_id: str
) -> bool:
    """Whether `user_id` has a membership in `tenant_id`.

    Backs `POST /tenants/{id}/switch`: the claim it goes on to mint never
    authorises by itself (`_resolve_tenant_id` re-checks it on every request
    regardless), but switching still must not let someone select a tenant
    they do not belong to.
    """
    return tenant_id in await tenants_of_user(session_factory, user_id)


async def list_tenant_memberships(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> list[TenantMembershipResponse]:
    """Every tenant `user_id` belongs to: id, slug, name, and their role in it.

    Backs `GET /tenants`, and the body of the 409 `_resolve_tenant_id` raises
    when there is no claim to bind and several memberships to choose from —
    the same question asked at a different moment
    (`docs/old/multi-tenancy-phase2-tenants.md`, §7).

    Never holds two connections at once. `tenants_of_user` is its own
    short session with nothing bound; each tenant after that is read on its
    own short `tenant_session`, opened and closed before the next one starts.
    A request reaching this has no other session open — `get_current_user` is
    exactly what this exists to run *before* — so nothing here needs the
    guarantee, but the shape is worth keeping anyway: looping bound sessions
    from inside a request that already holds one is the mistake this design
    explicitly rejects.
    """
    memberships: list[TenantMembershipResponse] = []
    for tenant_id in await tenants_of_user(session_factory, user_id):
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            role = await user_store.tenant_role(session, tenant_id, user_id)
        if tenant is None or role is None:
            # tenants_of_user just said this tenant has a membership row for
            # this user; either read failing to confirm it a moment later is
            # a genuine race (removed between the two calls), not a bug to
            # paper over by including a tenant we can no longer describe.
            logger.warning(
                "tenants_of_user named tenant %s for user %s, but it or the "
                "membership row was gone by the time it was read",
                tenant_id,
                user_id,
            )
            continue
        memberships.append(
            TenantMembershipResponse(
                id=tenant.id, slug=tenant.slug, name=tenant.name, role=role
            )
        )
    return memberships


async def _resolve_tenant_id(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
    tenant_claim: str | None,
    choice_enabled: bool,
) -> str:
    """Which tenant a request binds, in the order set out in
    `docs/old/multi-tenancy-phase2-tenants.md`, §4:

    1. A claim naming a tenant the caller belongs to → bind it.
    2. A claim naming a tenant the caller does not belong to → 403. The cookie
       is not cleared here: it is `lax`, so a cross-site navigation can reach
       this path, and any page resetting someone's selection on a stale or
       forged claim would be a worse failure than answering 403 and leaving
       the session alone. Clearing belongs on a dedicated endpoint.
    3. No claim, exactly one membership → bind it. Every session issued before
       this change, and every single-workspace account forever, lands here.
    4. No claim, several memberships → the choose-one response, gated on
       `choice_enabled` because it is a breaking change for a client that has
       never had to handle it. Off, this falls through to the same 403 as
       case 5 — the exact behaviour every account had before this change,
       since two memberships did not exist for anyone to reach it.
    5. No memberships → 403.

    `tenants_of_user` is read once and used for every case below it, rather
    than once per case, so this is one round trip to the exemption regardless
    of which case answers.
    """
    memberships = await tenants_of_user(session_factory, user_id)

    if tenant_claim is not None:
        if tenant_claim in memberships:
            return tenant_claim
        logger.warning(
            "Tenant claim %s for user %s names no membership", tenant_claim, user_id
        )
        raise HTTPException(
            status_code=403,
            detail=(
                "This account is not a member of the selected tenant; "
                "ask an administrator to check its membership."
            ),
        )

    if len(memberships) == 1:
        return memberships[0]

    if len(memberships) > 1 and choice_enabled:
        choices = await list_tenant_memberships(session_factory, user_store, user_id)
        raise HTTPException(
            status_code=409,
            detail=[choice.model_dump() for choice in choices],
        )

    logger.error(
        "Cannot resolve a tenant for user %s: %d memberships and no selection",
        user_id,
        len(memberships),
    )
    raise HTTPException(
        status_code=403,
        detail=(
            "This account is not a member of exactly one tenant; "
            "ask an administrator to check its membership."
        ),
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
    payload = await _authenticate(request, session_factory, user_store, config)
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

    Also callable directly (not just as a FastAPI dependency) from any
    handler or service function that already holds a bound `session`, the
    caller's `User`, and a `UserStore`.
    """
    return await user_store.administers(session, user)


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
    action: Action,
) -> Room:
    """Load a room (404 if missing) and authorize `action` for `user`,
    raising HTTP 403 if denied.

    Shared chokepoint for gateway routers that mutate a room they receive by
    id (attaching references, linking rooms, …) so they cannot operate on a
    room the caller lacks access to. Mirrors the protocol layer's
    ``_require_room_action``.
    """
    room = await room_store.get(session, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    is_admin = await UserStore().administers(session, user)
    try:
        require(Principal(user.id, is_admin), action, room)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return room
