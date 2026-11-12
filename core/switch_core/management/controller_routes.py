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
from collections import deque
from collections.abc import AsyncGenerator, Awaitable, Callable, Coroutine
from datetime import UTC, datetime
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
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.commands import RESET_NOT_SENT
from switch_core.bridges.agent.dependencies import get_protocol, get_session
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import (
    ConnectionNotLetGoError,
    ControllerConnectionError,
    ControllerRevokedError,
)
from switch_core.bridges.agent.protocol.controller_stream import (
    IDLE,
    IDLE_INTERVAL_SECONDS,
    ControllerFrame,
    controller_event_stream,
)
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import AuditEvent
from switch_core.db.session_scope import tenant_session
from switch_core.delivery.rest_notice import (
    MAX_REST_KEY_LENGTH,
    MAX_STOPPED,
    rest_notice_key,
    rest_notice_text,
)
from switch_core.delivery.restart_notice import (
    MAX_TURN_ID_LENGTH,
    RESTART_NOTICE_TEXT,
    restart_notice_key,
)
from switch_core.file_requests import FILES_REPLY, file_requests
from switch_core.hosted_v2 import require_hosted_v2_here
from switch_core.management import reason_codes, socket_calls
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
    ControllerInfoRequest,
    DefinitionV1,
    EnrollRequest,
    OperationResultRequest,
    ProgressRequest,
    StatusReport,
    TokenRequest,
    wire_time,
)
from switch_core.management.service import ManagementService
from switch_core.management.wake_replay import resume_cursors_after_wake

logger = logging.getLogger(__name__)

PROTOCOL_HEADER = "Switch-Controller-Protocol"
PROTOCOL_ACCEPTS_HEADER = "Switch-Controller-Protocol-Accepts"
SUPPORTED_PROTOCOLS = "2-2"
_SUPPORTED_PROTOCOL_VERSIONS = frozenset({"2"})

# How often the server pings a controller's socket. A controller released
# before it learnt to wait three of the server's beats (switch#994) calls its
# socket dead after 10 seconds with nothing on it, pings included, and never
# changes that. At the heartbeat interval of the agent sockets (10 seconds)
# such a controller dropped a healthy socket whenever a ping came a moment
# late, so every few seconds its agents read as connecting. Half of that keeps
# one late ping from costing the socket. The beat's TTL is unchanged.
PING_INTERVAL_SECONDS = 5.0

# How long a socket reattaching through this process waits for the process
# that held its connection to record the socket going, and how often it reads
# the controller's row again meanwhile. The holder records it as the socket
# goes, in one write, and a controller waits at least a quarter of a second
# before it reattaches; only a holder that is slow to write, or never saw its
# socket go, runs this out, and the controller then opens a new connection.
LET_GO_WAIT_SECONDS = 2.0
LET_GO_POLL_SECONDS = 0.1


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
                        f"Switch accepts {SUPPORTED_PROTOCOLS}.",
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


@router.patch("/v1/management/controllers/{controller_id}")
async def update_controller_info(
    body: ControllerInfoRequest,
    principal: PathController,
    management: Management,
    session: Session,
) -> dict[str, Any]:
    """Rename this machine and/or change its description, as its owner can
    in the gateway. Returns the machine as the owner's list shows it."""
    return await management.update_own_controller(
        session,
        principal,
        {key: getattr(body, key) for key in body.model_fields_set},
    )


@router.get(
    "/v1/management/controllers/{controller_id}/provider-credentials/{provider}"
)
async def get_sealed_login(
    provider: str, principal: PathController, management: Management, session: Session
) -> JSONResponse:
    """The provider login given to this machine, sealed to its own key, or
    404 `provider_login_missing`."""
    return JSONResponse(
        await management.own_sealed_login(session, principal, provider),
        headers={"Cache-Control": "no-store"},
    )


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
) -> dict[str, Any]:
    if len(await request.body()) > MAX_STATUS_BYTES:
        raise ManagementError(
            413,
            reason_codes.VALIDATION_ERROR,
            f"A status report may be at most {MAX_STATUS_BYTES} bytes.",
        )
    return await management.record_status(session, principal, report)


