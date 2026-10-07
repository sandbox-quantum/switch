"""The routes an agent controller calls, mounted on the agent bridge.

All but two authenticate with a controller access token, which the bearer
middleware verifies and binds (`management/auth.py`); a route whose path
names a controller then requires it to be the token's own. Enrollment and
token exchange carry their secret in the body and resolve their tenant from
it here.

The controller's connection (`/v1/controllers/{id}/connection` and its
socket) is Core's: these routes authenticate and parse, and Core's
`ControllerPresence` and controller stream do the rest. Management only adds its nudges and the first frame's
assignment revision.

Every failure is answered in the contract's error envelope (`errors.py`).
`Switch-Controller-Protocol` is checked when sent, and every response says
which protocol versions this server accepts. Protocol 2 moved the stream and
the beat onto one WebSocket; a protocol 1 controller is refused with 426.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable, Coroutine
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    Header,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.dependencies import get_protocol, get_session
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnectionError,
)
from switch_core.bridges.agent.protocol.controller_stream import (
    IDLE,
    IDLE_INTERVAL_SECONDS,
    ControllerFrame,
    controller_event_stream,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_INTERVAL_SECONDS
from switch_core.db.session_scope import tenant_session
from switch_core.management import reason_codes
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.dependencies import (
    get_authenticator,
    get_controller_principal,
    get_management,
    get_management_session_factory,
    require_controller,
)
from switch_core.management.errors import ManagementError, ManagementRoute, error_body
from switch_core.management.schemas import (
    MAX_STATUS_BYTES,
    ControllerConnectionRequest,
    DefinitionV1,
    EnrollRequest,
    OperationResultRequest,
    ProgressRequest,
    StatusReport,
    TokenRequest,
    wire_time,
)
from switch_core.management.service import ManagementService

logger = logging.getLogger(__name__)

PROTOCOL_HEADER = "Switch-Controller-Protocol"
PROTOCOL_ACCEPTS_HEADER = "Switch-Controller-Protocol-Accepts"
SUPPORTED_PROTOCOLS = "2-2"
_SUPPORTED_PROTOCOL_VERSIONS = frozenset({"2"})


class ControllerRoute(ManagementRoute):
    """A management route that also speaks the controller protocol header."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def versioned(request: Request) -> Response:
            requested = request.headers.get(PROTOCOL_HEADER)
            if requested is not None and requested.strip() not in (
                _SUPPORTED_PROTOCOL_VERSIONS
            ):
                response: Response = JSONResponse(
                    error_body(
                        reason_codes.PROTOCOL_UNSUPPORTED,
                        f"Controller protocol {requested!r} is not supported; "
                        f"this server accepts {SUPPORTED_PROTOCOLS}.",
                        retryable=False,
                    ),
                    status_code=426,
                )
            else:
                response = await handler(request)
            response.headers[PROTOCOL_ACCEPTS_HEADER] = SUPPORTED_PROTOCOLS
            return response

        return versioned


router = APIRouter(route_class=ControllerRoute, tags=["agent management"])

Principal = Annotated[ControllerPrincipal, Depends(get_controller_principal)]
Management = Annotated[ManagementService, Depends(get_management)]
Session = Annotated[AsyncSession, Depends(get_session)]
Protocol = Annotated[AgentCore, Depends(get_protocol)]


def _path_controller(controller_id: str, principal: Principal) -> ControllerPrincipal:
    return require_controller(controller_id, principal)


PathController = Annotated[ControllerPrincipal, Depends(_path_controller)]


# Part of every assignment ETag, so a controller holding an assignment saved
# under an earlier definition format pulls it again rather than being told it
# is unchanged.
ASSIGNMENT_FORMAT = hashlib.sha256(
    json.dumps(DefinitionV1.model_json_schema(), sort_keys=True).encode()
).hexdigest()[:12]


def _etag(revision: int) -> str:
    return f'"{ASSIGNMENT_FORMAT}-{revision}"'


def _etag_matches(if_none_match: str | None, revision: int) -> bool:
    if if_none_match is None:
        return False
    for candidate in if_none_match.split(","):
        tag = candidate.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == _etag(revision):
            return True
    return False


# ── Public: authenticated by the body ─────────────────────────────────────────


