from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
    Response,
)
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.account_reset import AccountReset, ResetWaiting
from switch_core.accounts.deletion import (
    AccountDeletion,
    AccountDeletionIncomplete,
    AccountDeletionRefused,
    Workspace,
)
from switch_core.box_cluster import box_cluster_on
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import KnownUserLabel
from switch_core.bridges.resource.service import ResourceService
from switch_core.chats.member_names import rename_member_clients
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import TENANT_ZERO_ID, ExternalUser, User
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
    connector_apps_in_dashboard,
    deployment_manager,
    describe_session_state,
    get_authenticated_caller,
    get_authenticated_session,
    get_authenticated_user_id,
    get_current_user,
    hash_password_off_loop,
    initial_tenant_claim,
    list_held_memberships,
    list_tenant_memberships,
    operator_entered_workspace,
    password_matches_off_loop,
    session_signed_in,
    set_session_cookie,
    sign_out_session,
    signed_in_now,
    signup_refused_by_edge,
    tenants_held_by,
    verify_password_off_loop,
)
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_agent_store,
    get_api_key_store,
    get_bridge_store,
    get_client_lifecycle,
    get_collab_lifecycle,
    get_config,
    get_external_user_store,
    get_organization_admin_notices,
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
from switch_core.gateway.login_limits import (
    admit_login,
    count_signup,
    counted_address,
    refuse_signup_from,
)
from switch_core.gateway.schemas import (
    AccountDeletionCheck,
    AuthConfigResponse,
    ChangePasswordRequest,
    DeleteAccountRequest,
    LinkedIdentity,
    LoginRequest,
    OidcLoginOptionView,
    PendingIdentity,
    ServerDeclaration,
    SessionStateResponse,
    SessionUserResponse,
    SignupMachine,
    SignupRequest,
    SignupResponse,
    StartOverResponse,
    UpdateMeRequest,
)
from switch_core.gateway.sign_in_events import record_sign_in, sign_in_failed
from switch_core.observability.catalogue import AUTH_SIGN_IN_FAILURES
from switch_core.observability.metrics import metrics
from switch_core.organization_admin_notices import OrganizationAdminNotices
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.room_service import RoomService
from switch_core.telemetry import emit_safely
from switch_core.tenant_context import tenant_scope
from switch_core.version import server_declaration
from switch_core.visibility.box_provision import ask_for_box
from switch_core.visibility.guards import get_operator_list
from switch_core.visibility.operators import OperatorList

logger = logging.getLogger(__name__)

router = APIRouter()

MACHINE_OWNER_STOPPED = "Your cloud machine is stopped. Start it in Switch Console."
MACHINE_AFTER_WORKSPACE = "Your cloud machine starts once you have created a workspace."


def _gateway_declaration() -> ServerDeclaration:
    return ServerDeclaration.model_validate(server_declaration("gateway-api"))


