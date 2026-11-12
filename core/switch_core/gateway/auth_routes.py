from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.account_reset import AccountReset
from switch_core.accounts.deletion import (
    AccountDeletion,
    AccountDeletionIncomplete,
    AccountDeletionRefused,
    Workspace,
    is_server_administrator,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.resource.service import ResourceService
from switch_core.chats.member_names import rename_member_clients
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import TENANT_ZERO_ID, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineConflict,
    claim_conflict,
    owner_stopped,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore, email_taken
from switch_core.gateway.auth import (
    SIGNUP_REFUSED_DETAIL,
    AuthenticatedCaller,
    AuthenticatedSession,
    describe_session_state,
    get_authenticated_caller,
    get_authenticated_session,
    get_authenticated_user_id,
    get_current_user,
    hash_password_off_loop,
    initial_tenant_claim,
    list_tenant_memberships,
    operator_entered_workspace,
    require_admin,
    session_auth_time,
    set_session_cookie,
    signup_refused_by_edge,
    tenants_bindable_by,
    verify_password_off_loop,
)
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_agent_store,
    get_api_key_store,
    get_bridge_store,
    get_client_lifecycle,
    get_config,
    get_external_user_store,
    get_organization_store,
    get_protocol,
    get_resource_service,
    get_room_service,
    get_session,
    get_session_factory,
    get_system_session,
    get_template_store,
    get_user_store,
)
from switch_core.gateway.hosted_machines import (
    MachineUnavailable,
    ensure_machine,
    hosted_settings,
)
from switch_core.gateway.schemas import (
    AuthConfigResponse,
    ChangePasswordRequest,
    CreateUserRequest,
    DeleteAccountRequest,
    LinkedIdentity,
    LoginRequest,
    OidcLoginOptionView,
    OperatorUserResponse,
    PendingIdentity,
    ServerDeclaration,
    SessionStateResponse,
    SessionUserResponse,
    SignupMachine,
    SignupRequest,
    SignupResponse,
    UpdateMeRequest,
)
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.room_service import RoomService
from switch_core.telemetry import emit_safely
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
        has_password=user.password_hash is not None,
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
        datetime.now(UTC),
    )
    return _session_response(user)


