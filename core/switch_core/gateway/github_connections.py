import json
import logging
import secrets
import time
from datetime import UTC, datetime
from html import escape
from typing import Annotated, Literal, cast
from urllib.parse import parse_qs, urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_session_factory
from switch_core.db.models import (
    ProviderConnection,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubConnections,
    GitHubError,
    GitHubFlow,
    revoke_oauth,
)
from switch_core.providers.github_installation import (
    granted_repositories,
    visible_installation,
)
from switch_core.providers.github_tasks import finish_shielded
from switch_core.web_page import render_page, status_icon

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/provider-connections/github")


class GitHubReconnectRequired(HTTPException):
    code = "github_reconnect_required"

    def __init__(self, message: str) -> None:
        super().__init__(422, message)


def service(request: Request) -> GitHubConnections:
    value = request.app.state.github_connections
    if value is None:
        raise HTTPException(503, "GitHub connections are not enabled on this server.")
    return cast(GitHubConnections, value)


async def lock(session: AsyncSession, user_id: str) -> None:
    await session.execute(text("SET LOCAL lock_timeout = '25s'"))
    try:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"github-connection:{require_tenant_id()}:{user_id}"},
        )
    except DBAPIError as error:
        if getattr(error.orig, "sqlstate", None) == "55P03":
            raise HTTPException(
                503, "GitHub connection is busy. Please retry."
            ) from None
        raise


def owned_flow(github: GitHubConnections, flow_id: str, user_id: str) -> GitHubFlow:
    try:
        flow = github.flow(flow_id)
    except GitHubError as error:
        raise HTTPException(410, str(error)) from None
    if (flow.tenant_id, flow.user_id) != (require_tenant_id(), user_id):
        raise HTTPException(404, "Authorization not found.")
    return flow


def github_identity(row: ProviderConnection, config: SwitchConfig) -> dict:
    """A GitHub connection's stored credentials. GitHub logins are never
    sealed, so the keyring copy is always there."""
    if row.encrypted_credential is None:
        raise RuntimeError(
            f"GitHub connection of user {row.user_id} has no stored credential"
        )
    return dict(json.loads(config.keyring.decrypt(row.encrypted_credential)))


def conditions(user_id: str) -> tuple:
    return (
        ProviderConnection.tenant_id == require_tenant_id(),
        ProviderConnection.user_id == user_id,
        ProviderConnection.provider == "github",
    )


def page_policy(form_action: str) -> str:
    return (
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; "
        f"form-action {form_action}; base-uri 'none'"
    )


