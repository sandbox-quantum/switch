from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineConflict,
    claim_conflict,
    owner_stopped,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import (
    AuthenticatedSession,
    describe_session_state,
    get_authenticated_session,
    get_current_user,
    hash_password_off_loop,
    initial_tenant_claim,
    list_tenant_memberships,
    require_admin,
    set_session_cookie,
    verify_password_off_loop,
)
from switch_core.gateway.dependencies import (
    get_bridge_store,
    get_config,
    get_external_user_store,
    get_session,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.hosted_launches import hosted_settings
from switch_core.gateway.hosted_machines import MachineUnavailable, ensure_machine
from switch_core.gateway.schemas import (
    AuthConfigResponse,
    ChangePasswordRequest,
    CreateUserRequest,
    LinkedIdentity,
    LoginRequest,
    ServerDeclaration,
    SessionStateResponse,
    SessionUserResponse,
    SignupMachine,
    SignupRequest,
    SignupResponse,
    UserResponse,
)
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import tenant_scope
from switch_core.version import server_declaration

logger = logging.getLogger(__name__)

router = APIRouter()

MACHINE_OWNER_STOPPED = "Your cloud machine is stopped. Start it in Switch Console."


def _gateway_declaration() -> ServerDeclaration:
    return ServerDeclaration.model_validate(server_declaration("gateway-api"))


def _session_response(user: User) -> SessionUserResponse:
    """An authenticated session, carrying what the server is (CHOO-1865).

    Every response that establishes or confirms a session says so, which means
    a client learns the server's ranges on the call it already makes. The
    authentication surface is frozen and excluded from `gateway-api`, so this
    is the one path that cannot itself be the thing that broke.
    """
    return SessionUserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        created_at=str(user.created_at),
        server=_gateway_declaration(),
    )


@router.get("/version")
async def get_version(
    _user: Annotated[User, Depends(get_current_user)],
) -> ServerDeclaration:
    """What this switch-core is, and what it speaks to first-party UI clients.

    Authenticated, and scoped to this credential: a gateway session sees
    `gateway-api` and nothing else. `db-schema` is internal to switch-core and
    appears in no externally facing response at all.

    Diagnostics only — a client already receives this on every session
    response, so it never needs an extra call to stay informed.
    """
    return _gateway_declaration()


@router.post("/auth/login")
async def login(
    req: LoginRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> SessionUserResponse:
    # `get_system_session`, not `get_session`: there is no caller to take a
    # tenant from until this route decides there is one. It only ever reads
    # `users`, which is global (a person is one account across tenants), so
    # there is nothing here a tenant would scope. Which workspace the new
    # session selects comes from the membership lookup, on a session of its own.
    if not config.gateway_password_login_enabled:
        raise HTTPException(status_code=403, detail="Password login is disabled")

    user = await user_store.get_by_email(session, req.email)
    # One connection at a time, and none held across bcrypt.
    await session.commit()
    if user is None or not await verify_password_off_loop(
        req.password, user.password_hash
    ):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        await initial_tenant_claim(session_factory, user_store, user),
    )
    return _session_response(user)


async def _prewarm(
    session: AsyncSession,
    user_id: str,
    config: SwitchConfig,
    settings: HostedControllerSettings | None,
) -> SignupMachine:
    try:
        machine = await ensure_machine(session, user_id, config, settings)
    except (MachineUnavailable, HostedMachineConflict) as error:
        await session.rollback()
        logger.warning(
            "Signed-up user %s has no cloud machine warming: %s", user_id, error
        )
        return SignupMachine(status="unavailable", reason=str(error))
    await session.commit()
    if (conflict := claim_conflict(machine, datetime.now(UTC))) is not None:
        return SignupMachine(status="unavailable", reason=conflict)
    if owner_stopped(machine):
        return SignupMachine(status="unavailable", reason=MACHINE_OWNER_STOPPED)
    return SignupMachine(status="starting", reason=None)


async def _refuse_signup(
    session: AsyncSession, user_store: UserStore, email: str, config: SwitchConfig
) -> None:
    """Raise if this sign-up must be refused: the hourly cap is reached, or the
    email is taken. Rolls back before raising, so a refusal never leaves the
    transaction, or an advisory lock taken in it, open."""
    created, retry_after = await user_store.created_in_last_hour(session)
    if created >= config.gateway_signup_max_per_hour:
        logger.warning(
            "Refused sign-up: %d users created in the last hour (cap %d)",
            created,
            config.gateway_signup_max_per_hour,
        )
        await session.rollback()
        raise HTTPException(
            status_code=429,
            detail="Too many sign-ups on this server in the last hour. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    if await user_store.get_by_email(session, email) is not None:
        await session.rollback()
        raise HTTPException(status_code=409, detail="Email already registered")


@router.post("/auth/signup", status_code=201)
async def signup(
    req: SignupRequest,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings | None, Depends(hosted_settings)],
) -> SignupResponse:
    """Open self sign-up: a new member of tenant zero, signed in, machine warming.

    No caller exists yet to take a tenant from, so the account lands in tenant
    zero by name, exactly as an OIDC first sign-in does. The cloud machine is
    claimed after the account is committed and failing to claim one never
    fails the sign-up: the response says why instead.
    """
    if not config.gateway_signup_open:
        raise HTTPException(
            status_code=403, detail="Sign-up is disabled on this server"
        )

    with tenant_scope(TENANT_ZERO_ID):
        # Checked before the hash so a refusal stays cheap, and again under the
        # lock after it; neither the lock nor a connection is held across bcrypt.
        await _refuse_signup(session, user_store, req.email, config)
        await session.rollback()
        password_hash = await hash_password_off_loop(req.password)

        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "gateway-signup"},
        )
        await _refuse_signup(session, user_store, req.email, config)
        user = User(
            name=req.display_name or req.email.split("@")[0],
            email=req.email,
            role="user",
            password_hash=password_hash,
        )
        try:
            async with session.begin_nested():
                await user_store.create(session, user)
        except IntegrityError:
            await session.rollback()
            raise HTTPException(
                status_code=409, detail="Email already registered"
            ) from None
        await session.commit()
        logger.info("Signed up user: %s (%s)", user.email, user.id)

        set_session_cookie(
            response,
            user,
            config.keyring,
            config.gateway_cookie_secure,
            TENANT_ZERO_ID,
        )
        signed_in = _session_response(user)
        machine = await _prewarm(session, user.id, config, settings)
    return SignupResponse(**signed_in.model_dump(), machine=machine)