class RestartNoticeRequest(BaseModel):
    """Where a turn the box's restart cut off was asked: the room, the thread
    if any, and the turn. The text is Core's, not the controller's."""

    model_config = ConfigDict(extra="forbid")
    room_id: str = Field(min_length=1, max_length=200)
    thread_id: str | None = Field(default=None, min_length=1, max_length=200)
    # It goes into the sender's key and the audit record: plain characters only.
    turn_id: str = Field(
        min_length=1, max_length=MAX_TURN_ID_LENGTH, pattern=r"^[A-Za-z0-9:_-]+$"
    )


@router.post(
    "/v1/management/controllers/{controller_id}/agents/{agent_id}/restart-notice",
    # v2's notices: with hosted agents v2 off, as if absent (404).
    dependencies=[Depends(require_hosted_v2_here)],
)
async def post_restart_notice(
    agent_id: str,
    request: RestartNoticeRequest,
    principal: PathController,
    management: Management,
    protocol: Protocol,
    session: Session,
) -> dict[str, str]:
    """Tell a room, as the agent, that its host restarted mid-turn.

    Only for an agent bound to this controller, only in a room the agent may
    post in, and only Core's fixed text. Posted under `restart:<turn_id>` for
    the agent, so a retry whose answer was lost, or a later start, returns the
    first notice instead of posting a second.
    """
    if not await management.controls_agent(session, principal, agent_id):
        raise ManagementError(
            404, reason_codes.NOT_FOUND, "No agent of this controller has that id."
        )
    try:
        sent = await protocol.send_message(
            agent_id,
            request.room_id,
            RESTART_NOTICE_TEXT,
            request.thread_id,
            client_txn_id=restart_notice_key(request.turn_id),
        )
        event_id = sent.event_id
    except PermissionError as exc:
        raise ManagementError(403, reason_codes.FORBIDDEN, str(exc)) from exc
    except ValueError as exc:
        raise ManagementError(
            409, reason_codes.VALIDATION_ERROR, str(exc), retryable=True
        ) from exc
    # Every notice Switch posts in an agent's name is on the tenant's record,
    # retries included (the key makes them one message, not one event); a
    # retry that returned an earlier notice says so.
    deduplicated = await _already_audited(
        session,
        principal.tenant_id,
        agent_id,
        AuditAction.AGENT_RESTART_NOTICE_POSTED,
        event_id,
    )
    await record_audit_event(
        session,
        tenant_id=principal.tenant_id,
        actor_user_id=None,
        action=AuditAction.AGENT_RESTART_NOTICE_POSTED,
        target_type="agent",
        target_id=agent_id,
        details={
            "by": "controller",
            "controller_id": principal.controller_id,
            "room_id": request.room_id,
            "thread_id": request.thread_id,
            "turn_id": request.turn_id,
            "event_id": event_id,
            **({"deduplicated": True} if deduplicated else {}),
        },
    )
    await session.commit()
    return {"event_id": event_id}


async def _already_audited(
    session: AsyncSession,
    tenant_id: str,
    agent_id: str,
    action: AuditAction,
    event_id: str,
) -> bool:
    """Whether a notice posted as `agent_id` under `action` already recorded
    `event_id`: a keyed retry got the first notice back instead of a new one."""
    found = await session.scalar(
        select(AuditEvent.id)
        .where(
            AuditEvent.tenant_id == tenant_id,
            AuditEvent.target_type == "agent",
            AuditEvent.target_id == agent_id,
            AuditEvent.action == action,
            AuditEvent.details["event_id"].astext == event_id,
        )
        .limit(1)
    )
    return found is not None


class RestNoticeRequest(BaseModel):
    """Where the agent's first message after a rest came from, the wake's
    key, and how many of its background processes were stopped as it went to
    rest. A count only: the text is Core's, not the controller's."""

    model_config = ConfigDict(extra="forbid")
    room_id: str = Field(min_length=1, max_length=200)
    thread_id: str | None = Field(default=None, min_length=1, max_length=200)
    # It goes into the sender's key and the audit record: plain characters only.
    key: str = Field(
        min_length=1, max_length=MAX_REST_KEY_LENGTH, pattern=r"^[A-Za-z0-9:_-]+$"
    )
    stopped: int = Field(ge=1, le=MAX_STOPPED, strict=True)