def _session_response(user: User) -> SessionUserResponse:
    """An authenticated session, carrying what the server is (CHOO-1865).

    Every response that establishes or confirms a session says so, which means
    a client learns the server's ranges on the call it already makes. Signing
    in, refreshing and signing out are frozen and excluded from `gateway-api`,
    so this is the one path that cannot itself be the thing that broke.
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
    request: Request,
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
    # `users`, which is global (a person is one account across tenants), and
    # counts the attempt in `auth_attempts`, global too, so there is nothing
    # here a tenant would scope. Which workspace the new session selects comes
    # from the membership lookup, on a session of its own.
    if not config.gateway_password_login_enabled:
        raise HTTPException(status_code=403, detail="Password login is disabled")

    attempt = await admit_login(session, config, req.email, request)
    user = await user_store.get_by_email(session, req.email)
    # One connection at a time, and none held across bcrypt.
    await session.commit()
    if not await password_matches_off_loop(user, req.password):
        # Counted for the alert on password guessing; nothing about who. The
        # security event names the account when there is one, for alerting
        # on one account being guessed at.
        metrics().increment(AUTH_SIGN_IN_FAILURES, {})
        attempt.failed()
        sign_in_failed(
            request,
            method="password",
            reason="unknown_account" if user is None else "wrong_password",
            user_id=None if user is None else user.id,
            tenant_id=None,
        )
        raise HTTPException(status_code=401, detail="Invalid email or password")
    assert user is not None
    await attempt.succeeded(session)

    tenant_claim = await initial_tenant_claim(session_factory, user_store, user)
    await record_sign_in(
        session,
        request,
        user_id=user.id,
        method="password",
        details={"tenant_id": tenant_claim},
    )
    await session.commit()
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        tenant_claim,
        signed_in_now(),
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
    await ask_for_box(
        factory,
        machine_id=machine.id,
        config=config,
        settings=settings,
        now=datetime.now(UTC),
    )
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
    """Open self sign-up: a new account, signed in.

    Where it lands follows `gateway_signup_mode`, as an OIDC first sign-in
    does. Under "default_tenant" it joins tenant zero by name, since no caller
    exists yet to take a tenant from, and its cloud machine starts warming:
    claimed after the account is committed, and failing to claim one never
    fails the sign-up, the response says why instead. Under "open" it joins
    nothing and creates its workspace next (`POST /organizations`), whose
    machine is warmed then.
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

    address = counted_address(request)
    with tenant_scope(TENANT_ZERO_ID):
        # Checked before the hash so a refusal stays cheap, and again under the
        # lock after it; neither the lock nor a connection is held across bcrypt.
        await refuse_signup_from(session, address)
        await _refuse_signup(session, user_store, req.email, config)
        await session.rollback()
        password_hash = await hash_password_off_loop(req.password)

        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "gateway-signup"},
        )
        await refuse_signup_from(session, address)
        await _refuse_signup(session, user_store, req.email, config)
        user = User(
            name=req.display_name or req.email.split("@")[0],
            email=req.email,
            role="user",
            password_hash=password_hash,
        )
        joins_tenant_zero = config.gateway_signup_mode == "default_tenant"
        try:
            async with session.begin_nested():
                if joins_tenant_zero:
                    await user_store.create(session, user)
                else:
                    await user_store.create_without_membership(session, user)
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
        await count_signup(session, config, address)
        await session.commit()
        logger.info("Signed up user %s", user.id)
        emit_safely(current_telemetry(), "account_created", {"method": "signup"})

        set_session_cookie(
            response,
            user,
            config.keyring,
            config.gateway_cookie_secure,
            TENANT_ZERO_ID if joins_tenant_zero else None,
            signed_in_now(),
        )
        signed_in = _session_response(user)
        if not joins_tenant_zero:
            machine = SignupMachine(
                status="unavailable", reason=MACHINE_AFTER_WORKSPACE
            )
        elif config.hosted_pool_size > 0:
            # A warm pool: no box at sign-up. One is
            # taken from the pool, or made, at the person's first start, so
            # the pool's boxes go to people who use them. The answer says
            # nothing is wrong, as before (Console shows nothing for
            # `starting`). With no pool, a sign-up asks for the box as before.
            machine = SignupMachine(status="starting", reason=None)
        else:
            machine = await _prewarm(
                session, session_factory, user.id, config, settings
            )
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
        session_signed_in(request),
    )
    return _session_response(user)