def page(message: str, status: int) -> HTMLResponse:
    """A GitHub connect page. `message` is markup: callers escape what they
    interpolate into it."""
    failed = status >= 400
    return HTMLResponse(
        render_page(
            title="GitHub sign-in did not finish" if failed else "Connect GitHub",
            icon=status_icon("error" if failed else "info"),
            body=message,
        ),
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": page_policy("'self'"),
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


@router.post("/flows")
async def start(
    body: StartFlow,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> dict:
    try:
        tenant = await session.get(Tenant, require_tenant_id())
        if tenant is None:
            raise HTTPException(404, "Workspace not found.")
        flow_id = github.start(
            require_tenant_id(),
            user.id,
            body.port,
            body.completion_secret,
            body.state,
            f"{user.name} ({user.email}) in {tenant.name}",
        )
    except GitHubError as error:
        raise HTTPException(503, str(error)) from None
    return {
        "id": flow_id,
        "url": github.origin
        + "/gateway/provider-connections/github/authorize?state="
        + flow_id,
    }


@router.get("/authorize")
async def authorize(
    state: str, github: Annotated[GitHubConnections, Depends(service)]
) -> Response:
    try:
        url = github.authorize_url(state)
        flow = github.flow(state)
    except GitHubError:
        return page(
            "Sign-in was interrupted. Start it again from Switch Console.",
            400,
        )
    response = RedirectResponse(
        url, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
    )
    response.set_cookie(
        "switch_github_" + state,
        flow.browser_nonce,
        max_age=600,
        secure=True,
        httponly=True,
        samesite="lax",
        path="/gateway/provider-connections/github/callback",
    )
    return response


@router.get("/callback")
async def callback(
    request: Request, github: Annotated[GitHubConnections, Depends(service)]
) -> Response:
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    try:
        flow = github.flow(state)
        if (
            flow.status not in {"authorizing", "returning"}
            or len(code) > 512
            or not secrets.compare_digest(
                flow.browser_nonce, request.cookies.get("switch_github_" + state, "")
            )
        ):
            raise GitHubError("Authorization could not be verified.")
        if not code:
            flow.status = "failed"
            raise GitHubError("GitHub authorization was cancelled.")
        flow.status = "returning"
        response = page(
            f"<p>Linking GitHub to <strong>{escape(flow.owner_label)}</strong>.</p>"
            "<p>Continue only if this is your Switch account. Use the same computer where you started the connection.</p>"
            '<form method="post" action="/gateway/provider-connections/github/callback">'
            f'<input type="hidden" name="state" value="{escape(state, quote=True)}">'
            f'<input type="hidden" name="code" value="{escape(code, quote=True)}">'
            '<button type="submit">Continue in Switch Console</button></form>',
            200,
        )
        response.headers["Content-Security-Policy"] = page_policy(
            f"'self' http://127.0.0.1:{flow.port}"
        )
        return response
    except GitHubError:
        return page(
            "Sign-in was interrupted. Start it again from Switch Console.",
            400,
        )


@router.post("/callback")
async def relay(
    request: Request, github: Annotated[GitHubConnections, Depends(service)]
) -> Response:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2048:
            return page("Invalid authorization response.", 400)
    value = parse_qs(body.decode("utf-8", errors="replace"))
    state = value.get("state", [""])[0]
    code = value.get("code", [""])[0]
    try:
        flow = github.flow(state)
        if (
            not code
            or len(code) > 512
            or flow.status != "returning"
            or not secrets.compare_digest(
                flow.browser_nonce, request.cookies.get("switch_github_" + state, "")
            )
        ):
            raise GitHubError("Authorization could not be verified.")
        flow.status = "delivered"
        response = RedirectResponse(
            f"http://127.0.0.1:{flow.port}/switch-github/callback?"
            + urlencode({"code": code, "state": state}),
            status_code=303,
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
        response.delete_cookie(
            "switch_github_" + state,
            path="/gateway/provider-connections/github/callback",
            secure=True,
            httponly=True,
            samesite="lax",
        )
        return response
    except GitHubError:
        return page("Sign-in was interrupted. Start it again from Switch Console.", 400)


@router.post("/flows/{flow_id}/complete", status_code=204)
async def complete(
    flow_id: str,
    body: CompleteFlow,
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> Response:
    owned_flow(github, flow_id, user.id)
    try:
        await github.complete(flow_id, body.completion_secret, body.code)
    except GitHubError as error:
        raise HTTPException(400, str(error)) from None
    return Response(status_code=204)


@router.get("/flows/{flow_id}")
async def flow_status(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> dict:
    flow = owned_flow(github, flow_id, user.id)
    return {
        "status": flow.status
        if flow.status in {"checking", "ready", "failed"}
        else "pending",
        "login": flow.login,
    }


@router.delete("/flows/{flow_id}", status_code=204)
async def cancel(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> Response:
    owned_flow(github, flow_id, user.id)
    del github.flows[flow_id]
    return Response(status_code=204)


@router.post("/flows/{flow_id}/confirm")
async def confirm(
    flow_id: str,
    body: FlowSecret,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> Response:
    await lock(session, user.id)
    flow = owned_flow(github, flow_id, user.id)
    if not secrets.compare_digest(flow.completion_secret, body.completion_secret):
        raise HTTPException(404, "Authorization not found.")
    if flow.status != "ready":
        raise HTTPException(409, "Finish GitHub authorization before confirming.")
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"github-link:{require_tenant_id()}"},
    )
    other_links = await session.scalars(
        select(ProviderConnection).where(
            ProviderConnection.tenant_id == require_tenant_id(),
            ProviderConnection.provider == "github",
            ProviderConnection.user_id != user.id,
        )
    )
    for other in other_links:
        identity = github_identity(other, config)
        if identity.get("user_id") == flow.credentials["user_id"]:
            raise HTTPException(
                409,
                "This GitHub account is already linked to another Switch user in this workspace. Remove that link first.",
            )
    previous = await session.scalar(
        select(ProviderConnection).where(*conditions(user.id))
    )
    previous_token = (
        github_identity(previous, config)["access_token"] if previous else None
    )
    encrypted = config.keyring.encrypt(json.dumps(flow.credentials))
    now = datetime.now(UTC)
    if previous is None:
        session.add(
            ProviderConnection(
                tenant_id=require_tenant_id(),
                user_id=user.id,
                provider="github",
                kind="oauth",
                encrypted_credential=encrypted,
                verified_at=now,
            )
        )
    else:
        previous.kind = "oauth"
        previous.encrypted_credential = encrypted
        previous.verified_at = now
    await session.commit()
    github.flows.pop(flow_id, None)
    logger.info(
        "GitHub account linked: tenant=%s user=%s github_user=%s",
        require_tenant_id(),
        user.id,
        flow.credentials["user_id"],
    )
    warning = (
        await revoke_oauth(github, previous_token)
        if previous_token and previous_token != flow.credentials["access_token"]
        else None
    )
    return JSONResponse({"warning": warning})


@router.get("", response_model=None)
async def connection(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> dict | JSONResponse:
    try:
        return await connection_status(user.id, session, config, github)
    except GitHubReconnectRequired as error:
        return JSONResponse(
            {"detail": error.detail, "code": error.code}, status_code=422
        )


async def _credentials(
    user_id: str,
    engine: AsyncEngine,
    config: SwitchConfig,
    github: GitHubConnections,
    tenant_id: str,
) -> tuple[dict, datetime] | None:
    async with tenant_session(create_session_factory(engine), tenant_id) as session:
        await lock(session, user_id)
        row = await session.scalar(
            select(ProviderConnection).where(*conditions(user_id))
        )
        if row is None:
            return None
        credentials = github_identity(row, config)
        if credentials["expires_at"] < time.time() + 60:
            if credentials["refresh_expires_at"] <= time.time():
                raise GitHubAuthorizationError(
                    "GitHub authorization expired. Reconnect GitHub."
                )
            refreshed = await github.exchange(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": credentials["refresh_token"],
                }
            )
            credentials.update(refreshed)
            revision = datetime.now(UTC)
            result = await session.scalar(
                update(ProviderConnection)  # nosemgrep
                .where(
                    *conditions(user_id),
                    ProviderConnection.verified_at == row.verified_at,
                )
                .values(
                    encrypted_credential=config.keyring.encrypt(
                        json.dumps(credentials)
                    ),
                    verified_at=revision,
                )
                .returning(ProviderConnection.user_id)
            )
            if result is None:
                raise HTTPException(409, "GitHub connection changed. Please retry.")
        else:
            revision = row.verified_at
        await session.commit()
        return credentials, revision


async def github_credentials(
    user_id: str,
    session: AsyncSession,
    config: SwitchConfig,
    github: GitHubConnections,
) -> tuple[dict, datetime] | None:
    engine = session.bind
    if not isinstance(engine, AsyncEngine):
        raise RuntimeError("GitHub credentials require a database engine.")
    if session.in_transaction():
        raise RuntimeError(
            "End the caller transaction before fetching GitHub credentials."
        )
    try:
        return await finish_shielded(
            _credentials(user_id, engine, config, github, require_tenant_id())
        )
    except GitHubAuthorizationError as error:
        raise GitHubReconnectRequired(str(error)) from None
    except GitHubError as error:
        raise HTTPException(502, str(error)) from None


async def connection_status(
    user_id: str, session: AsyncSession, config: SwitchConfig, github: GitHubConnections
) -> dict:
    await session.commit()
    saved = await github_credentials(user_id, session, config, github)
    if saved is None:
        return {"status": "not_connected", "install_url": github.install_url}
    credentials, revision = saved
    try:
        installations = await github.repositories(credentials["access_token"])
    except GitHubAuthorizationError as error:
        raise GitHubReconnectRequired(str(error)) from None
    except GitHubError as error:
        raise HTTPException(502, str(error)) from None
    row = await session.scalar(select(ProviderConnection).where(*conditions(user_id)))
    if row is None or row.verified_at != revision:
        raise HTTPException(409, "GitHub connection changed. Please retry.")
    await session.commit()
    return {
        "status": "connected",
        "login": credentials["login"],
        "installations": installations,
        "install_url": github.install_url,
    }


async def check_github_grant(
    user_id: str,
    session: AsyncSession,
    config: SwitchConfig,
    github: GitHubConnections,
    installations: list[tuple[int, Literal["all"] | list[int]]],
) -> None:
    """Check that the user can grant GitHub `installations` (each an
    installation id and its `"all"` or repository ids) to a cloud agent: they
    see each installation, and they can push to each repository a list names
    (or, for `"all"`, to at least one). 422 otherwise."""
    access = await connection_status(user_id, session, config, github)
    if access["status"] != "connected":
        raise GitHubReconnectRequired(
            "Connect GitHub before granting it to a cloud agent."
        )
    for installation_id, repositories in installations:
        try:
            granted_repositories(
                visible_installation(access["installations"], installation_id),
                repositories,
            )
        except GitHubError as error:
            raise HTTPException(422, str(error)) from None


@router.delete("")
async def disconnect(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    github: Annotated[GitHubConnections, Depends(service)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> Response:
    await lock(session, user.id)
    row = await session.scalar(select(ProviderConnection).where(*conditions(user.id)))
    token = github_identity(row, config)["access_token"] if row else None
    await session.execute(
        delete(ProviderConnection).where(*conditions(user.id))  # nosemgrep
    )
    await session.commit()
    for key, flow in list(github.flows.items()):
        if (flow.tenant_id, flow.user_id) == (require_tenant_id(), user.id):
            del github.flows[key]
    warning = await revoke_oauth(github, token) if token else None
    return JSONResponse({"warning": warning})