async def _prewarm(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    user_id: str,
    config: SwitchConfig,
    settings: HostedControllerSettings | None,
) -> SignupMachine:
    try:
        machine, _workspace = await ensure_machine(
            session, factory, user_id, config, settings
        )
    except (MachineUnavailable, CloudMachineConflict) as error:
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
        emit_safely(current_telemetry(), "signup_refused", {"reason": "rate_limited"})
        raise HTTPException(
            status_code=429,
            detail="Too many sign-ups in the last hour. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    if await user_store.get_by_email(session, email) is not None:
        await session.rollback()
        emit_safely(current_telemetry(), "signup_refused", {"reason": "email_taken"})
        raise HTTPException(status_code=409, detail="Email already registered")


@router.post("/auth/signup", status_code=201)
async def signup(
    req: SignupRequest,
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
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
        emit_safely(current_telemetry(), "signup_refused", {"reason": "disabled"})
        raise HTTPException(status_code=403, detail="Sign-up is turned off here")
    if signup_refused_by_edge(request, config):
        logger.warning(
            "Refused sign-up: the request is marked as from a country without sign-up"
        )
        emit_safely(current_telemetry(), "signup_refused", {"reason": "country"})
        raise HTTPException(status_code=403, detail=SIGNUP_REFUSED_DETAIL)

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
        except IntegrityError as err:
            if not email_taken(err):
                raise
            await session.rollback()
            emit_safely(
                current_telemetry(), "signup_refused", {"reason": "email_taken"}
            )
            raise HTTPException(
                status_code=409, detail="Email already registered"
            ) from None
        await session.commit()
        logger.info("Signed up user %s", user.id)
        emit_safely(current_telemetry(), "account_created", {"method": "signup"})

        set_session_cookie(
            response,
            user,
            config.keyring,
            config.gateway_cookie_secure,
            TENANT_ZERO_ID,
            datetime.now(UTC),
        )
        signed_in = _session_response(user)
        machine = await _prewarm(session, session_factory, user.id, config, settings)
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
        session_auth_time(request),
    )
    return _session_response(user)


@router.post("/auth/logout")
async def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


@router.post("/auth/sessions/revoke")
async def end_my_sessions(
    response: Response,
    user_id: Annotated[str, Depends(get_authenticated_user_id)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> dict[str, bool]:
    """Sign out of all devices, this one included.

    `/auth/logout` clears only this browser's cookie, so a copy of it, or a
    session left open elsewhere, stays valid until it expires. This moves the
    account's session version on, which every cookie minted before it fails
    against. Needs no workspace selected, like `/tenants/{id}/switch`, so a
    person with several can always reach it.
    """
    await user_store.end_sessions(session, user_id)
    await record_server_audit_event(
        session,
        actor_user_id=user_id,
        action=ServerAuditAction.USER_SESSIONS_ENDED,
        target_type="user",
        target_id=user_id,
        details=None,
    )
    await session.commit()
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
        oidc_login_options=[
            OidcLoginOptionView(id=option.id, label=option.label)
            for option in config.gateway_oidc_login_options
        ],
        oidc_browser_handoff=config.gateway_oidc_enabled,
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
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
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
    entered = await operator_entered_workspace(
        session_factory, user, auth.tenant_claim, tenants
    )
    return describe_session_state(
        config,
        user,
        auth.tenant_claim,
        tenants,
        entered,
        client_lifecycle.tenants_isolated,
    )


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
    been sealed on a platform where its owner cannot be recognised. A link
    still waiting for the account to confirm it is not one of them: see
    `my_pending_identities`.
    """
    linked: list[LinkedIdentity] = []
    for identity, claim in await external_user_store.claims_of_user(session, user.id):
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
                verified=claim.verified_at is not None,
                linked_at=claim.created_at,
            )
        )
    return linked


@router.get("/auth/me/identities/pending")
async def my_pending_identities(
    session: Annotated[AsyncSession, Depends(get_session)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[PendingIdentity]:
    """The messaging-app accounts waiting to confirm a link to this user
    (CHOO-3881), which count for nothing until they do."""
    pending: list[PendingIdentity] = []
    for identity, request in await external_user_store.link_requests_of_user(
        session, user.id
    ):
        bridge = await bridge_store.get(session, identity.bridge_id)
        if bridge is None:
            continue
        requested_by = request.requested_by_user_id
        requester = (
            await user_store.get(session, requested_by)
            if requested_by is not None and requested_by != user.id
            else None
        )
        pending.append(
            PendingIdentity(
                id=identity.id,
                bridge_id=identity.bridge_id,
                bridge_display_name=bridge.display_name,
                bridge_type=bridge.type,
                external_user_id=identity.external_user_id,
                external_username=identity.external_username,
                requested_by_name=requester.name if requester is not None else None,
                code_expires_at=request.code_expires_at,
            )
        )
    return pending


@router.delete("/auth/me")
async def delete_my_account(
    req: DeleteAccountRequest,
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Delete the caller's own account, everywhere on this server.

    Binds no tenant because it acts on every workspace the caller is in, each
    in a `tenant_session` of its own (`accounts/deletion.py`); `session`, with
    nothing bound, carries only the rows that belong to no workspace — the
    `users` row and its sign-in identities. The caller confirms by typing
    their email, since an SSO account has no password to ask for. A refusal
    is a 409 saying what to do first, and leaves the account untouched.
    """
    user = await _confirmed_user(session, user_store, caller, req)
    deletion = _account_deletion(
        request,
        session_factory,
        protocol,
        broker,
        resource_service,
        room_service,
        user_store,
        organization_store,
        agent_store,
        api_key_store,
        template_store,
        client_lifecycle,
        config,
    )
    workspaces = await _workspaces_to_delete(
        deletion, session_factory, user_store, user.id
    )
    reason = await deletion.refusal(session, user, workspaces)
    if reason is not None:
        raise HTTPException(status_code=409, detail=reason)
    try:
        await deletion.delete(session, user, workspaces, actor_id=user.id)
    except AccountDeletionRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused)) from None
    response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


@router.post("/auth/me/reset-test-account")
async def reset_test_account(
    req: DeleteAccountRequest,
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Wipe the caller's own test account, on a test or canary server that
    allows it (`gateway_allow_test_account_reset`): an organization nobody
    else is in is purged whole; elsewhere only the workspaces the caller is
    alone in are purged, and the caller leaves the rest, the server's default
    workspace included (`accounts/account_reset.py`). Refused with a 409,
    before anything changes, for anything `DELETE /auth/me` refuses or the
    purge must wait for."""
    if not config.gateway_allow_test_account_reset:
        raise HTTPException(
            status_code=404, detail="Test-account reset is not enabled on this server."
        )
    user = await _confirmed_user(session, user_store, caller, req)
    deletion = _account_deletion(
        request,
        session_factory,
        protocol,
        broker,
        resource_service,
        room_service,
        user_store,
        organization_store,
        agent_store,
        api_key_store,
        template_store,
        client_lifecycle,
        config,
    )
    reset = AccountReset(
        session_factory=session_factory,
        purge=request.app.state.organization_purge,
        deletion=deletion,
    )
    workspaces = await _workspaces_to_delete(
        deletion, session_factory, user_store, user.id
    )
    try:
        await reset.reset(session, user, workspaces)
    except AccountDeletionRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused)) from None
    response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


async def _confirmed_user(
    session: AsyncSession,
    user_store: UserStore,
    caller: AuthenticatedCaller,
    req: DeleteAccountRequest,
) -> User:
    user = await user_store.get(session, caller.id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    if req.email.strip().lower() != user.email.lower():
        raise HTTPException(
            status_code=400, detail="That email doesn't match this account."
        )
    return user


def _account_deletion(
    request: Request,
    session_factory: async_sessionmaker[AsyncSession],
    protocol: AgentCore,
    broker: ServiceBroker,
    resource_service: ResourceService,
    room_service: RoomService,
    user_store: UserStore,
    organization_store: OrganizationStore,
    agent_store: AgentStore,
    api_key_store: ApiKeyStore,
    template_store: TemplateStore,
    client_lifecycle: ClientLifecycleService,
    config: SwitchConfig,
) -> AccountDeletion:
    return AccountDeletion(
        session_factory=session_factory,
        protocol=protocol,
        # Set by the wiring when agent management runs (`switch_core.main`).
        management=getattr(request.app.state, "controller_revoker", None),
        broker=broker,
        resources=resource_service,
        rooms=room_service,
        sign_in_flows=request.app.state.sign_in_flows,
        users=user_store,
        organizations=organization_store,
        agents=agent_store,
        api_keys=api_key_store,
        templates=template_store,
        clients=client_lifecycle,
        admin_email=config.gateway_admin_email,
    )


async def _workspaces_to_delete(
    deletion: AccountDeletion,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> list[Workspace]:
    memberships = [
        Workspace(id=m.id, name=m.name, role=m.role)
        for m in await list_tenant_memberships(session_factory, user_store, user_id)
    ]
    return await deletion.with_former_workspaces(user_id, memberships)


@router.patch("/auth/me")
async def update_me(
    req: UpdateMeRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> SessionUserResponse:
    """Change the signed-in person's display name.

    Like the password change, this writes the `User` that `get_current_user`
    handed over and commits the session `get_session` handed over, which are
    the same object within a request.
    """
    user.name = req.name
    await session.commit()
    # The name other members see beside what this person writes in a
    # Console chat is their member client's, copied when it was made.
    await rename_member_clients(
        session_factory,
        await tenants_bindable_by(session_factory, user.id),
        user.id,
        req.name,
    )
    return _session_response(user)


@router.put("/auth/me/password")
async def change_password(
    req: ChangePasswordRequest,
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Change the signed-in person's password, signing them out everywhere
    else.

    The database ends every session on a password change
    (`db/session_version_ddl.py`), this one included, so the cookie is
    minted again from the row as it now stands: whoever changed the password
    stays signed in here, and every other copy of the old cookie is refused.
    """
    if not await verify_password_off_loop(req.current_password, user.password_hash):
        raise HTTPException(status_code=403, detail="Current password is incorrect")

    user.password_hash = await hash_password_off_loop(req.new_password)
    await session.commit()
    await session.refresh(user)
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        request.state.tenant_id,
        session_auth_time(request),
    )
    return {"ok": True}


@router.get("/users")
async def list_users(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    admin: Annotated[User, Depends(require_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> list[OperatorUserResponse]:
    admin_id = admin.id
    users = await user_store.get_all(session)
    return [
        OperatorUserResponse(
            id=u.id,
            name=u.name,
            email=u.email,
            role=u.role,
            created_at=str(u.created_at),
            can_delete=u.id != admin_id
            and not is_server_administrator(u, config.gateway_admin_email),
        )
        for u in users
    ]


@router.post("/users")
async def create_user(
    req: CreateUserRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    _admin: Annotated[User, Depends(require_admin)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> OperatorUserResponse:
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
    # The check above ran before bcrypt, so a concurrent request for the same
    # address can have inserted since; the unique constraint is what decides.
    try:
        async with session.begin_nested():
            await user_store.create(session, user)
    except IntegrityError as err:
        if not email_taken(err):
            raise
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="Email already registered"
        ) from None
    await session.commit()

    logger.info("Created user %s", user.id)
    emit_safely(current_telemetry(), "account_created", {"method": "admin"})
    return OperatorUserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        created_at=str(user.created_at),
        can_delete=not is_server_administrator(user, config.gateway_admin_email),
    )


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    admin: Annotated[User, Depends(require_admin)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    agent_store: Annotated[AgentStore, Depends(get_agent_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    template_store: Annotated[TemplateStore, Depends(get_template_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    resource_service: Annotated[ResourceService, Depends(get_resource_service)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    client_lifecycle: Annotated[ClientLifecycleService, Depends(get_client_lifecycle)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """The deployment operator deletes someone's whole account.

    The same deletion, and the same refusals, as `DELETE /auth/me`: this only
    changes who asks. The operator's own account is refused, so that leaving
    the server is always the person's own act. Whether it went ahead, was
    refused or failed partway lands in the server's audit log, since an
    account spans every workspace and no one workspace's history is the place
    for it.

    `session` is bound to the operator's own workspace, like the other user
    routes, but carries only rows that belong to no workspace: the `users`
    row, its sign-in identities and the audit event. Each workspace the
    account is in is left in a `tenant_session` of its own.
    """
    if user_id == admin.id:
        detail = (
            "That's your own account. Delete it from your account settings instead."
        )
        await _record_refusal(session, admin.id, user_id, detail)
        raise HTTPException(status_code=409, detail=detail)
    target = await user_store.get(session, user_id)
    if target is None:
        await _record_refusal(session, admin.id, user_id, "User not found")
        raise HTTPException(status_code=404, detail="User not found")
    deletion = _account_deletion(
        request,
        session_factory,
        protocol,
        broker,
        resource_service,
        room_service,
        user_store,
        organization_store,
        agent_store,
        api_key_store,
        template_store,
        client_lifecycle,
        config,
    )
    workspaces = await _workspaces_to_delete(
        deletion, session_factory, user_store, target.id
    )
    reason = await deletion.refusal(session, target, workspaces)
    if reason is not None:
        await _record_refusal(session, admin.id, target.id, reason)
        raise HTTPException(status_code=409, detail=reason)
    await record_server_audit_event(
        session,
        actor_user_id=admin.id,
        action=ServerAuditAction.USER_DELETED,
        target_type="user",
        target_id=target.id,
        details={"outcome": "deleted", "workspaces": len(workspaces)},
    )
    # The event commits with the `users` row, so it never records a deletion
    # that did not finish. The ids outlive the rollback that expires the rows.
    operator_id, target_id = admin.id, target.id
    try:
        await deletion.delete(session, target, workspaces, actor_id=admin.id)
    except AccountDeletionRefused as refused:
        # An organization's last admin check failed under its lock, before
        # anything changed; the deletion event above goes with the rollback.
        await session.rollback()
        await _record_refusal(session, operator_id, target_id, str(refused))
        raise HTTPException(status_code=409, detail=str(refused)) from None
    except AccountDeletionIncomplete as error:
        # The workspaces already left stay left, so the attempt is recorded on
        # its own, in a transaction after the one that just rolled back.
        await session.rollback()
        await record_server_audit_event(
            session,
            actor_user_id=operator_id,
            action=ServerAuditAction.USER_DELETION_FAILED,
            target_type="user",
            target_id=target_id,
            details={
                "outcome": "failed",
                "workspaces": len(workspaces),
                "workspaces_completed": [w.id for w in error.completed],
                "error": type(error.__cause__).__name__,
            },
        )
        await session.commit()
        raise
    logger.info("Operator %s deleted the account of user %s", operator_id, target_id)
    return {"ok": True}


@router.post("/users/{user_id}/sessions/revoke")
async def end_user_sessions(
    user_id: str,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_session)],
    admin: Annotated[User, Depends(require_admin)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> dict[str, bool]:
    """The deployment operator signs someone out of all their devices, for a
    lost laptop or an account that looks taken over. Recorded in the server's
    audit log, like the operator deleting an account."""
    if await user_store.session_version(session, user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    await user_store.end_sessions(session, user_id)
    await record_server_audit_event(
        session,
        actor_user_id=admin.id,
        action=ServerAuditAction.USER_SESSIONS_ENDED,
        target_type="user",
        target_id=user_id,
        details=None,
    )
    await session.commit()
    if user_id == admin.id:
        response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


async def _record_refusal(
    session: AsyncSession, operator_id: str, target_id: str, reason: str
) -> None:
    await record_server_audit_event(
        session,
        actor_user_id=operator_id,
        action=ServerAuditAction.USER_DELETION_REFUSED,
        target_type="user",
        target_id=target_id,
        details={"outcome": "refused", "reason": reason},
    )
    await session.commit()