@router.post(
    "/v1/management/controllers/{controller_id}/agents/{agent_id}/rest-notice",
    dependencies=[Depends(require_hosted_v2_here)],
)
async def post_rest_notice(
    agent_id: str,
    request: RestNoticeRequest,
    principal: PathController,
    management: Management,
    protocol: Protocol,
    session: Session,
) -> dict[str, str]:
    """Tell a room, as the agent, that background processes it left running
    were stopped when it went to rest.

    The same rules as the restart notice: only for an agent bound to this
    controller, only in a room the agent may post in, and only Core's fixed
    text. Posted under `rest:<key>` for the agent, so a retry whose answer
    was lost returns the first notice instead of posting a second.
    """
    if not await management.controls_agent(session, principal, agent_id):
        raise ManagementError(
            404, reason_codes.NOT_FOUND, "No agent of this controller has that id."
        )
    try:
        sent = await protocol.send_message(
            agent_id,
            request.room_id,
            rest_notice_text(request.stopped),
            request.thread_id,
            client_txn_id=rest_notice_key(request.key),
        )
        event_id = sent.event_id
    except PermissionError as exc:
        raise ManagementError(403, reason_codes.FORBIDDEN, str(exc)) from exc
    except ValueError as exc:
        raise ManagementError(
            409, reason_codes.VALIDATION_ERROR, str(exc), retryable=True
        ) from exc
    # A row for every attempt, retries included, the same as the restart
    # notice; one whose key returned an earlier notice says so.
    deduplicated = await _already_audited(
        session,
        principal.tenant_id,
        agent_id,
        AuditAction.AGENT_REST_NOTICE_POSTED,
        event_id,
    )
    await record_audit_event(
        session,
        tenant_id=principal.tenant_id,
        actor_user_id=None,
        action=AuditAction.AGENT_REST_NOTICE_POSTED,
        target_type="agent",
        target_id=agent_id,
        details={
            "by": "controller",
            "controller_id": principal.controller_id,
            "room_id": request.room_id,
            "thread_id": request.thread_id,
            "key": request.key,
            "stopped": request.stopped,
            "event_id": event_id,
            **({"deduplicated": True} if deduplicated else {}),
        },
    )
    await session.commit()
    return {"event_id": event_id}


class ResetRefusedRequest(BaseModel):
    """Where a `!reset` the box could not hand to any session was typed: the
    room, its thread if any, and the command. The text is Core's."""

    model_config = ConfigDict(extra="forbid")
    room_id: str = Field(min_length=1, max_length=200)
    thread_id: str | None = Field(default=None, min_length=1, max_length=200)
    # It goes into the sender's key and the audit record: plain characters only.
    command_id: str = Field(
        min_length=1, max_length=MAX_TURN_ID_LENGTH, pattern=r"^[A-Za-z0-9:_-]+$"
    )


