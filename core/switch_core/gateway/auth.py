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
from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import tenants_of_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
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


def create_jwt(user_id: str, email: str, role: str, secret_key: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "exp": datetime.datetime.now(datetime.UTC)
        + datetime.timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.datetime.now(datetime.UTC),
    }
    return jwt.encode(payload, secret_key, algorithm=JWT_ALGORITHM)


def set_session_cookie(
    response: Response, user: User, secret_key: str, secure: bool
) -> None:
    """Mint the switch_auth session cookie for an authenticated user.

    Shared by password login and the OIDC callback so the session contract
    stays identical regardless of how the user proved their identity.

    `secure` gates the Secure flag: True on HTTPS deployments so the JWT is
    never sent over plain HTTP, False for local dev served over http://.
    """
    token = create_jwt(user.id, user.email, user.role, secret_key)
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


class TenantMembershipError(Exception):
    """A user has zero, or more than one, tenant memberships.

    Phase 1 has exactly one tenant, so exactly one membership row is the only
    correct state: zero means the user was never enrolled (a bug in whatever
    created the account), and more than one is Phase 2's tenant-switching
    shape arriving early. Either way this must not be resolved by picking
    one — see `docs/old/multi-tenancy-phase1-db.md`, "Setting the tenant".

    Raised, not returned, but not left to reach the client either:
    `get_current_user` below turns it into a 403 naming no user id, so a
    broken account gets an answer an operator can act on instead of a bare
    500.
    """


async def sole_tenant_id(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> str:
    """The one tenant this user belongs to, raising if that isn't true.

    Here rather than on a store, and that placement is the point. This is the
    only caller there has ever been, and it is an authentication step: the
    JWT names a person, and a person is global (`users` carries no tenant),
    so something has to turn "who" into "which tenant" before a scoped session
    can exist at all.

    It goes through `tenants_of_user`, one of the seven `SECURITY DEFINER`
    lookups that make up the whole exemption from row-level security
    (`db/tenant_lookup.py`), which opens a session of its own with nothing
    bound and answers with tenant ids and nothing else. `tenant_members` is a
    scoped table, so a session cannot read the row that would tell it what to
    be scoped to; a plain `select` here worked only because every environment
    once connected as the tables' owner, and under the restricted runtime role
    it is one of the reads the policy refuses.

    That is also why this is a function and not an injected dependency. It
    reaches the exemption with an arbitrary user id, and as a store on the
    dependency graph any endpoint could declare it and do the same. The
    exemption's audit surface is the list of modules that import a lookup
    (`tests/switch_core/db/test_tenant_exemption_allowlist.py`), and a
    reachable-from-anywhere wrapper made that list say less than it looked
    like it said.

    Refusing rather than picking, on both sides of "exactly one": zero
    memberships is an account that was never enrolled, and two is a decision
    about which tenant's data the caller is about to see. Neither is a thing
    to guess at. Membership is written by exactly one function,
    `UserStore.ensure_membership`, which is idempotent and derives the role
    from the user — so "every account has exactly one" holds by construction
    rather than by every writer remembering, and a second, unguarded way to
    write one is how an account ends up with two.
    """
    tenant_ids = await tenants_of_user(session_factory, user_id)
    if len(tenant_ids) != 1:
        raise TenantMembershipError(
            f"user {user_id} has {len(tenant_ids)} tenant memberships; expected exactly 1"
        )
    return tenant_ids[0]


async def _resolve_tenant_id(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> str:
    """Which tenant the JWT's subject belongs to, before one is bound.

    Two reads, and they are unbound for different reasons. `users` carries no
    tenant at all — a person is not a tenant member — so the existence check
    is an ordinary read on a session with nothing bound. The membership read
    is not: `tenant_members` is scoped, and this is the lookup that decides
    what to scope to, so it goes through the `SECURITY DEFINER` exemption
    (`db/tenant_lookup.py`) rather than through a session the policy would
    refuse.

    Both are short-lived on purpose. Held as a yield dependency instead, they
    would keep a second pooled connection — idle in transaction, since the
    lookup autobegins one nothing ever ends — for the whole request, halving
    effective pool capacity.

    Nothing loaded here escapes: the caller re-reads the `User` from the
    request's own session, so the object an endpoint mutates belongs to the
    session that endpoint commits.
    """
    async with session_factory() as system_session:
        if not await user_store.exists(system_session, user_id):
            raise HTTPException(status_code=401, detail="User not found")
    try:
        return await sole_tenant_id(session_factory, user_id)
    except TenantMembershipError as exc:
        # Phase 1 has exactly one tenant, so anything but one membership is a
        # provisioning bug, not a credential problem — but the caller still
        # deserves a legible answer instead of an opaque 500. The detail names
        # no user id: it is rendered to whoever is holding the cookie, not to
        # the operator, who gets the id from the log.
        logger.error("Cannot resolve a tenant for user %s: %s", user_id, exc)
        raise HTTPException(
            status_code=403,
            detail=(
                "This account is not a member of exactly one tenant; "
                "ask an administrator to check its membership."
            ),
        ) from exc


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
    """
    token = request.cookies.get("switch_auth")
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_jwt(token, config.jwt_secret_key)
    user_id = payload["sub"]

    tenant_id = await _resolve_tenant_id(session_factory, user_store, user_id)

    with tenant_scope(tenant_id), log_context(user_id=user_id, tenant_id=tenant_id):
        user = await user_store.get(session, user_id)
        if user is None:
            # Deleted between the two reads; rare, and still not a 500.
            raise HTTPException(status_code=401, detail="User not found")
        yield user


async def require_admin(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
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
    try:
        require(Principal(user.id, user.role == "admin"), action, room)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    return room