@router.post("/auth/refresh")
async def refresh(
    request: Request,
    response: Response,
    user: Annotated[User, Depends(get_current_user)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> SessionUserResponse:
    # Re-mint the switch_auth cookie from the still-valid session so an active
    # client renews before expiry without re-authenticating — provider-agnostic
    # (works for password and OIDC users alike, since it re-issues from the User
    # rather than replaying either login flow). get_current_user rejects a
    # missing/expired/invalid cookie with 401, so an expired session cannot renew
    # itself; the client falls back to interactive sign-in in that case.
    #
    # `request.state.tenant_id` is what get_current_user just resolved this
    # request to — carrying it forward is the whole point: re-minting from
    # `user` alone would drop whatever tenant this session had selected.
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        request.state.tenant_id,
    )
    return _session_response(user)


@router.post("/auth/logout")
async def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


@router.get("/auth/config")
async def auth_config(
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> AuthConfigResponse:
    # Unauthenticated on purpose: the login page reads this before any session
    # exists to decide which login methods to offer.
    return AuthConfigResponse(
        password_login_enabled=config.gateway_password_login_enabled,
        signup_enabled=config.gateway_signup_open,
        oidc_enabled=config.gateway_oidc_enabled,
        oidc_provider_label=config.gateway_oidc_provider_label,
        signup_mode=config.gateway_signup_mode,
    )


@router.get("/auth/session")
async def session_state(
    auth: Annotated[AuthenticatedSession, Depends(get_authenticated_session)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> SessionStateResponse:
    """Who is signed in, which workspace this session is in, and — when it
    is in none — what would get it into one.

    Answers for every signed-in caller, including the ones `/auth/me` refuses:
    someone with no workspace yet, or with several and none selected. That is
    exactly who a client needs to ask, which is why this reports what tenant
    resolution would decide (`describe_session_state`) instead of depending on
    `get_current_user`, which raises for them.
    """
    user = await user_store.get(session, auth.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    # One connection at a time: release this one before the lookup opens its own.
    await session.commit()
    tenants = await list_tenant_memberships(session_factory, user_store, user.id)
    return describe_session_state(config, user, auth.tenant_claim, tenants)


@router.get("/auth/me")
async def me(
    user: Annotated[User, Depends(get_current_user)],
) -> SessionUserResponse:
    return _session_response(user)


@router.get("/auth/me/identities")
async def my_identities(
    session: Annotated[AsyncSession, Depends(get_session)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[LinkedIdentity]:
    """The messaging-app accounts this user has claimed (CHOO-2137).

    An owner-only agent is only reachable by its owner over a bridge that
    appears in this list, so Switch Console reads it to warn when an agent has
    been sealed on a platform where its owner cannot be recognised.
    """
    identities = await external_user_store.get_by_user(session, user.id)
    linked: list[LinkedIdentity] = []
    for identity in identities:
        bridge = await bridge_store.get(session, identity.bridge_id)
        if bridge is None:
            continue
        linked.append(
            LinkedIdentity(
                id=identity.id,
                bridge_id=identity.bridge_id,
                bridge_display_name=bridge.display_name,
                bridge_type=bridge.type,
                external_user_id=identity.external_user_id,
                external_username=identity.external_username,
            )
        )
    return linked


@router.put("/auth/me/password")
async def change_password(
    req: ChangePasswordRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    if not await verify_password_off_loop(req.current_password, user.password_hash):
        raise HTTPException(status_code=403, detail="Current password is incorrect")

    user.password_hash = await hash_password_off_loop(req.new_password)
    await session.commit()
    return {"ok": True}


@router.get("/users")
async def list_users(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _admin: Annotated[User, Depends(require_admin)],
) -> list[UserResponse]:
    users = await user_store.get_all(session)
    return [
        UserResponse(
            id=u.id,
            name=u.name,
            email=u.email,
            role=u.role,
            created_at=str(u.created_at),
        )
        for u in users
    ]


@router.post("/users")
async def create_user(
    req: CreateUserRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _admin: Annotated[User, Depends(require_admin)],
) -> UserResponse:
    existing = await user_store.get_by_email(session, req.email)
    if existing is not None:
        raise HTTPException(status_code=409, detail="Email already registered")
    # Not held across bcrypt.
    await session.commit()
    password_hash = await hash_password_off_loop(req.password)

    user = User(
        name=req.name,
        email=req.email,
        role=req.role,
        password_hash=password_hash,
    )
    await user_store.create(session, user)
    await session.commit()

    logger.info("Created user: %s (%s)", user.email, user.id)
    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        created_at=str(user.created_at),
    )