@router.post("/auth/logout")
async def logout(
    request: Request,
    response: Response,
    session: Annotated[AsyncSession, Depends(get_system_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Sign out of this session: clear this browser's cookie, and refuse
    every copy of it from now on, wherever it was copied to. The account's
    other sessions are left alone; `/auth/sessions/revoke` ends them all.

    Takes no session, so a client holding an expired or broken cookie can
    always clear it, and `get_system_session` because a session belongs to no
    workspace: the revocation is one global row (`revoked_sessions`).
    """
    await sign_out_session(session, request, config)
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
        signup_enabled=config.gateway_signup_joins_tenant_zero,
        web_signup_enabled=config.gateway_signup_open
        and config.gateway_onboarding_enabled,
        test_account_reset_enabled=config.gateway_allow_test_account_reset,
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
    operators: Annotated[OperatorList, Depends(get_operator_list)],
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
        can_manage_connector_apps=await deployment_manager(session_factory, user)
        is not None,
        connector_apps_in_dashboard=await connector_apps_in_dashboard(session_factory),
        # Read from the operator list only, never from `users.role`. A hint for
        # the web's navigation, so nothing is written to the operator log here:
        # `require_operator` records list changes before any operator route
        # answers.
        # Without a box cluster, not read or sent.
        hosted_operator=operators.is_operator(user.id) if box_cluster_on() else None,
    )


@router.get("/auth/me")
async def me(
    user: Annotated[User, Depends(get_current_user)],
) -> SessionUserResponse:
    return _session_response(user)


def _account_label(
    collab_lifecycle: CollaborationBridgeLifecycleService, identity: ExternalUser
) -> KnownUserLabel:
    """How a linked account is named: as its running bridge names it, or by
    its stored name, a handle, while the bridge is stopped."""
    adapter = collab_lifecycle.get_adapter(identity.bridge_id)
    if adapter is None:
        return KnownUserLabel(display_name=identity.external_username, has_handle=True)
    return adapter.known_user_label(
        identity.external_user_id, identity.external_username
    )


@router.get("/auth/me/identities")
async def my_identities(
    session: Annotated[AsyncSession, Depends(get_session)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    user: Annotated[User, Depends(get_current_user)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
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
        label = _account_label(collab_lifecycle, identity)
        linked.append(
            LinkedIdentity(
                id=identity.id,
                bridge_id=identity.bridge_id,
                bridge_display_name=bridge.display_name,
                bridge_type=bridge.type,
                external_user_id=identity.external_user_id,
                external_username=identity.external_username,
                external_display_name=label.display_name,
                has_handle=label.has_handle,
                verified=claim.verified_at is not None,
                linked_at=claim.created_at,
                awaiting_confirmation=await external_user_store.get_link_request(
                    session, identity.id, user.id
                )
                is not None,
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
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
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
        label = _account_label(collab_lifecycle, identity)
        pending.append(
            PendingIdentity(
                id=identity.id,
                bridge_id=identity.bridge_id,
                bridge_display_name=bridge.display_name,
                bridge_type=bridge.type,
                external_user_id=identity.external_user_id,
                external_username=identity.external_username,
                external_display_name=label.display_name,
                has_handle=label.has_handle,
                requested_by_name=requester.name if requester is not None else None,
                code_expires_at=request.code_expires_at,
            )
        )
    return pending


@router.get("/auth/me/deletion")
async def check_my_account_deletion(
    request: Request,
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
    notices: Annotated[
        OrganizationAdminNotices, Depends(get_organization_admin_notices)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> AccountDeletionCheck:
    """What `DELETE /auth/me` would refuse with now, for the Gateway to say so
    before the caller types their email rather than after. Changes nothing,
    and the deletion checks again when it runs: someone else can be made an
    admin, or stop being one, in between."""
    user = await user_store.get(session, caller.id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
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
        notices,
        config,
    )
    workspaces = await _workspaces_to_delete(
        deletion, session_factory, user_store, user.id
    )
    return AccountDeletionCheck(
        refusal=await deletion.refusal(session, user, workspaces)
    )


@router.delete("/auth/me")
async def delete_my_account(
    req: DeleteAccountRequest,
    request: Request,
    response: Response,
    background: BackgroundTasks,
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
    notices: Annotated[
        OrganizationAdminNotices, Depends(get_organization_admin_notices)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Delete the caller's own account, everywhere on this server.

    Binds no tenant because it acts on every workspace the caller is in, each
    in a `tenant_session` of its own (`accounts/deletion.py`); `session`, with
    nothing bound, carries only the rows that belong to no workspace — the
    `users` row and its sign-in identities. The caller confirms by typing
    their email, since an SSO account has no password to ask for. A refusal
    is a 409 saying what to do first, and leaves the account untouched. The
    admins of an organization the caller was `org_admin` of are e-mailed
    after the response, once the deletion has committed and nothing here
    holds a connection.
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
        notices,
        config,
    )
    workspaces = await _workspaces_to_delete(
        deletion, session_factory, user_store, user.id
    )
    reason = await deletion.refusal(session, user, workspaces)
    if reason is not None:
        raise HTTPException(status_code=409, detail=reason)
    # The checks only read. Their transaction ends here, so the connection is
    # not held through a deletion that opens sessions of its own per workspace.
    await session.commit()
    try:
        changes = await deletion.delete(session, user, workspaces, actor_id=user.id)
    except AccountDeletionRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused)) from None
    except AccountDeletionIncomplete as incomplete:
        await _tell_admins_of_incomplete_deletion(session, notices, incomplete)
        raise
    background.add_task(notices.send_all, changes)
    response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


@router.post("/auth/me/reset-test-account")
async def reset_test_account(
    req: DeleteAccountRequest,
    request: Request,
    response: Response,
    background: BackgroundTasks,
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
    notices: Annotated[
        OrganizationAdminNotices, Depends(get_organization_admin_notices)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, bool]:
    """Wipe the caller's own test account, on a test or canary server that
    allows it (`gateway_allow_test_account_reset`): an organization nobody
    else is in is purged whole; elsewhere only the workspaces the caller is
    alone in are purged, and the caller leaves the rest, the server's default
    workspace included (`accounts/account_reset.py`). Refused with a 409,
    before anything changes, for anything `DELETE /auth/me` refuses or the
    purge must wait for."""
    reset, user, workspaces = await _test_reset(
        req,
        request,
        session,
        session_factory,
        caller,
        user_store,
        organization_store,
        agent_store,
        api_key_store,
        template_store,
        protocol,
        resource_service,
        room_service,
        broker,
        client_lifecycle,
        notices,
        config,
    )
    try:
        changes = await reset.reset(session, user, workspaces, keep_login=False)
    except AccountDeletionRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused)) from None
    except AccountDeletionIncomplete as incomplete:
        await _tell_admins_of_incomplete_deletion(session, notices, incomplete)
        raise
    background.add_task(notices.send_all, changes)
    response.delete_cookie("switch_auth", path="/")
    return {"ok": True}


@router.post("/auth/me/start-over")
async def start_over(
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
    notices: Annotated[
        OrganizationAdminNotices, Depends(get_organization_admin_notices)
    ],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> StartOverResponse:
    """Wipe what the caller's test account owns but keep its login, on a
    server that allows test-account resets: the workspaces a reset purges
    and the account's cloud machines go, and the caller is signed out, so
    signing in again starts from creating a workspace. While a cloud machine
    is still being torn down it answers `finished: false` with what it waits
    on, having signed nobody out; asking again finishes it."""
    reset, user, workspaces = await _test_reset(
        req,
        request,
        session,
        session_factory,
        caller,
        user_store,
        organization_store,
        agent_store,
        api_key_store,
        template_store,
        protocol,
        resource_service,
        room_service,
        broker,
        client_lifecycle,
        notices,
        config,
    )
    try:
        await reset.reset(session, user, workspaces, keep_login=True)
    except ResetWaiting as waiting:
        return StartOverResponse(finished=False, waiting=str(waiting))
    except AccountDeletionRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused)) from None
    response.delete_cookie("switch_auth", path="/")
    return StartOverResponse(finished=True, waiting=None)


async def _test_reset(
    req: DeleteAccountRequest,
    request: Request,
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    caller: AuthenticatedCaller,
    user_store: UserStore,
    organization_store: OrganizationStore,
    agent_store: AgentStore,
    api_key_store: ApiKeyStore,
    template_store: TemplateStore,
    protocol: AgentCore,
    resource_service: ResourceService,
    room_service: RoomService,
    broker: ServiceBroker,
    client_lifecycle: ClientLifecycleService,
    notices: OrganizationAdminNotices,
    config: SwitchConfig,
) -> tuple[AccountReset, User, list[Workspace]]:
    """The reset for the caller's confirmed account and its workspaces, on a
    server that allows test-account resets; 404 elsewhere. Commits the
    caller's session, which is not held through the reset."""
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
        notices,
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
    # As `delete_my_account`: not held through the purges and the deletion.
    await session.commit()
    return reset, user, workspaces


async def _tell_admins_of_incomplete_deletion(
    session: AsyncSession,
    notices: OrganizationAdminNotices,
    incomplete: AccountDeletionIncomplete,
) -> None:
    """E-mail the admins of the organizations a failed deletion already took
    the person's admin role from, before the failure becomes the response:
    an error response runs no background task. The request's transaction is
    rolled back first, so none is held while the relay is talked to."""
    await session.rollback()
    await notices.send_all(incomplete.admin_changes)


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
    notices: OrganizationAdminNotices,
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
        admin_notices=notices,
    )


async def _workspaces_to_delete(
    deletion: AccountDeletion,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    user_id: str,
) -> list[Workspace]:
    memberships = [
        Workspace(id=m.id, name=m.name, role=m.role)
        for m in await list_held_memberships(session_factory, user_store, user_id)
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
        await tenants_held_by(session_factory, user.id),
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
        session_signed_in(request),
    )
    return {"ok": True}