@router.post(
    "/v1/management/controllers/{controller_id}/agents/{agent_id}/reset-refused",
    dependencies=[Depends(require_hosted_v2_here)],
)
async def post_reset_refused(
    agent_id: str,
    request: ResetRefusedRequest,
    principal: PathController,
    management: Management,
    protocol: Protocol,
    session: Session,
) -> dict[str, str]:
    """Tell a room, as the agent, that its `!reset` could not be done.

    Core relays a controller's agent's reset without saying "Resetting my
    session", leaving the box to say how it went. Where the box has no
    session to say it as (no agent host running, or none working in that
    room), it asks here. As for the restart line: only for an agent bound to
    this controller, only where the agent may post, only Core's fixed text,
    keyed `reset-refused:<command_id>`, so asking again posts nothing new.
    """
    if not await management.controls_agent(session, principal, agent_id):
        raise ManagementError(
            404, reason_codes.NOT_FOUND, "No agent of this controller has that id."
        )
    try:
        sent = await protocol.send_message(
            agent_id,
            request.room_id,
            RESET_NOT_SENT,
            request.thread_id,
            client_txn_id=f"reset-refused:{request.command_id}",
        )
        event_id = sent.event_id
    except PermissionError as exc:
        raise ManagementError(403, reason_codes.FORBIDDEN, str(exc)) from exc
    except ValueError as exc:
        raise ManagementError(
            409, reason_codes.VALIDATION_ERROR, str(exc), retryable=True
        ) from exc
    await record_audit_event(
        session,
        tenant_id=principal.tenant_id,
        actor_user_id=None,
        action=AuditAction.AGENT_RESET_REFUSED_POSTED,
        target_type="agent",
        target_id=agent_id,
        details={
            "by": "controller",
            "controller_id": principal.controller_id,
            "room_id": request.room_id,
            "thread_id": request.thread_id,
            "command_id": request.command_id,
            "event_id": event_id,
        },
    )
    await session.commit()
    return {"event_id": event_id}


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
    management: Management,
    session: Session,
) -> dict[str, Any]:
    """Open the controller's connection, taking over any it had.

    The agents bound to it are attached on the stream, each from its cursor
    here; the response names them. Opening again is a takeover: the earlier
    connection's socket ends with `taken_over`, and its beats are refused,
    whichever process held it. The connection is recorded before the answer,
    so its socket can attach through any process.
    """
    presence = protocol.connections.controllers
    resume_cursors = body.resume_cursors()
    if presence.is_revoked(principal.controller_id):
        raise _connection_refusal(ControllerRevokedError(principal.controller_id))
    # A cloud machine's controller with no cursor for an agent gets what
    # arrived while it was down, such as the message that woke it (v2 only).
    resume_cursors = await resume_cursors_after_wake(
        session,
        protocol.event_buffer,
        tenant_id=principal.tenant_id,
        controller_id=principal.controller_id,
        resume_cursors=resume_cursors,
        now=datetime.now(UTC),
    )
    # Recorded before it is held: a read of the row in between would find the
    # connection this one replaces still named there, and close this one.
    identity = presence.new_connection()
    connection_id, generation = identity
    await management.record_opened(
        session,
        principal,
        connection_id=connection_id,
        generation=generation,
        resume_cursors=resume_cursors,
    )
    try:
        conn = presence.open(
            controller_id=principal.controller_id,
            tenant_id=principal.tenant_id,
            resume_cursors=resume_cursors,
            identity=identity,
        )
    except ControllerConnectionError as exc:
        raise _connection_refusal(exc) from exc
    logger.debug(
        "Controller %s opened connection %s (client=%s version=%s)",
        principal.controller_id,
        conn.id,
        body.client or "unknown",
        body.client_version or "unknown",
    )
    return {
        "connection_id": conn.id,
        "generation": conn.generation,
        "heartbeat_interval_s": PING_INTERVAL_SECONDS,
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
    loop = asyncio.get_running_loop()
    let_go_by = loop.time() + LET_GO_WAIT_SECONDS
    try:
        while True:
            try:
                async with tenant_session(
                    session_factory, principal.tenant_id
                ) as session:
                    # Wherever it was opened or last held: decided on the
                    # controller's row, which says whether it is still the
                    # one the controller opened last.
                    conn = await management.hold_connection(
                        session, principal, connection_id, generation
                    )
                    state = await management.connection_state(session, principal)
                break
            except ConnectionNotLetGoError:
                # Waited out of the session, so the wait holds no connection
                # to the database.
                if loop.time() >= let_go_by:
                    raise
                await asyncio.sleep(LET_GO_POLL_SECONDS)
        # Attached once nothing more is awaited, and refused if the connection
        # stopped being the controller's current one while the reads above
        # waited.
        token = presence.attach_stream(conn)
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
        "heartbeat_interval_s": PING_INTERVAL_SECONDS,
        # The socket takes its agents' operations as calls (`socket_calls`).
        "calls": socket_calls.calls_offered(),
    }
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


