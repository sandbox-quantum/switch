"""Connecting a service through Switch's generic OAuth sign-in.

The routes of `connections/flows.py`, for any catalog entry with the
`oauth-mcp` adapter; GitHub keeps its own (`gateway/github_connections.py`).
Switch Console starts, completes, follows and confirms a flow as the signed-in
person; `authorize` and `callback` are the browser's, in core mode, and are
tied to the flow by its state and a cookie rather than by a session.
"""

from __future__ import annotations

import logging
from html import escape
from typing import Annotated, cast
from urllib.parse import parse_qs

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
    FlowError,
    ServiceFlow,
    ServiceFlows,
)
from switch_core.db.models import ServiceConnection, Tenant, User, require_tenant_id
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.service_connections import service_refusal

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
        + message
        + "</p></main></body></html>",
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": (
                "default-src 'none'; frame-ancestors 'none'; form-action 'self'; "
                "base-uri 'none'"
            ),
        },
    )


def _owned(flows: ServiceFlows, service: str, flow_id: str, user: User) -> ServiceFlow:
    try:
        flow = flows.owned(flow_id, require_tenant_id(), user.id)
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


class FlowSecret(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completion_secret: str = Field(pattern=TOKEN_PATTERN)


class CompleteFlow(FlowSecret):
    code: str = Field(min_length=1, max_length=2048)


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
        definition, adapter = broker.sign_in(service)
    except ServiceError as error:
        return service_refusal(error)
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None:
        raise HTTPException(404, "Workspace not found.")
    try:
        flow = flows.start(
            definition=definition,
            tenant_id=require_tenant_id(),
            user_id=user.id,
            state=body.state,
            port=body.port,
            completion_secret=body.completion_secret,
            owner_label=f"{user.name} ({user.email}) in {tenant.name}",
        )
    except FlowError as error:
        raise HTTPException(409, str(error)) from None
    if flow.mode == "core":
        url = flows.authorize_url(service, body.state)
    else:
        try:
            url = await flows.vendor_url(body.state, adapter)
        except ServiceUnavailableError as error:
            raise HTTPException(503, str(error)) from None
        except ServiceAdapterError as error:
            raise HTTPException(502, str(error)) from None
    return {"id": body.state, "url": url, "mode": flow.mode}


@router.get("/authorize")
async def authorize(
    service: str,
    state: str,
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """The browser leaves for the vendor through Core, which marks it."""
    try:
        definition, adapter = broker.sign_in(service)
    except ServiceError:
        return _page("Connections", INTERRUPTED, 400)
    try:
        flow = flows.flow(state)
        if flow.service != service or flow.mode != "core":
            raise FlowError(INTERRUPTED)
        url = await flows.vendor_url(state, adapter)
    except (FlowError, ServiceAdapterError):
        return _page(definition.name, INTERRUPTED, 400)
    response = RedirectResponse(
        url, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
    )
    response.set_cookie(
        _cookie(state),
        flow.browser_nonce,
        max_age=600,
        secure=True,
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
    """Back from the vendor: the person says this is their Switch account."""
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    try:
        flow = flows.flow(state)
        if flow.service != service:
            raise FlowError(INTERRUPTED)
        flows.returning(state, code, request.cookies.get(_cookie(state), ""))
    except FlowError:
        return _page("Connections", INTERRUPTED, 400)
    response = _page(
        flow.name,
        f"Linking {escape(flow.name)} to <strong>{escape(flow.owner_label)}</strong>. "
        "Continue only if this is your Switch account. Use the same computer where "
        "you started the connection."
        f'<form method="post" action="{_cookie_path(service)}">'
        f'<input type="hidden" name="state" value="{escape(state, quote=True)}">'
        f'<input type="hidden" name="code" value="{escape(code, quote=True)}">'
        '<button type="submit">Continue in Switch Console</button></form>',
        200,
    )
    response.headers["Content-Security-Policy"] = (
        "default-src 'none'; frame-ancestors 'none'; "
        f"form-action 'self' http://127.0.0.1:{flow.port}; base-uri 'none'"
    )
    return response


@router.post("/callback")
async def relay(
    service: str,
    request: Request,
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """The person continued: their browser takes the code to Switch Console."""
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 4096:
            return _page("Connections", "Invalid sign-in response.", 400)
    value = parse_qs(body.decode("utf-8", errors="replace"))
    state = value.get("state", [""])[0]
    code = value.get("code", [""])[0]
    try:
        flow = flows.flow(state)
        if flow.service != service:
            raise FlowError(INTERRUPTED)
        target = flows.deliver(state, code, request.cookies.get(_cookie(state), ""))
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
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return response


@router.post("/{flow_id}/complete", status_code=204, response_model=None)
async def complete(
    service: str,
    flow_id: str,
    body: CompleteFlow,
    user: Annotated[User, Depends(get_current_user)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    """Console hands back the code its listener received, with its secret."""
    _owned(flows, service, flow_id, user)
    try:
        _, adapter = broker.sign_in(service)
    except ServiceError as error:
        return service_refusal(error)
    try:
        await flows.complete(
            flow_id,
            completion_secret=body.completion_secret,
            code=body.code,
            adapter=adapter,
        )
    except FlowError as error:
        raise HTTPException(400, str(error)) from None
    except ServiceUnavailableError as error:
        raise HTTPException(503, str(error)) from None
    return Response(status_code=204)


@router.get("/{flow_id}")
async def flow_status(
    service: str,
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> dict:
    flow = _owned(flows, service, flow_id, user)
    return {
        "status": (
            flow.status if flow.status in ("checking", "ready", "failed") else "pending"
        ),
        "account": None if flow.account is None else flow.account.label,
        "error": flow.error,
    }


@router.delete("/{flow_id}", status_code=204)
async def cancel(
    service: str,
    flow_id: str,
    user: Annotated[User, Depends(get_current_user)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> Response:
    _owned(flows, service, flow_id, user)
    flows.flows.pop(flow_id, None)
    return Response(status_code=204)


@router.post("/{flow_id}/confirm", response_model=None)
async def confirm(
    service: str,
    flow_id: str,
    body: FlowSecret,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> dict | JSONResponse:
    """The person confirms the account: the connection is written."""
    _owned(flows, service, flow_id, user)
    try:
        flow = flows.ready(flow_id, body.completion_secret)
        consent = flows.consent(flow)
    except FlowError as error:
        raise HTTPException(409, str(error)) from None
    assert flow.account is not None and flow.signed_in is not None
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"service-link:{require_tenant_id()}:{service}"},
    )
    taken = await session.scalar(
        select(ServiceConnection.user_id).where(
            ServiceConnection.tenant_id == require_tenant_id(),
            ServiceConnection.service == service,
            ServiceConnection.user_id != user.id,
            ServiceConnection.account_id == flow.account.account_id,
        )
    )
    if taken is not None:
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f"This {flow.name} account is already linked to another Switch "
                    "user in this workspace. Remove that link first."
                ),
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
            granted_scopes=flow.signed_in.granted_scopes,
            account_id=flow.account.account_id,
            external_identity=flow.account.label,
            secret=flow.signed_in.secret,
        )
    except ServiceError as error:
        return service_refusal(error)
    flows.flows.pop(flow_id, None)
    logger.info(
        "Service account linked: tenant=%s user=%s service=%s",
        require_tenant_id(),
        user.id,
        service,
    )
    return {"warning": warning, "consent": consent}
