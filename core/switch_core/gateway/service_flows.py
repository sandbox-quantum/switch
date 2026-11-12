"""Connecting a service through Switch's generic OAuth sign-in.

The routes of `connections/flows.py`, for any catalog entry with the
`oauth` adapter; GitHub keeps its own (`gateway/github_connections.py`).
Switch Console starts, completes, follows and drops a flow as the signed-in
person; `authorize` and `callback` are the browser's, in core mode, and are
tied to the flow by its state and a cookie rather than by a session.

The gateway starts a flow too (`POST …/flows/web`), which the callback
finishes itself and returns to the connector's page. Only there does the
callback read the browser's Switch session: the connection is written for
the person who started the flow, so the browser must be theirs. Without that
check, someone could start a sign-in and send the link to another person,
whose account at the vendor would then be connected as theirs.
"""

from __future__ import annotations

import logging
from html import escape
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
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
    Exchange,
    FlowError,
    ServiceFlow,
    ServiceFlows,
    get_service_flows,
)
from switch_core.db.models import ServiceConnection, Tenant, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, session_belongs_to
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.service_connections import service_refusal

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/service-connections/{service}/flows")
TOKEN_PATTERN = r"^[A-Za-z0-9_-]{43}$"
# A browser back with a flow that is gone: whichever way it started, the
# person starts again where they began.
LOST = "Sign-in was interrupted or took too long. Connect again."
NOT_YOURS = (
    "This sign-in was started by someone else, or you are no longer signed in "
    "to Switch. Sign in, and connect again from Connectors."
)


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