async def record_beat(
    *,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    connection_id: str,
    generation: int,
    cursors: dict[str, int],
) -> list[str]:
    """Keep the controller, and so every agent on it, live; confirm cursors.

    A pong on the socket, every heartbeat interval; `HEARTBEAT_TTL_SECONDS`
    without one and its agents are not live. The cursors confirmed here are where a
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
        sent = conn.sent_cursors.get(agent_id)
        if sent is None:
            continue
        # The controller reports how far it has read each agent's own events.
        # It cannot have read further than this connection has sent it. A
        # larger number comes from another history, a database restored from a
        # backup or another server, and keeping it would make the next stream
        # on this connection resume past events the agent never received. The
        # bound is kept in memory, so a beat costs no database query.
        presence.resume_from(conn, agent_id, min(cursor, sent))
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
    authenticator: Annotated[ManagementAuthenticator, Depends(get_authenticator)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
    connection_id: str,
    generation: int,
) -> None:
    """The controller's one connection: its agents' events and the management
    nudges down, its heartbeat and its agents' calls up, on one WebSocket.

    Attaches to a connection opened with `POST .../connection`. Frames are
    JSON `{"event", "data"}`, the events the stream carries. The server sends
    `{"event": "ping"}` every `PING_INTERVAL_SECONDS` and the controller answers
    `{"type": "pong", "cursors": {agent_id: n}}`, which is its beat. A
    `{"type": "call", ...}` runs one of its agents' operations and is answered
    with a `call.result` frame (`socket_calls`). A refused attach is a
    `refused` frame, then a close with 4000 plus the status; a refused beat is
    an `evicted` frame naming why, then a close.
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

    outbox = _Outbox(_SOCKET_OUTBOX)
    # Your cloud files: this process now holds the socket, so the owner's file
    # requests can go down it, on the answers' priority path.
    file_requests.socket_opened(principal.controller_id, outbox, outbox.put_answer)
    pump = asyncio.create_task(_pump(frames, outbox))
    receiver = asyncio.create_task(
        _receive(
            websocket,
            principal=principal,
            protocol=protocol,
            authenticator=authenticator,
            connection_id=connection_id,
            generation=generation,
            outbox=outbox,
        )
    )
    # The writer below waits on the outbox, up to the next ping. A controller
    # that goes, or a refused beat, wakes it at once: until the stream is let
    # go, its connection reads as held here, and the controller reattaching
    # through another process in the meantime is refused and opens a new one.
    receiver.add_done_callback(lambda _: outbox.wake())
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + PING_INTERVAL_SECONDS
    try:
        # One writer: frames, call answers and pings all go out from this loop.
        while not pump.done() or not outbox.empty():
            if receiver.done():
                refusal = receiver.result()
                if refusal is not None:
                    await websocket.send_json(
                        {
                            "event": "evicted",
                            "data": {"code": refusal.code, "reason": str(refusal)},
                        }
                    )
                return
            frame = await outbox.get(timeout=max(0.0, next_ping - loop.time()))
            if frame is not None and frame is not IDLE:
                await websocket.send_json(frame)
            if loop.time() >= next_ping:
                await websocket.send_json({"event": "ping", "data": {}})
                next_ping = loop.time() + PING_INTERVAL_SECONDS
    except WebSocketDisconnect:
        return
    except RuntimeError:
        # The server closed the socket under us (uvicorn does on shutdown).
        return
    finally:
        file_requests.socket_closed(principal.controller_id, outbox)
        pump.cancel()
        receiver.cancel()
        failure = pump.exception() if pump.done() and not pump.cancelled() else None
        # Cancelling only asks the pump to stop. Waiting for it means the
        # stream has detached from the connection, and the ledger has been
        # told the socket went, before this returns.
        await asyncio.wait((pump, receiver))
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


class _Outbox:
    """What the socket's one writer sends next.

    The stream's frames wait here, at most `size` of them, so the stream is
    read only as fast as the socket takes them. A call's answer never waits
    for room, as there are no more of them than calls in flight, and goes out
    before any frame still waiting, so a backlog of events does not hold a
    call up.
    """

    def __init__(self, size: int) -> None:
        self._size = size
        self._frames: deque[ControllerFrame] = deque()
        self._answers: deque[ControllerFrame] = deque()
        self._waiting = asyncio.Event()
        self._room = asyncio.Event()
        self._room.set()

    def empty(self) -> bool:
        return not self._frames and not self._answers

    async def put_frame(self, frame: ControllerFrame) -> None:
        while len(self._frames) >= self._size:
            self._room.clear()
            await self._room.wait()
        self._frames.append(frame)
        self._waiting.set()

    def put_answer(self, answer: ControllerFrame) -> None:
        self._answers.append(answer)
        self._waiting.set()

    def wake(self) -> None:
        """End a `get` that is waiting, with nothing to send."""
        self._waiting.set()

    async def get(self, timeout: float) -> ControllerFrame | None:
        """The next frame to send, or None once `timeout` passes with none or
        the writer is woken (`wake`) with none."""
        if self.empty():
            self._waiting.clear()
            try:
                await asyncio.wait_for(self._waiting.wait(), timeout)
            except TimeoutError:
                return None
        if self._answers:
            return self._answers.popleft()
        if not self._frames:
            return None
        frame = self._frames.popleft()
        self._room.set()
        return frame


