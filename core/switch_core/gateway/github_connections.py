import asyncio
import logging
import secrets
from html import escape
from typing import Annotated, cast
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.connections.adapters import ConnectionSecret
from switch_core.connections.broker import (
    CONNECTOR_NOT_CONNECTED,
    CONNECTOR_REVOKED,
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
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
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.service_connections import service_refusal
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


def service(request: Request) -> GitHubConnections:
    value = request.app.state.github_connections
    if value is None:
        raise HTTPException(503, "GitHub connections are not enabled on this server.")
    return cast(GitHubConnections, value)


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
        + escape(message)
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


@router.post("/flows", response_model=None)
async def start(
    body: StartFlow,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    github: Annotated[GitHubConnections, Depends(service)],
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
            503, "GitHub connection is busy. Please try again shortly."
        ) from None
    return {
        "id": body.state,
        "url": github.origin
        + "/gateway/provider-connections/github/authorize?state="
        + body.state,
    }


@router.get("/authorize")
async def authorize(
    state: str,
    request: Request,
    github: Annotated[GitHubConnections, Depends(service)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> Response:
    nonce = secrets.token_urlsafe(32)
    try:
        flow = await browser_flow(flows, state)
        taken = await flows.advance(
            flow,
            expect=("pending",),
            to="authorizing",
            changes={"browser_nonce_hash": digest(nonce)},
        )
        if taken is None:
            raise GitHubError("This authorization has already been used.")
    except GitHubError:
        return page(INTERRUPTED, 400)
    response = RedirectResponse(
        github.authorize_url(state, flow.verifier),
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
    response.set_cookie(
        "switch_github_" + state,
        nonce,
        max_age=600,
        secure=secure_cookie(request),
        httponly=True,
        samesite="lax",
        path="/gateway/provider-connections/github/callback",
    )
    return response


@router.get("/callback")
async def callback(
    request: Request,
    github: Annotated[GitHubConnections, Depends(service)],
    flows: Annotated[SignInFlows, Depends(get_sign_in_flows)],
) -> Response:
    """Back from GitHub: the browser takes the code on to Switch Console, on
    the computer it left from. Once per flow. Back with GitHub's `error`
    instead, the flow fails with what GitHub said, and the page says it too:
    GitHub reports an App whose callback URL does not match this way."""
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    try:
        flow = await browser_flow(flows, state)
        if (
            flow.status != "authorizing"
            or len(code) > 512
            or not flow.holds_nonce(request.cookies.get("switch_github_" + state, ""))
        ):
            raise GitHubError("Authorization could not be verified.")
        if not code:
            refusal = vendor_refusal(
                "GitHub",
                request.query_params.get("error", ""),
                request.query_params.get("error_description"),
            )
            await flows.advance(
                flow,
                expect=("authorizing",),
                to="failed",
                changes={"error": refusal},
            )
            return page(f"{refusal} Return to Switch Console.", 400)
        if (
            await flows.advance(
                flow, expect=("authorizing",), to="delivered", changes={}
            )
            is None
        ):
            raise GitHubError("Authorization could not be verified.")
        response = RedirectResponse(
            f"http://127.0.0.1:{flow.port}/switch-github/callback?"
            + urlencode({"code": code, "state": state}),
            status_code=303,
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
        response.delete_cookie(
            "switch_github_" + state,
            path="/gateway/provider-connections/github/callback",
            secure=secure_cookie(request),
            httponly=True,
            samesite="lax",
        )
        return response
    except GitHubError:
        return page(INTERRUPTED, 400)


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
    github: Annotated[GitHubConnections, Depends(service)],
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
        changed = (
            "This server's GitHub App changed during your sign-in. Start it again."
        )
        await flows.advance(
            flow, expect=("delivered",), to="failed", changes={"error": changed}
        )
        raise HTTPException(400, changed)
    checking = await flows.advance(
        flow, expect=("delivered",), to="checking", changes={}
    )
    if checking is None:
        raise HTTPException(400, refused)
    try:
        credentials = await github.sign_in(body.code, flow.verifier)
    except (GitHubError, asyncio.CancelledError) as error:
        await _settled(flows, checking, "failed", error=str(error) or INTERRUPTED)
        if isinstance(error, GitHubError):
            raise HTTPException(400, str(error)) from None
        raise
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"github-link:{require_tenant_id()}"},
    )
    account_id = str(credentials["user_id"])
    taken = await session.scalar(
        select(ServiceConnection.user_id).where(
            ServiceConnection.tenant_id == require_tenant_id(),
            ServiceConnection.service == "github",
            ServiceConnection.user_id != user.id,
            ServiceConnection.account_id == account_id,
        )
    )
    if taken is not None:
        linked = (
            "This GitHub account is already linked to another Switch user in "
            "this workspace. Remove that link first."
        )
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
            user_id=user.id,
            service="github",
            consent="write",
            granted_scopes=[],
            account_id=account_id,
            external_identity=credentials["login"],
            secret=ConnectionSecret(credentials),
            oauth_client_id=github.client_id,
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
        user.id,
        account_id,
    )
    return JSONResponse({"warning": warning, "login": credentials["login"]})


@router.get("/flows/{flow_id}")
async def flow_status(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
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
    github: Annotated[GitHubConnections, Depends(service)],
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
    github: Annotated[GitHubConnections, Depends(service)],
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
        return {"status": "not_connected", "install_url": github.install_url}
    try:
        reach = await github.repositories(token)
    except GitHubAuthorizationError as error:
        raise HTTPException(422, str(error)) from None
    except GitHubError as error:
        raise HTTPException(502, str(error)) from None
    row = await STORE.get_connection(session, user_id, "github")
    if row is None:
        raise HTTPException(409, "GitHub connection changed. Please retry.")
    await session.commit()
    return {
        "status": "connected",
        "login": row.external_identity,
        "installations": reach.installations,
        # Organizations whose single sign-on hides their installations from
        # this sign-in: connecting again and authorizing them shows those.
        "sso_hidden_organizations": reach.sso_hidden,
        "install_url": github.install_url,
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
