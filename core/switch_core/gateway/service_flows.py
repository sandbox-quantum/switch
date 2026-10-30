"""Connecting a service through Switch's generic OAuth sign-in.

The routes of `connections/flows.py`, for any catalog entry with the
`oauth` adapter; GitHub keeps its own (`gateway/github_connections.py`).
Switch Console starts, completes, fails, follows and drops a flow as the
signed-in person; `authorize` and `callback` are the browser's, in core mode,
and are tied to the flow by its state and a cookie rather than by a session.
"""

from __future__ import annotations

import logging
from html import escape
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.connections.adapters import (
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.connections.flows import (
    INTERRUPTED,
    MAX_CODE_LENGTH,
    FlowError,
    ServiceFlow,
    ServiceFlows,
    SignInRefusedError,
)
from switch_core.connections.loader import ChoicesError
from switch_core.db.models import ServiceConnection, Tenant, User, require_tenant_id
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.service_connections import service_refusal
from switch_core.loopback import secure_cookie

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/service-connections/{service}/flows")
TOKEN_PATTERN = r"^[A-Za-z0-9_-]{43}$"


def get_service_flows(request: Request) -> ServiceFlows:
    flows = getattr(request.app.state, "service_flows", None)
    if not isinstance(flows, ServiceFlows):
        raise RuntimeError("No service sign-in flows are installed on this app.")
    return cast(ServiceFlows, flows)


def _cookie(state: str) -> str:
    return "switch_service_" + state


def _cookie_path(service: str) -> str:
    return f"/gateway/service-connections/{service}/flows/callback"


def _page(name: str, message: str, status: int) -> HTMLResponse:
    title = escape(f"Switch · {name}")
    return HTMLResponse(
        "<!doctype html><html lang=en><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width'>"
        f"<title>{title}</title><body><main><h1>{title}</h1><p>"
        + escape(message)
        + "</p></main></body></html>",
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": (
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
            ),
        },
    )


async def _owned(
    flows: ServiceFlows, service: str, flow_id: str, user: User
) -> ServiceFlow:
    try:
        flow = await flows.owned(flow_id, require_tenant_id(), user.id)
    except FlowError as error:
        raise HTTPException(410, str(error)) from None
    if flow.service != service:
        raise HTTPException(404, "Sign-in not found.")
    return flow


class StartFlow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    port: int = Field(strict=True, ge=1024, le=65535)
    state: str = Field(pattern=TOKEN_PATTERN)
    completion_secret: str = Field(pattern=TOKEN_PATTERN)
    # What the person picked before signing in, for an entry that asks
    # (`auth.oauth.choices`); a Console from before them sends none.
    choices: dict[str, str] | None = None