class FlowSecret(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completion_secret: str = Field(pattern=TOKEN_PATTERN)


class CompleteFlow(FlowSecret):
    code: str = Field(min_length=1, max_length=MAX_CODE_LENGTH)


async def _owners_browser(
    request: Request,
    flow: ServiceFlow,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> bool:
    """Whether the browser is signed in to Switch as the person who started
    `flow`, in a workspace they may still use."""
    return await session_belongs_to(
        request,
        session_factory,
        user_store,
        config,
        user_id=flow.user_id,
        tenant_id=flow.tenant_id,
    )


def connector_page(service: str, state: str) -> str:
    """The gateway page a sign-in started there returns to: the connector's,
    which reads the flow's outcome by its id."""
    return f"/connectors/{service}?" + urlencode({"sign_in": state})


@router.post("/web", response_model=None)
async def start_web(
    service: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
) -> dict | JSONResponse:
    """Begin signing in from the gateway: the browser goes to `url`, and
    comes back to the connector's page with the flow's id."""
    try:
        await broker.require_workspace_enabled(session, service)
        definition, _ = await broker.sign_in(session, service)
    except ServiceError as error:
        return service_refusal(error)
    tenant = await session.get(Tenant, require_tenant_id())
    if tenant is None:
        raise HTTPException(404, "Workspace not found.")
    try:
        flow = await flows.start_web(
            definition=definition,
            tenant_id=require_tenant_id(),
            user_id=user.id,
            owner_label=f"{user.name} ({user.email}) in {tenant.name}",
        )
    except FlowError as error:
        raise HTTPException(409, str(error)) from None
    return {"id": flow.state, "url": flows.authorize_url(service, flow.state)}


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
        definition, adapter = await broker.sign_in(session, service)
    except ServiceError as error:
        return service_refusal(error)
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


_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _secure_cookie(request: Request) -> bool:
    """Whether the flow's cookie is marked Secure: always, except on a server
    reached over plain http on this computer's own address, such as one
    Switch Console runs. Some browsers drop a Secure cookie set over http
    even there, and on the loopback address nothing in between could read it.
    """
    return not (
        request.url.scheme == "http" and request.url.hostname in _LOOPBACK_HOSTS
    )


@router.get("/authorize")
async def authorize(
    service: str,
    state: str,
    request: Request,
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    flows: Annotated[ServiceFlows, Depends(get_service_flows)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> Response:
    """The browser leaves for the vendor through Core, which marks it.

    Nobody need be signed in here, so the workspace is the flow's: its app
    is the one the browser is sent to. A flow the gateway started leaves
    only with its owner's browser, which it returns to."""
    try:
        flow = await flows.flow(state)
        if flow.service != service or flow.mode != "core":
            raise FlowError(INTERRUPTED)
    except FlowError:
        return _page("Connections", LOST, 400)
    if flow.on_web and not await _owners_browser(
        request, flow, session_factory, user_store, config
    ):
        return _page(flow.name, NOT_YOURS, 403)
    refusal: ServiceError | None
    async with tenant_session(session_factory, flow.tenant_id) as session:
        try:
            definition, adapter = await broker.sign_in(session, service)
        except ServiceError as error:
            refusal = error
        else:
            refusal = None
    if refusal is not None:
        await flows.refused(flow, refusal.message)
        if flow.on_web:
            return _returned(request, flow, connector_page(service, state))
        return _page("Connections", escape(refusal.message), refusal.status_code)
    try:
        url, nonce = await flows.vendor_url(flow, adapter)
    except (FlowError, ServiceAdapterError):
        return _page(definition.name, flow.interrupted, 400)
    response = RedirectResponse(
        url, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
    )
    response.set_cookie(
        _cookie(state),
        nonce,
        max_age=600,
        secure=_secure_cookie(request),
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
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> Response:
    """Back from the vendor: the browser takes the code on to Switch Console,
    on the computer it left from, or, for a sign-in started in the gateway,
    Core finishes it here and sends the browser back to the gateway."""
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    try:
        flow = await flows.flow(state)
        if flow.service != service:
            raise FlowError(INTERRUPTED)
    except FlowError:
        return _page("Connections", LOST, 400)
    if flow.on_web:
        return await _finish_on_web(
            request,
            flow,
            code,
            flows=flows,
            broker=broker,
            session_factory=session_factory,
            user_store=user_store,
            config=config,
        )
    try:
        target = await flows.deliver(
            flow, code, request.cookies.get(_cookie(state), "")
        )
    except FlowError:
        return _page("Connections", INTERRUPTED, 400)
    return _returned(request, flow, target)


def _returned(request: Request, flow: ServiceFlow, target: str) -> Response:
    """The browser sent on from the callback, its flow cookie spent."""
    response = RedirectResponse(
        target,
        status_code=303,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
    response.delete_cookie(
        _cookie(flow.state),
        path=_cookie_path(flow.service),
        secure=_secure_cookie(request),
        httponly=True,
        samesite="lax",
    )
    return response


async def _finish_on_web(
    request: Request,
    flow: ServiceFlow,
    code: str,
    *,
    flows: ServiceFlows,
    broker: ServiceBroker,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    config: SwitchConfig,
) -> Response:
    """A sign-in started in the gateway, back from the vendor: Core
    exchanges the code and writes the connection, for the person whose
    session the browser carries and who started it, then returns the
    browser to the connector's page, where the flow says how it ended."""
    if not await _owners_browser(request, flow, session_factory, user_store, config):
        return _page(flow.name, NOT_YOURS, 403)
    back = connector_page(flow.service, flow.state)
    async with tenant_session(session_factory, flow.tenant_id) as session:
        try:
            _, adapter = await broker.sign_in(session, flow.service)
        except ServiceError as error:
            await flows.ended(flow, error.message)
            return _returned(request, flow, back)
        try:
            exchange = await flows.finish_web(
                flow,
                code=code,
                nonce=request.cookies.get(_cookie(flow.state), ""),
                adapter=adapter,
            )
        except FlowError:
            # The flow ended with why, for the page to say.
            return _returned(request, flow, back)
        await _connect(session, broker, flows, exchange, flow.user_id)
    return _returned(request, flow, back)


async def _connect(
    session: AsyncSession,
    broker: ServiceBroker,
    flows: ServiceFlows,
    exchange: Exchange,
    user_id: str,
) -> dict | JSONResponse:
    """Write the connection an exchange signed in, for `user_id` in the
    session's workspace, and settle its flow: connected, or failed with why.
    Answers as `complete` does."""
    service = exchange.flow.service
    try:
        consent = flows.consent(exchange)
    except FlowError as error:
        await flows.failed(exchange.flow, str(error))
        return JSONResponse(status_code=400, content={"detail": str(error)})
    account, signed_in = exchange.account, exchange.signed_in
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"service-link:{require_tenant_id()}:{service}"},
    )
    taken = await session.scalar(
        select(ServiceConnection.user_id).where(
            ServiceConnection.tenant_id == require_tenant_id(),
            ServiceConnection.service == service,
            ServiceConnection.user_id != user_id,
            ServiceConnection.account_id == account.account_id,
        )
    )
    if taken is not None:
        linked = (
            f"This {exchange.flow.details['name']} account is already linked to "
            "another Switch user in this workspace. Remove that link first."
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
            user_id=user_id,
            service=service,
            consent=consent,
            granted_scopes=signed_in.granted_scopes,
            account_id=account.account_id,
            external_identity=account.label,
            secret=signed_in.secret,
            oauth_client_id=signed_in.client_id,
        )
    except ServiceError as error:
        await flows.failed(exchange.flow, error.message)
        return service_refusal(error)
    await flows.connected(exchange, warning)
    logger.info(
        "Service account linked: tenant=%s user=%s service=%s",
        require_tenant_id(),
        user_id,
        service,
    )
    return {"warning": warning, "consent": consent, "account": account.label}


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
        _, adapter = await broker.sign_in(session, service)
    except ServiceError as error:
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
    return await _connect(session, broker, flows, exchange, user.id)


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