@router.post("/v1/management/controllers/enroll", status_code=201)
async def enroll_controller(
    body: EnrollRequest,
    management: Management,
    authenticator: Annotated[ManagementAuthenticator, Depends(get_authenticator)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
) -> dict[str, str]:
    tenant_id = await authenticator.tenant_of_secret(body.proof.code)
    if tenant_id is None:
        raise ManagementError(
            401,
            reason_codes.ENROLLMENT_CODE_INVALID,
            "The enrollment code is invalid, already used, or expired.",
        )
    async with tenant_session(session_factory, tenant_id) as session:
        controller, credential = await management.enroll(
            session,
            tenant_id,
            code=body.proof.code,
            description=body.controller,
            public_key=body.public_key,
        )
    return {"controller_id": controller.id, "credential": credential}


@router.post("/v1/management/controllers/{controller_id}/token")
async def exchange_token(
    controller_id: str,
    body: TokenRequest,
    management: Management,
    authenticator: Annotated[ManagementAuthenticator, Depends(get_authenticator)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
) -> dict[str, str]:
    tenant_id = await authenticator.tenant_of_secret(body.credential)
    if tenant_id is None:
        raise ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "The credential is not valid."
        )
    async with tenant_session(session_factory, tenant_id) as session:
        access_token, expires_at = await management.exchange_token(
            session,
            tenant_id,
            controller_id=controller_id,
            credential=body.credential,
        )
    return {"access_token": access_token, "expires_at": wire_time(expires_at)}


# ── Controller access token ───────────────────────────────────────────────────


@router.post("/v1/management/controllers/{controller_id}/credential/rotate")
async def rotate_credential(
    principal: PathController, management: Management, session: Session
) -> dict[str, str]:
    return {"credential": await management.rotate_credential(session, principal)}


@router.get("/v1/management/controllers/{controller_id}/assignment")
async def get_assignment(
    principal: PathController,
    management: Management,
    session: Session,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    assignment = await management.assignment(session, principal)
    revision = assignment["revision"]
    headers = {"ETag": _etag(revision)}
    if _etag_matches(if_none_match, revision):
        return Response(status_code=304, headers=headers)
    return JSONResponse(assignment, headers=headers)


@router.put("/v1/management/controllers/{controller_id}/status")
async def put_status(
    request: Request,
    report: StatusReport,
    principal: PathController,
    management: Management,
    session: Session,
) -> dict[str, int]:
    if len(await request.body()) > MAX_STATUS_BYTES:
        raise ManagementError(
            413,
            reason_codes.VALIDATION_ERROR,
            f"A status report may be at most {MAX_STATUS_BYTES} bytes.",
        )
    return await management.record_status(session, principal, report)


@router.get("/v1/management/controllers/{controller_id}/operations")
async def list_operations(
    principal: PathController,
    management: Management,
    session: Session,
    state: str = "pending",
) -> dict[str, list[dict[str, Any]]]:
    if state != "pending":
        raise ManagementError(
            422,
            reason_codes.VALIDATION_ERROR,
            "Only state=pending can be listed by a controller.",
        )
    return {"operations": await management.offered_operations(session, principal)}


@router.post("/v1/management/operations/{operation_id}/claim")
async def claim_operation(
    operation_id: str, principal: Principal, management: Management, session: Session
) -> dict[str, Any]:
    return await management.claim_operation(session, principal, operation_id)


@router.post("/v1/management/operations/{operation_id}/progress", status_code=204)
async def operation_progress(
    operation_id: str,
    principal: Principal,
    management: Management,
    session: Session,
    body: ProgressRequest | None = None,
) -> Response:
    await management.renew_operation(session, principal, operation_id)
    return Response(status_code=204)


@router.post("/v1/management/operations/{operation_id}/result", status_code=204)
async def operation_result(
    operation_id: str,
    body: OperationResultRequest,
    principal: Principal,
    management: Management,
    session: Session,
) -> Response:
    await management.complete_operation(session, principal, operation_id, body.stored())
    return Response(status_code=204)


# ── The controller's stream ──────────────────────────────────────────────────


def _connection_refusal(exc: ControllerConnectionError) -> ManagementError:
    status = {
        reason_codes.UNKNOWN_CONNECTION: 404,
        reason_codes.CONTROLLER_REVOKED: 401,
    }.get(exc.code, 409)
    return ManagementError(status, exc.code, str(exc))


def _rooms_reader(protocol: AgentCore) -> Callable[[str], Awaitable[set[str]]]:
    async def rooms_of(agent_id: str) -> set[str]:
        rooms = await protocol.list_rooms(agent_id, include_archived=True)
        return {room.id for room in rooms}

    return rooms_of


@router.post("/v1/controllers/{controller_id}/connection", status_code=201)
async def open_connection(
    body: ControllerConnectionRequest,
    principal: PathController,
    protocol: Protocol,
) -> dict[str, Any]:
    """Open the controller's connection, taking over any it had.

    The agents bound to it are attached on the stream, each from its cursor
    here; the response names them. Opening again is a takeover: the earlier
    connection's socket ends with `taken_over`, and its beats are refused.
    """
    presence = protocol.connections.controllers
    try:
        conn = presence.open(
            controller_id=principal.controller_id,
            tenant_id=principal.tenant_id,
            resume_cursors=body.resume_cursors(),
        )
    except ControllerConnectionError as exc:
        raise _connection_refusal(exc) from exc
    logger.info(
        "Controller %s opened connection %s (client=%s version=%s)",
        principal.controller_id,
        conn.id,
        body.client or "unknown",
        body.client_version or "unknown",
    )
    return {
        "connection_id": conn.id,
        "generation": conn.generation,
        "heartbeat_interval_s": HEARTBEAT_INTERVAL_SECONDS,
        "agents": sorted(presence.agents_of(principal.controller_id)),
    }


async def attach_stream(
    *,
    principal: ControllerPrincipal,
    management: ManagementService,
    protocol: AgentCore,
    session_factory: async_sessionmaker[AsyncSession],
    connection_id: str,
    generation: int,
) -> AsyncGenerator[ControllerFrame]:
    """Attach the stream to an open connection: its agents' events and the
    management nudges, starting with `connection_state`.

    The nudge subscription is taken before the first frame is built, so a
    change that commits while the stream is opening is still delivered.
    Raises the refusal when the connection cannot take a stream.
    """
    presence = protocol.connections.controllers
    nudges = management.notifier.subscribe(principal.controller_id)
    try:
        conn = presence.require(principal.controller_id, connection_id, generation)
        async with tenant_session(session_factory, principal.tenant_id) as session:
            state = await management.connection_state(session, principal)
    except ControllerConnectionError as exc:
        nudges.close()
        raise _connection_refusal(exc) from exc
    except BaseException:
        nudges.close()
        raise
    opening = {
        **state,
        "connection_id": conn.id,
        "generation": conn.generation,
        "heartbeat_interval_s": HEARTBEAT_INTERVAL_SECONDS,
    }
    token = presence.attach_stream(conn)
    return controller_event_stream(
        conn=conn,
        stream_token=token,
        presence=presence,
        buffer=protocol.event_buffer,
        approvals=protocol.approval_outcomes,
        nudges=nudges,
        opening=opening,
        rooms_of=_rooms_reader(protocol),
        idle_seconds=IDLE_INTERVAL_SECONDS,
    )


def record_beat(
    *,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    connection_id: str,
    generation: int,
    cursors: dict[str, int],
) -> list[str]:
    """Keep the controller, and so every agent on it, live; confirm cursors.

    A pong on the socket, every heartbeat interval; six seconds without one
    and its agents are not live. The cursors confirmed here are where a
    stream reattached to this connection resumes each agent. Raises the
    presence's refusal: `taken_over` once another connection has replaced
    this one, terminal for the client, and `no_stream` or
    `unknown_connection` when the connection has to be opened again.
    """
    presence = protocol.connections.controllers
    conn = presence.beat(principal.controller_id, connection_id, generation)
    agents = presence.agents_of(principal.controller_id)
    for agent_id, cursor in cursors.items():
        binding = presence.binding(agent_id)
        if agent_id not in agents or binding is None:
            continue
        # Clamped to the head, as an agent's own beat is: a higher number
        # belongs to a previous life of this process.
        confirmed = min(cursor, protocol.event_buffer.head(agent_id))
        protocol.event_buffer.confirm(agent_id, presence.holder_id(binding), confirmed)
        presence.resume_from(conn, agent_id, confirmed)
    return sorted(agents)


def _refused(error: ManagementError) -> dict[str, Any]:
    """The frame a refused socket gets before it closes with 4000 + status,
    as the bearer middleware sends its own refusals."""
    return {
        "event": "refused",
        "data": {
            "status": error.status_code,
            "detail": {"code": error.code, "message": error.message},
        },
    }


def _cursors_of(message: dict[str, Any]) -> dict[str, int]:
    raw = message.get("cursors")
    if not isinstance(raw, dict):
        return {}
    return {
        agent_id: cursor
        for agent_id, cursor in raw.items()
        if isinstance(agent_id, str)
        and isinstance(cursor, int)
        and not isinstance(cursor, bool)
        and cursor >= 0
    }


@router.websocket("/v1/controllers/{controller_id}/connection/ws")
async def connection_socket(
    websocket: WebSocket,
    controller_id: str,
    management: Management,
    protocol: Protocol,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
    connection_id: str,
    generation: int,
) -> None:
    """The controller's one connection: its agents' events and the management
    nudges down, its heartbeat up, on one WebSocket.

    Attaches to a connection opened with `POST .../connection`. Frames are
    JSON `{"event", "data"}`, the events the stream carries. The server sends
    `{"event": "ping"}` every heartbeat interval and the controller answers
    `{"type": "pong", "cursors": {agent_id: n}}`, which is its beat. A refused
    attach is a `refused` frame, then a close with 4000 plus the status; a
    refused beat is an `evicted` frame naming why, then a close.
    """
    await websocket.accept()
    try:
        principal = _socket_principal(websocket, controller_id)
        frames = await attach_stream(
            principal=principal,
            management=management,
            protocol=protocol,
            session_factory=session_factory,
            connection_id=connection_id,
            generation=generation,
        )
    except ManagementError as error:
        await websocket.send_json(_refused(error))
        await websocket.close(code=4000 + error.status_code)
        return

    outbox: asyncio.Queue[ControllerFrame] = asyncio.Queue(maxsize=_SOCKET_OUTBOX)
    pump = asyncio.create_task(_pump(frames, outbox))
    pongs = asyncio.create_task(
        _receive_pongs(websocket, principal, protocol, connection_id, generation)
    )
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + HEARTBEAT_INTERVAL_SECONDS
    try:
        # One writer: frames and pings both go out from this loop.
        while not pump.done() or not outbox.empty():
            if pongs.done():
                refusal = pongs.result()
                if refusal is not None:
                    await websocket.send_json(
                        {
                            "event": "evicted",
                            "data": {"code": refusal.code, "reason": str(refusal)},
                        }
                    )
                return
            try:
                frame = await asyncio.wait_for(
                    outbox.get(), timeout=max(0.0, next_ping - loop.time())
                )
            except TimeoutError:
                frame = None
            if frame is not None and frame is not IDLE:
                await websocket.send_json(frame)
            if loop.time() >= next_ping:
                await websocket.send_json({"event": "ping", "data": {}})
                next_ping = loop.time() + HEARTBEAT_INTERVAL_SECONDS
    except WebSocketDisconnect:
        return
    except RuntimeError:
        # The server closed the socket under us (uvicorn does on shutdown).
        return
    finally:
        pump.cancel()
        pongs.cancel()
        failure = pump.exception() if pump.done() and not pump.cancelled() else None
        if failure is not None:
            logger.error(
                "Controller %s connection %s: delivery failed, closing its socket",
                principal.controller_id,
                connection_id,
                exc_info=failure,
            )
        try:
            await websocket.close(code=1011 if failure is not None else 1000)
        except RuntimeError:
            pass  # the client closed it first


# Frames buffered between the stream and the socket.
_SOCKET_OUTBOX = 64


def _socket_principal(websocket: WebSocket, controller_id: str) -> ControllerPrincipal:
    """The controller the bearer middleware authenticated, checked against the
    path and the protocol it declares, as the HTTP routes check theirs."""
    requested = websocket.headers.get(PROTOCOL_HEADER)
    if requested is not None and requested.strip() not in _SUPPORTED_PROTOCOL_VERSIONS:
        raise ManagementError(
            426,
            reason_codes.PROTOCOL_UNSUPPORTED,
            f"Controller protocol {requested!r} is not supported; "
            f"this server accepts {SUPPORTED_PROTOCOLS}.",
        )
    return require_controller(controller_id, get_controller_principal(websocket))


async def _pump(
    frames: AsyncGenerator[ControllerFrame], outbox: asyncio.Queue[ControllerFrame]
) -> None:
    # Closed here: cancelled while waiting on the outbox, the stream would
    # otherwise detach only when the generator is garbage collected.
    try:
        async for frame in frames:
            await outbox.put(frame)
    finally:
        await frames.aclose()


async def _receive_pongs(
    websocket: WebSocket,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    connection_id: str,
    generation: int,
) -> ControllerConnectionError | None:
    """Turn each pong into a beat, until the controller goes or a beat is
    refused. Returns the refusal, so the socket can say which before it
    closes; None when the controller simply went away."""
    while True:
        try:
            message = await websocket.receive_json()
        except (WebSocketDisconnect, ValueError, RuntimeError):
            return None
        if not isinstance(message, dict) or message.get("type") != "pong":
            continue
        try:
            record_beat(
                principal=principal,
                protocol=protocol,
                connection_id=connection_id,
                generation=generation,
                cursors=_cursors_of(message),
            )
        except ControllerConnectionError as refusal:
            return refusal
