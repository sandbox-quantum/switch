import json
import re
import secrets
import time
from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import ProviderConnection, User, require_tenant_id
from switch_core.db.stores.provider_connection_store import (
    ProviderConnectionBusy,
    ProviderConnectionStore,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.providers.github import GitHubConnections, GitHubError, GitHubFlow

router = APIRouter(prefix="/provider-connections/github")


def service(request: Request) -> GitHubConnections:
    value = request.app.state.github_connections
    if value is None:
        raise HTTPException(503, "GitHub connections are not enabled on this server.")
    return cast(GitHubConnections, value)


async def lock(session: AsyncSession, user_id: str) -> None:
    try:
        await ProviderConnectionStore().lock_user(session, user_id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None


def owned_flow(github: GitHubConnections, flow_id: str, user_id: str) -> GitHubFlow:
    try:
        flow = github.flow(flow_id)
    except GitHubError as error:
        raise HTTPException(410, str(error)) from None
    if (flow.tenant_id, flow.user_id) != (require_tenant_id(), user_id):
        raise HTTPException(404, "Authorization not found.")
    return flow


def conditions(user_id: str) -> tuple:
    return (
        ProviderConnection.tenant_id == require_tenant_id(),
        ProviderConnection.user_id == user_id,
        ProviderConnection.provider == "github",
    )


def page(message: str, status: int) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        "<title>Switch · GitHub</title><body><main><h1>Switch · GitHub</h1><p>"
        + message
        + "</p></main></body></html>",
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        },
    )


@router.post("/flows")
async def start(
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> dict:
    try:
        flow_id = github.start(require_tenant_id(), user.id)
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
            "This authorization expired. Return to Switch Console and connect again.",
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
    if not state:
        return page(
            "Return to Switch Console. Repository access will update automatically.",
            200,
        )
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", state):
        return page(
            "Invalid authorization. Return to Switch Console and connect again.", 400
        )
    code = request.query_params.get("code", "")
    nonce = request.cookies.get("switch_github_" + state, "")
    try:
        if not code or len(code) > 512:
            flow = github.flow(state)
            if (
                secrets.compare_digest(flow.browser_nonce, nonce)
                and flow.status == "pending"
            ):
                flow.status = "failed"
            raise GitHubError("Authorization was not completed.")
        await github.complete(state, nonce, code)
        response = page(
            "GitHub authorized. Return to Switch Console to confirm the account.", 200
        )
    except GitHubError:
        response = page(
            "GitHub authorization failed or expired. Return to Switch Console and connect again.",
            400,
        )
    response.delete_cookie(
        "switch_github_" + state,
        path="/gateway/provider-connections/github/callback",
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return response


@router.get("/flows/{flow_id}")
async def flow_status(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> dict:
    flow = owned_flow(github, flow_id, user.id)
    return {"status": flow.status, "login": flow.login}


@router.delete("/flows/{flow_id}", status_code=204)
async def cancel(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> Response:
    owned_flow(github, flow_id, user.id)
    del github.flows[flow_id]
    return Response(status_code=204)


@router.post("/flows/{flow_id}/confirm", status_code=204)
async def confirm(
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> Response:
    await lock(session, user.id)
    flow = owned_flow(github, flow_id, user.id)
    if flow.status != "ready":
        raise HTTPException(409, "Finish GitHub authorization before confirming.")
    encrypted = encrypt_token(json.dumps(flow.credentials), config.jwt_secret_key)
    now = datetime.now(UTC)
    await session.execute(
        insert(ProviderConnection)
        .values(
            tenant_id=require_tenant_id(),
            user_id=user.id,
            provider="github",
            kind="oauth",
            encrypted_credential=encrypted,
            verified_at=now,
        )
        .on_conflict_do_update(
            index_elements=["tenant_id", "user_id", "provider"],
            set_={
                "kind": "oauth",
                "encrypted_credential": encrypted,
                "verified_at": now,
            },
        )
    )
    await session.commit()
    github.flows.pop(flow_id, None)
    return Response(status_code=204)


@router.get("")
async def connection(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> dict:
    return await connection_status(user.id, session, config, github)


async def connection_status(
    user_id: str, session: AsyncSession, config: SwitchConfig, github: GitHubConnections
) -> dict:
    await lock(session, user_id)
    row = await session.scalar(select(ProviderConnection).where(*conditions(user_id)))
    if row is None:
        return {"status": "not_connected", "install_url": github.install_url}
    credentials = json.loads(
        decrypt_token(row.encrypted_credential, config.jwt_secret_key)
    )
    try:
        if credentials["expires_at"] < time.time() + 60:
            if credentials["refresh_expires_at"] <= time.time():
                raise GitHubError("GitHub authorization expired. Connect GitHub again.")
            refreshed = await github.exchange(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": credentials["refresh_token"],
                }
            )
            credentials.update(refreshed)
            row.encrypted_credential = encrypt_token(
                json.dumps(credentials), config.jwt_secret_key
            )
            await session.commit()
        installations = await github.repositories(credentials["access_token"])
    except GitHubError as error:
        raise HTTPException(502, str(error)) from None
    return {
        "status": "connected",
        "login": credentials["login"],
        "installations": installations,
        "install_url": github.install_url,
    }


@router.delete("", status_code=204)
async def disconnect(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    github: Annotated[GitHubConnections, Depends(service)],
) -> Response:
    await lock(session, user.id)
    await session.execute(delete(ProviderConnection).where(*conditions(user.id)))
    await session.commit()
    for key, flow in list(github.flows.items()):
        if (flow.tenant_id, flow.user_id) == (require_tenant_id(), user.id):
            del github.flows[key]
    return Response(status_code=204)
