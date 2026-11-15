import asyncio
import html
import logging
import secrets
from typing import Annotated, cast
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.broker import (
    CONNECTOR_NOT_CONNECTED,
    CONNECTOR_REVOKED,
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.connections.flows import NO_LISTENER, RETURNS_TO_WEB, WEB_INTERRUPTED
from switch_core.connections.organization_apps import OrganizationApp
from switch_core.connections.sign_in_flows import (
    FlowGoneError,
    FlowsBusyError,
    FlowUsedError,
    SignInFlows,
    StoredFlow,
    digest,
    vendor_refusal,
)
from switch_core.db.models import (
    ServiceConnection,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, session_belongs_to
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.service_connections import service_refusal
from switch_core.gateway.service_flows import (
    LOST,
    NOT_YOURS,
    connector_page,
    not_saved,
    opened_elsewhere,
    refused_browser,
)
from switch_core.loopback import secure_cookie
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubConnections,
    GitHubError,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/provider-connections/github")
STORE = ServiceConnectionStore()


KIND = "github"
INTERRUPTED = "Sign-in was interrupted. Start it again from Switch Console."
APP_CHANGED = "The GitHub App changed during your sign-in. Start it again."
UNVERIFIED = "GitHub authorization could not be verified. Connect again."


def on_web(flow: StoredFlow) -> bool:
    """Started from the gateway: it finishes at the callback, which returns
    the browser to the connector's page (`gateway/service_flows.py`)."""
    return flow.details.get("returns_to") == "web"


async def owners_browser(
    request: Request,
    flow: StoredFlow,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> bool:
    """Whether the browser is signed in to Switch as the person who started
    `flow`, in a workspace they may still use."""
    if await session_belongs_to(
        request,
        session_factory,
        user_store,
        config,
        user_id=flow.user_id,
        tenant_id=flow.tenant_id,
    ):
        return True
    refused_browser(request, "github", flow.tenant_id, flow.user_id)
    return False


def service(request: Request) -> GitHubConnections:
    """The server's own GitHub App, or a refusal giving the broker's reason
    GitHub can't be used through it here, such as its App not being set up."""
    value = request.app.state.github_connections
    if value is None:
        reason = get_service_broker(request).server_availability("github")
        if reason is None:
            logger.error(
                "The broker can grant GitHub, but this process has no GitHub App."
            )
            reason = "GitHub is not set up here."
        raise HTTPException(503, reason)
    return cast(GitHubConnections, value)


def app_for_workspace(
    request: Request, app: OrganizationApp | None
) -> GitHubConnections:
    """The GitHub App a workspace signs in through: its organization's App
    `app`, where it saved one, else the server's. An organization's App that
    cannot be used is refused with the reason, never swapped for the
    server's."""
    if app is None:
        return service(request)
    if app.github_app is None:
        raise HTTPException(503, app.problem or "GitHub is not available here.")
    return app.github_app.connections


async def workspace_app(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> GitHubConnections:
    """The signed-in person's workspace's GitHub App (`app_for_workspace`)."""
    return app_for_workspace(request, await broker.organization_app(session, "github"))


def get_sign_in_flows(request: Request) -> SignInFlows:
    flows = getattr(request.app.state, "sign_in_flows", None)
    if not isinstance(flows, SignInFlows):
        raise RuntimeError("No sign-in flow store is installed on this app.")
    return flows


async def owned_flow(flows: SignInFlows, flow_id: str, user_id: str) -> StoredFlow:
    try:
        flow = await flows.get(flow_id, require_tenant_id())
    except FlowGoneError:
        raise HTTPException(410, INTERRUPTED) from None
    if flow.kind != KIND or flow.user_id != user_id:
        raise HTTPException(404, "Authorization not found.")
    return flow


async def browser_flow(flows: SignInFlows, state: str) -> StoredFlow:
    """The flow a browser step names by its state, whichever tenant holds it."""
    try:
        flow = await flows.find(state)
    except FlowGoneError:
        raise GitHubError(INTERRUPTED) from None
    if flow.kind != KIND:
        raise GitHubError(INTERRUPTED)
    return flow


def page(message: str, status: int) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        "<title>Switch · GitHub</title><body><main><h1>Switch · GitHub</h1><p>"
        + html.escape(message)
        + "</p></main></body></html>",
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        },
    )


class StartFlow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    port: int = Field(strict=True, ge=1024, le=65535)
    state: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    completion_secret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class FlowSecret(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completion_secret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class CompleteFlow(FlowSecret):
    code: str = Field(min_length=1, max_length=512)


@router.post("/flows/web", response_model=None)
async def start_web(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    github: Annotated[GitHubConnections, Depends(workspace_app)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> dict | JSONResponse:
    """Begin connecting GitHub from the gateway: the browser goes to `url`,
    and comes back to the connector's page with the flow's id."""
    try:
        await broker.require_workspace_enabled(session, "github")
    except ServiceError as error:
        return service_refusal(error)
    elsewhere = opened_elsewhere(request, github.callback, "GitHub")
    if elsewhere is not None:
        raise HTTPException(409, elsewhere)
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None:
        raise HTTPException(404, "Workspace not found.")
    state = secrets.token_urlsafe(32)
    try:
        await flows.start(
            kind=KIND,
            service="github",
            tenant_id=require_tenant_id(),
            user_id=user.id,
            state=state,
            mode="core",
            port=NO_LISTENER,
            redirect_uri=github.callback,
            owner_label=f"{user.name} ({user.email}) in {tenant.name}",
            details={"client_id": github.client_id, **RETURNS_TO_WEB},
            # Nothing completes a web flow: its callback does.
            completion_secret=secrets.token_urlsafe(32),
        )
    except FlowsBusyError:
        raise HTTPException(
            503, "The GitHub connector is busy. Please try again shortly."
        ) from None
    return {
        "id": state,
        "url": github.origin
        + "/gateway/provider-connections/github/authorize?state="
        + state,
    }


@router.post("/flows", response_model=None)
async def start(
    body: StartFlow,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    github: Annotated[GitHubConnections, Depends(workspace_app)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> dict | JSONResponse:
    try:
        await broker.require_workspace_enabled(session, "github")
    except ServiceError as error:
        return service_refusal(error)
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None:
        raise HTTPException(404, "Workspace not found.")
    try:
        await flows.start(
            kind=KIND,
            service="github",
            tenant_id=require_tenant_id(),
            user_id=user.id,
            state=body.state,
            mode="core",
            port=body.port,
            redirect_uri=github.callback,
            owner_label=f"{user.name} ({user.email}) in {tenant.name}",
            details={"client_id": github.client_id},
            completion_secret=body.completion_secret,
        )
    except FlowUsedError:
        raise HTTPException(
            409, "This authorization has already been used. Connect again."
        ) from None
    except FlowsBusyError:
        raise HTTPException(
            503, "The GitHub connector is busy. Please try again shortly."
        ) from None
    return {
        "id": body.state,
        "url": github.origin
        + "/gateway/provider-connections/github/authorize?state="
        + body.state,
    }


async def _failed_before_leaving(
    flows: SignInFlows, flow: StoredFlow, message: str, status: int
) -> Response:
    """The browser cannot leave for GitHub: the flow fails with `message`,
    for Console's poll or the connector's page to read, and the browser is
    told the same, or sent back to that page."""
    await flows.advance(
        flow, expect=("pending",), to="failed", changes={"error": message}
    )
    if on_web(flow):
        return _sent_on(connector_page("github", flow.state), flow)
    return page(message, status)


@router.get("/authorize")
async def authorize(
    state: str,
    request: Request,
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> Response:
    """The browser leaves for GitHub through Core. Nobody need be signed in
    here, so the App is the flow's workspace's. A flow the gateway started
    leaves only with its owner's browser."""
    nonce = secrets.token_urlsafe(32)
    try:
        flow = await browser_flow(flows, state)
    except GitHubError:
        return page(LOST, 400)
    if on_web(flow) and not await owners_browser(
        request, flow, session_factory, user_store, config
    ):
        return page(NOT_YOURS, 403)
    try:
        github = app_for_workspace(
            request, await broker.organization_app_of(flow.tenant_id, "github")
        )
    except HTTPException as refusal:
        return await _failed_before_leaving(flows, flow, str(refusal.detail), 503)
    # Started under another App: the code GitHub issued would be refused.
    if flow.details.get("client_id") not in (None, github.client_id):
        return await _failed_before_leaving(flows, flow, APP_CHANGED, 400)
    try:
        taken = await flows.advance(
            flow,
            expect=("pending",),
            to="authorizing",
            changes={"browser_nonce_hash": digest(nonce)},
        )
        if taken is None:
            raise GitHubError("This authorization has already been used.")
    except GitHubError:
        return page(WEB_INTERRUPTED if on_web(flow) else INTERRUPTED, 400)
    response = RedirectResponse(
        github.authorize_url(state, flow.verifier),
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
    response.set_cookie(
        "switch_github_" + state,
        nonce,
        max_age=600,
        secure=secure_cookie(github.origin),
        httponly=True,
        samesite="lax",
        path="/gateway/provider-connections/github/callback",
    )
    return response


def _sent_on(target: str, flow: StoredFlow) -> Response:
    """The browser sent on from GitHub's callback, its flow cookie spent."""
    response = RedirectResponse(
        target,
        status_code=303,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
    response.delete_cookie(
        "switch_github_" + flow.state,
        path="/gateway/provider-connections/github/callback",
        secure=secure_cookie(flow.redirect_uri),
        httponly=True,
        samesite="lax",
    )
    return response


class _Refused(Exception):
    """GitHub sent the browser back with a refusal, and the flow failed with
    it: the message is for the browser too."""


async def _back_from_github(
    flows: SignInFlows, flow: StoredFlow, request: Request
) -> str:
    """The browser that left through Core is back: its code, or GitHub's
    refusal, which fails the flow with what GitHub said (`_Refused`)."""
    code = request.query_params.get("code", "")
    if (
        flow.status != "authorizing"
        or len(code) > 512
        or not flow.holds_nonce(request.cookies.get("switch_github_" + flow.state, ""))
    ):
        raise GitHubError("Authorization could not be verified.")
    if not code:
        refusal = vendor_refusal(
            "GitHub",
            request.query_params.get("error", ""),
            request.query_params.get("error_description"),
        )
        await flows.advance(
            flow, expect=("authorizing",), to="failed", changes={"error": refusal}
        )
        raise _Refused(refusal)
    return code


@router.get("/callback")
async def callback(
    request: Request,
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> Response:
    """Back from GitHub: the browser takes the code on to Switch Console, on
    the computer it left from, or, for a flow the gateway started, Core
    finishes it here and returns the browser to the connector's page. Once
    per flow. Back with GitHub's `error` instead, the flow fails with what
    GitHub said, and the page says it too: GitHub reports an App whose
    callback URL does not match this way."""
    state = request.query_params.get("state", "")
    try:
        flow = await browser_flow(flows, state)
    except GitHubError:
        return page(LOST, 400)
    if on_web(flow):
        return await _finish_on_web(
            request,
            flow,
            flows=flows,
            broker=broker,
            session_factory=session_factory,
            user_store=user_store,
            config=config,
        )
    try:
        code = await _back_from_github(flows, flow, request)
        if (
            await flows.advance(
                flow, expect=("authorizing",), to="delivered", changes={}
            )
            is None
        ):
            raise GitHubError("Authorization could not be verified.")
    except _Refused as refusal:
        return page(f"{refusal} Return to Switch Console.", 400)
    except GitHubError:
        return page(INTERRUPTED, 400)
    return _sent_on(
        f"http://127.0.0.1:{flow.port}/switch-github/callback?"
        + urlencode({"code": code, "state": state}),
        flow,
    )


async def _finish_on_web(
    request: Request,
    flow: StoredFlow,
    *,
    flows: SignInFlows,
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> Response:
    """A flow the gateway started, back from GitHub: Core signs in with the
    code and writes the connection for the person who started it, whose
    session the browser must carry, and returns the browser to the
    connector's page, where the flow says how it ended."""
    if not await owners_browser(request, flow, session_factory, user_store, config):
        return page(NOT_YOURS, 403)
    back = _sent_on(connector_page("github", flow.state), flow)
    try:
        code = await _back_from_github(flows, flow, request)
    except _Refused:
        return back
    except GitHubError:
        await flows.advance(
            flow, expect=("authorizing",), to="failed", changes={"error": UNVERIFIED}
        )
        return back
    async with tenant_session(session_factory, flow.tenant_id) as session:
        try:
            github = app_for_workspace(
                request, await broker.organization_app_of(flow.tenant_id, "github")
            )
        except HTTPException as refusal:
            await flows.advance(
                flow,
                expect=("authorizing",),
                to="failed",
                changes={"error": str(refusal.detail)},
            )
            return back
        if flow.details.get("client_id") not in (None, github.client_id):
            await flows.advance(
                flow,
                expect=("authorizing",),
                to="failed",
                changes={"error": APP_CHANGED},
            )
            return back
        checking = await flows.advance(
            flow, expect=("authorizing",), to="checking", changes={}
        )
        if checking is None:
            return back
        try:
            await _sign_in_and_link(
                session, broker, flows, checking, github, code, flow.user_id
            )
        except Exception:
            # The browser goes back to the page all the same, which says the
            # sign-in failed, rather than to an error page with no way on.
            logger.exception(
                "Writing a GitHub connection from the web failed: tenant=%s user=%s",
                flow.tenant_id,
                flow.user_id,
            )
            await _settled(flows, checking, "failed", error=not_saved("GitHub"))
    return back


async def _settled(
    flows: SignInFlows, flow: StoredFlow, status: str, **changes: str | None
) -> None:
    """The flow's outcome, kept without the token for Console to read."""
    await flows.advance(flow, expect=("checking",), to=status, changes=changes)


@router.post("/flows/{flow_id}/complete")
async def complete(
    flow_id: str,
    body: CompleteFlow,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    github: Annotated[GitHubConnections, Depends(workspace_app)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> Response:
    """Console hands back the code its listener received, with its secret:
    Core exchanges it, reads the account and writes the connection."""
    flow = await owned_flow(flows, flow_id, user.id)
    refused = "GitHub authorization could not be verified. Connect again."
    if not flow.holds_secret(body.completion_secret) or flow.status != "delivered":
        raise HTTPException(400, refused)
    recorded = flow.details.get("client_id")
    if recorded is not None and recorded != github.client_id:
        # The code was issued to the App the flow started with: with another
        # in its place, GitHub would refuse it, and less clearly.
        await flows.advance(
            flow, expect=("delivered",), to="failed", changes={"error": APP_CHANGED}
        )
        raise HTTPException(400, APP_CHANGED)
    checking = await flows.advance(
        flow, expect=("delivered",), to="checking", changes={}
    )
    if checking is None:
        raise HTTPException(400, refused)
    return await _sign_in_and_link(
        session, broker, flows, checking, github, body.code, user.id
    )


async def _sign_in_and_link(
    session: AsyncSession,
    broker: ServiceBroker,
    flows: SignInFlows,
    checking: StoredFlow,
    github: GitHubConnections,
    code: str,
    user_id: str,
) -> Response:
    """Sign in to GitHub with a `checking` flow's code, write the connection
    for `user_id` in the session's workspace, and settle the flow: connected,
    or failed with why. Answers as `complete` does."""
    interrupted = WEB_INTERRUPTED if on_web(checking) else INTERRUPTED
    try:
        credentials = await github.sign_in(code, checking.verifier)
    except (GitHubError, asyncio.CancelledError) as error:
        await _settled(flows, checking, "failed", error=str(error) or interrupted)
        if isinstance(error, GitHubError):
            return JSONResponse(status_code=400, content={"detail": str(error)})
        raise
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"github-link:{require_tenant_id()}"},
    )
    account_id = str(credentials["user_id"])
    secret = ConnectionSecret(credentials)
    holder = await session.scalar(
        select(ServiceConnection).where(
            ServiceConnection.tenant_id == require_tenant_id(),
            ServiceConnection.service == "github",
            ServiceConnection.user_id != user_id,
            ServiceConnection.account_id == account_id,
        )
    )
    if holder is not None:
        linked = (
            "This GitHub account is already linked to another Switch user in "
            "this Switch workspace. Remove that link first."
        )
        try:
            note = await broker.discard_sign_in(
                session,
                service="github",
                kept=holder,
                secret=secret,
                oauth_client_id=github.client_id,
                account_id=account_id,
                choices={},
            )
        except Exception:
            # The refusal must still reach the person and end the flow.
            logger.exception("github unkept sign-in discard failed")
            note = "Switch could not check the sign-in GitHub just issued."
        if note is not None:
            linked = f"{linked} {note}"
        await _settled(flows, checking, "failed", error=linked)
        return JSONResponse(
            status_code=409,
            content={
                "detail": linked,
                "code": "account_linked_elsewhere",
                "retryable": False,
            },
        )
    try:
        warning = await broker.connect(
            session,
            user_id=user_id,
            service="github",
            consent="write",
            granted_scopes=[],
            account_id=account_id,
            external_identity=credentials["login"],
            secret=secret,
            oauth_client_id=github.client_id,
            method="oauth",
            choices={},
        )
    except ServiceError as error:
        await _settled(flows, checking, "failed", error=error.message)
        return service_refusal(error)
    await _settled(
        flows,
        checking,
        "connected",
        account_label=credentials["login"],
        warning=warning,
    )
    logger.info(
        "GitHub account linked: tenant=%s user=%s github_user=%s",
        require_tenant_id(),
        user_id,
        account_id,
    )
    return JSONResponse({"warning": warning, "login": credentials["login"]})


@router.get("/flows/{flow_id}")
async def flow_status(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> dict:
    flow = await owned_flow(flows, flow_id, user.id)
    return {
        "status": flow.status
        if flow.status in {"checking", "connected", "failed"}
        else "pending",
        "login": flow.account_label or "",
        "error": flow.error,
        "warning": flow.warning,
    }


@router.delete("/flows/{flow_id}", status_code=204)
async def drop(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> Response:
    """Console is done with the flow: cancelled, or its outcome read."""
    await flows.discard(await owned_flow(flows, flow_id, user.id))
    return Response(status_code=204)


@router.get("")
async def connection(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    github: Annotated[GitHubConnections, Depends(workspace_app)],
) -> dict:
    return await connection_status(user.id, session, broker, github)


async def connection_status(
    user_id: str,
    session: AsyncSession,
    broker: ServiceBroker,
    github: GitHubConnections,
) -> dict:
    """The person's GitHub link and every repository the App lets them reach."""
    try:
        token = await broker.connection_access_token(session, user_id, "github")
    except ServiceError as error:
        status = 422 if error.code == CONNECTOR_REVOKED else error.status_code
        raise HTTPException(status, error.message) from None
    if token is None:
        return {
            "status": "not_connected",
            "install_url": github.install_url,
            "can_revoke": False,
        }
    try:
        reach = await github.repositories(token)
    except GitHubAuthorizationError as error:
        raise HTTPException(422, str(error)) from None
    except GitHubError as error:
        raise HTTPException(502, str(error)) from None
    row = await STORE.get_connection(session, user_id, "github")
    if row is None:
        raise HTTPException(409, "The GitHub connector changed. Please retry.")
    await session.commit()
    return {
        "status": "connected",
        "login": row.external_identity,
        "installations": reach.installations,
        # Organizations whose single sign-on hides their installations from
        # this sign-in: connecting again and authorizing them shows those.
        "sso_hidden_organizations": reach.sso_hidden,
        "install_url": github.install_url,
        # The caller's own connection, theirs to disconnect.
        "can_revoke": True,
    }


@router.delete("")
async def disconnect(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> Response:
    """Disconnect GitHub: its grants go, and what was issued is revoked.

    Works with no App on the server too, so a connection made under an App
    since removed can still be dropped; the warning then says the sign-in
    could not be revoked.
    """
    try:
        warning = await broker.disconnect(session, user.id, "github")
    except ServiceError as error:
        if error.code != CONNECTOR_NOT_CONNECTED:
            return service_refusal(error)
        warning = None
    await flows.discard_for_user(session, user.id, KIND)
    await session.commit()
    return JSONResponse({"warning": warning})