class FlowSecret(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completion_secret: str = Field(pattern=TOKEN_PATTERN)


class CompleteFlow(FlowSecret):
    code: str = Field(min_length=1, max_length=MAX_CODE_LENGTH)


class FailFlow(FlowSecret):
    """What the vendor sent Console's listener in place of a code. Core
    shortens it further, and takes out any markup, before it is shown."""

    error: str = Field(max_length=256)
    error_description: str | None = Field(max_length=2048)


@router.post("", response_model=None)
async def start(
    service: str,
    body: StartFlow,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> dict | JSONResponse:
    """Begin signing in: where to send the browser, and which way it returns."""
    try:
        await broker.require_workspace_enabled(session, service)
        definition, adapter = broker.sign_in(service)
    except ServiceError as error:
        return service_refusal(error)
    oauth = definition.auth.oauth
    assert oauth is not None
    try:
        choices = oauth.checked_choices(body.choices or {})
    except ChoicesError as error:
        raise HTTPException(422, str(error)) from None
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None:
        raise HTTPException(404, "Workspace not found.")
    try:
        flow = await flows.start(
            definition=definition,
            tenant_id=require_tenant_id(),
            user_id=user.id,
            state=body.state,
            port=body.port,
            completion_secret=body.completion_secret,
            owner_label=f"{user.name} ({user.email}) in {tenant.name}",
            choices=choices,
        )
    except FlowError as error:
        raise HTTPException(409, str(error)) from None
    if flow.mode == "core":
        url = flows.authorize_url(service, body.state)
    else:
        try:
            url, _ = await flows.vendor_url(flow, adapter)
        except ServiceUnavailableError as error:
            raise HTTPException(503, str(error)) from None
        except ServiceAdapterError as error:
            raise HTTPException(502, str(error)) from None
    return {"id": body.state, "url": url, "mode": flow.mode}


@router.get("/authorize")
async def authorize(
    service: str,
    state: str,
    request: Request,
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """The browser leaves for the vendor through Core, which marks it. A
    refusal on the way, by this server or the vendor, fails the flow with its
    reason, so Console shows it at once, and the page says it too."""
    try:
        flow = await flows.flow(state)
        if flow.service != service or flow.mode != "core":
            raise FlowError(INTERRUPTED)
    except FlowError:
        return _page("Connections", INTERRUPTED, 400)
    try:
        _, adapter = broker.sign_in(service)
    except ServiceError as refusal:
        await flows.refuse(flow.stored, refusal.message)
        return _page(flow.name, refusal.message, 400)
    try:
        url, nonce = await flows.vendor_url(flow, adapter)
    except FlowError:
        return _page(flow.name, INTERRUPTED, 400)
    except ServiceAdapterError as error:
        return _page(flow.name, str(error), 400)
    response = RedirectResponse(
        url, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
    )
    response.set_cookie(
        _cookie(state),
        nonce,
        max_age=600,
        secure=secure_cookie(request),
        httponly=True,
        samesite="lax",
        path=_cookie_path(service),
    )
    return response


@router.get("/callback")
async def callback(
    service: str,
    request: Request,
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """Back from the vendor: the browser takes the code on to Switch Console,
    on the computer it left from."""
    state = request.query_params.get("state", "")
    try:
        flow = await flows.flow(state)
        if flow.service != service:
            raise FlowError(INTERRUPTED)
    except FlowError:
        return _page("Connections", INTERRUPTED, 400)
    try:
        target = await flows.deliver(
            flow,
            code=request.query_params.get("code", ""),
            error=request.query_params.get("error", ""),
            description=request.query_params.get("error_description"),
            nonce=request.cookies.get(_cookie(state), ""),
        )
    except SignInRefusedError as refusal:
        return _page(flow.name, f"{refusal} Return to Switch Console.", 400)
    except FlowError:
        return _page("Connections", INTERRUPTED, 400)
    response = RedirectResponse(
        target,
        status_code=303,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
    response.delete_cookie(
        _cookie(state),
        path=_cookie_path(service),
        secure=secure_cookie(request),
        httponly=True,
        samesite="lax",
    )
    return response


@router.post("/{flow_id}/complete", response_model=None)
async def complete(
    service: str,
    flow_id: str,
    body: CompleteFlow,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> dict | JSONResponse:
    """Console hands back the code its listener received, with its secret:
    Core exchanges it, reads the account and writes the connection."""
    flow = await _owned(flows, service, flow_id, user)
    try:
        _, adapter = broker.sign_in(service)
    except ServiceError as error:
        await flows.refuse(flow.stored, error.message)
        return service_refusal(error)
    try:
        exchange = await flows.complete(
            flow,
            completion_secret=body.completion_secret,
            code=body.code,
            adapter=adapter,
        )
    except FlowError as error:
        raise HTTPException(400, str(error)) from None
    except ServiceUnavailableError as error:
        raise HTTPException(503, str(error)) from None
    try:
        consent = flows.consent(exchange)
    except FlowError as error:
        await flows.failed(exchange.flow, str(error))
        raise HTTPException(400, str(error)) from None
    account, signed_in = exchange.account, exchange.signed_in
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"service-link:{require_tenant_id()}:{service}"},
    )
    taken = await session.scalar(
        select(ServiceConnection.user_id).where(
            ServiceConnection.tenant_id == require_tenant_id(),
            ServiceConnection.service == service,
            ServiceConnection.user_id != user.id,
            ServiceConnection.account_id == account.account_id,
        )
    )
    if taken is not None:
        linked = (
            f"This {flow.name} account is already linked to another Switch "
            "user in this workspace. Remove that link first."
        )
        await flows.failed(exchange.flow, linked)
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
            service=service,
            consent=consent,
            granted_scopes=signed_in.granted_scopes,
            account_id=account.account_id,
            external_identity=account.label,
            secret=signed_in.secret,
            oauth_client_id=signed_in.client_id,
            method="oauth",
            choices=exchange.choices,
        )
    except ServiceError as error:
        await flows.failed(exchange.flow, error.message)
        return service_refusal(error)
    await flows.connected(exchange, warning)
    logger.info(
        "Service account linked: tenant=%s user=%s service=%s",
        require_tenant_id(),
        user.id,
        service,
    )
    return {"warning": warning, "consent": consent, "account": account.label}


@router.post("/{flow_id}/fail", status_code=204)
async def fail(
    service: str,
    flow_id: str,
    body: FailFlow,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """Console's listener was sent the vendor's refusal rather than a code,
    in loopback mode: the flow fails with what the vendor said, at once."""
    flow = await _owned(flows, service, flow_id, user)
    try:
        await flows.vendor_refused(
            flow,
            completion_secret=body.completion_secret,
            error=body.error,
            description=body.error_description,
        )
    except FlowError as error:
        raise HTTPException(400, str(error)) from None
    return Response(status_code=204)


@router.get("/{flow_id}")
async def flow_status(
    service: str,
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> dict:
    flow = await _owned(flows, service, flow_id, user)
    return {
        "status": (
            flow.status
            if flow.status in ("checking", "connected", "failed")
            else "pending"
        ),
        "account": flow.account_label,
        "error": flow.error,
        "warning": flow.warning,
    }


@router.delete("/{flow_id}", status_code=204)
async def drop(
    service: str,
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """Console is done with the flow: cancelled, or its outcome read."""
    await flows.discard(await _owned(flows, service, flow_id, user))
    return Response(status_code=204)