def _socket_principal(websocket: WebSocket, controller_id: str) -> ControllerPrincipal:
    """The controller the bearer middleware authenticated, checked against the
    path and the protocol it declares, as the HTTP routes check theirs."""
    requested = websocket.headers.get(PROTOCOL_HEADER)
    if requested is not None and requested.strip() not in _SUPPORTED_PROTOCOL_VERSIONS:
        raise ManagementError(
            426,
            reason_codes.PROTOCOL_UNSUPPORTED,
            f"Controller protocol {requested!r} is not supported; "
            f"Switch accepts {SUPPORTED_PROTOCOLS}.",
        )
    return require_controller(controller_id, get_controller_principal(websocket))


async def _pump(frames: AsyncGenerator[ControllerFrame], outbox: _Outbox) -> None:
    # Closed here: cancelled while waiting on the outbox, the stream would
    # otherwise detach only when the generator is garbage collected.
    try:
        async for frame in frames:
            await outbox.put_frame(frame)
    finally:
        await frames.aclose()


async def _receive(
    websocket: WebSocket,
    *,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    authenticator: ManagementAuthenticator,
    connection_id: str,
    generation: int,
    outbox: _Outbox,
) -> ControllerConnectionError | None:
    """Turn each pong into a beat and start answering each call, until the
    controller goes or a beat is refused. Returns the refusal, so the socket
    can say which before it closes; None when the controller simply went
    away."""
    in_flight: set[asyncio.Task[None]] = set()
    while True:
        try:
            message = await websocket.receive_json()
        except (WebSocketDisconnect, ValueError, RuntimeError):
            return None
        if not isinstance(message, dict):
            continue
        kind = message.get("type")
        if kind == socket_calls.CALL:
            _start_call(
                message,
                in_flight=in_flight,
                outbox=outbox,
                principal=principal,
                protocol=protocol,
                authenticator=authenticator,
            )
            continue
        if kind == FILES_REPLY:
            file_requests.deliver(principal.controller_id, message)
            continue
        if kind != "pong":
            continue
        try:
            await record_beat(
                principal=principal,
                protocol=protocol,
                connection_id=connection_id,
                generation=generation,
                cursors=_cursors_of(message),
            )
        except ControllerConnectionError as refusal:
            return refusal


# Every call still running, whatever socket it came on. The event loop keeps
# only a weak reference to a task, and a call outlives its socket when the
# controller goes before it is answered.
_running_calls: set[asyncio.Task[None]] = set()


def _start_call(
    message: dict[str, Any],
    *,
    in_flight: set[asyncio.Task[None]],
    outbox: _Outbox,
    principal: ControllerPrincipal,
    protocol: AgentCore,
    authenticator: ManagementAuthenticator,
) -> None:
    """Answer a call from a task of its own, so that a slow call holds up
    neither the others nor the beat."""
    id_ = socket_calls.call_id(message)
    if id_ is None:
        logger.warning(
            "Controller %s sent a call with no id to answer it by; dropped it",
            principal.controller_id,
        )
        return
    if len(in_flight) >= socket_calls.MAX_CALLS_IN_FLIGHT:
        outbox.put_answer(socket_calls.capacity_exceeded(id_))
        return

    async def run() -> None:
        outbox.put_answer(
            await socket_calls.answer(
                message,
                id_,
                principal=principal,
                protocol=protocol,
                authenticator=authenticator,
            )
        )

    task = asyncio.create_task(run())
    for tasks in (in_flight, _running_calls):
        tasks.add(task)
        task.add_done_callback(tasks.discard)
