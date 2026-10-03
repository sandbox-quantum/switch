"""The routes an agent controller calls, mounted on the agent bridge.

All but two authenticate with a controller access token, which the bearer
middleware verifies and binds (`management/auth.py`); a route whose path
names a controller then requires it to be the token's own. Enrollment and
token exchange carry their secret in the body and resolve their tenant from
it here.

The controller's stream (`/v1/controllers/{id}/...`) is Core's: these routes
authenticate and parse, and Core's `ControllerPresence` and controller stream
do the rest. Management only adds its nudges and the first frame's
assignment revision.

Every failure is answered in the contract's error envelope (`errors.py`).
`Switch-Controller-Protocol` is checked when sent, and every response says
which protocol versions this server accepts.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.dependencies import (
    get_config,
    get_protocol,
    get_session,
)
from switch_core.bridges.agent.hosted_controller_workers import (
    ControllerWorkerIdentity,
    attach_controller_worker,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnectionError,
)
from switch_core.bridges.agent.protocol.controller_stream import (
    KEEPALIVE_INTERVAL_SECONDS,
    STREAM_HEADERS,
    controller_event_stream,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_INTERVAL_SECONDS
from switch_core.config import SwitchConfig
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import (
    MachineAuthError,
    authenticate_machine,
)
from switch_core.management import reason_codes
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.dependencies import (
    get_authenticator,
    get_controller_principal,
    get_hosted_settings,
    get_management,
    get_management_session_factory,
    require_controller,
)
from switch_core.management.errors import ManagementError, ManagementRoute, error_body
from switch_core.management.schemas import (
    MAX_STATUS_BYTES,
    ControllerBeatRequest,
    ControllerConnectionRequest,
    EnrollRequest,
    MachineSecretProof,
    OperationResultRequest,
    ProgressRequest,
    StatusReport,
    TokenRequest,
    WorkerAttachRequest,
    WorkerDetachRequest,
    wire_time,
)
from switch_core.management.service import ManagementService
from switch_core.providers.hosted import HostedControllerSettings

logger = logging.getLogger(__name__)

PROTOCOL_HEADER = "Switch-Controller-Protocol"
PROTOCOL_ACCEPTS_HEADER = "Switch-Controller-Protocol-Accepts"
SUPPORTED_PROTOCOLS = "1-1"
_SUPPORTED_PROTOCOL_VERSIONS = frozenset({"1"})


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


def _etag(revision: int) -> str:
    return f'"{revision}"'


def _etag_matches(if_none_match: str | None, revision: int) -> bool:
    if if_none_match is None:
        return False
    for candidate in if_none_match.split(","):
        tag = candidate.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag in (_etag(revision), str(revision)):
            return True
    return False


# ── Public: authenticated by the body ─────────────────────────────────────────


@router.post("/v1/management/controllers/enroll", status_code=201)
async def enroll_controller(
    request: Request,
    body: EnrollRequest,
    management: Management,
    authenticator: Annotated[ManagementAuthenticator, Depends(get_authenticator)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
    hosted: Annotated[HostedControllerSettings | None, Depends(get_hosted_settings)],
) -> dict[str, str]:
    if isinstance(body.proof, MachineSecretProof):
        return await _enroll_machine(
            request, body, body.proof, management, session_factory, hosted
        )
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


_MACHINE_REFUSALS = {
    401: reason_codes.INVALID_CREDENTIAL,
    400: reason_codes.VALIDATION_ERROR,
    410: reason_codes.MACHINE_RETIRED,
}


async def _enroll_machine(
    request: Request,
    body: EnrollRequest,
    proof: MachineSecretProof,
    management: ManagementService,
    session_factory: async_sessionmaker[AsyncSession],
    hosted: HostedControllerSettings | None,
) -> dict[str, str]:
    """A cloud machine's supervisor enrolling the machine's controller.

    The machine capability and host identity are checked exactly as on the
    supervisor's own routes, in the tenant the cloud machines run in.
    """
    if hosted is None:
        raise ManagementError(
            401,
            reason_codes.INVALID_CREDENTIAL,
            "This server runs no cloud machines.",
        )
    async with tenant_session(session_factory, hosted.tenant_id) as session:
        try:
            machine = await authenticate_machine(
                session,
                proof.machine_id,
                capability=proof.capability,
                boot_id=request.headers.get("x-switch-host-boot-id"),
                instance_id=request.headers.get("x-switch-host-instance-id"),
            )
        except MachineAuthError as exc:
            raise ManagementError(
                exc.status, _MACHINE_REFUSALS[exc.status], str(exc)
            ) from exc
        controller, credential = await management.enroll_machine(
            session,
            hosted.tenant_id,
            machine=machine,
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
    connection's stream ends with `taken_over`, and its beats are refused.
    """
    presence = protocol.connections.controllers
    try:
        conn = presence.open(
            controller_id=principal.controller_id,
            tenant_id=principal.tenant_id,
            resume_cursors=body.resume_cursors(),
            placements=body.placements,
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


@router.get("/v1/controllers/{controller_id}/events")
async def controller_events(
    principal: PathController,
    management: Management,
    protocol: Protocol,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
    connection_id: str,
    generation: int,
) -> StreamingResponse:
    """The controller's one stream: its agents' events and the management nudges.

    The nudge subscription is taken before the first frame is built, so a
    change that commits while the stream is opening is still delivered.
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
    return StreamingResponse(
        controller_event_stream(
            conn=conn,
            stream_token=token,
            presence=presence,
            buffer=protocol.event_buffer,
            approvals=protocol.approval_outcomes,
            nudges=nudges,
            opening=opening,
            rooms_of=_rooms_reader(protocol),
            keepalive_seconds=KEEPALIVE_INTERVAL_SECONDS,
        ),
        media_type="text/event-stream",
        headers=STREAM_HEADERS,
    )


@router.post("/v1/controllers/{controller_id}/connection/beat")
async def connection_beat(
    body: ControllerBeatRequest,
    principal: PathController,
    protocol: Protocol,
) -> dict[str, Any]:
    """Keep the controller, and so every agent on it, live; confirm cursors.

    The cursors confirmed here are where a stream reattached to this
    connection resumes each agent. `placements` replaces where the
    controller's sessions are, which is where each agent is LIVE.

    Every two seconds; six without one and its agents are not live. Refused
    with `taken_over` once another connection has replaced this one, which is
    terminal for the client, and with `no_stream` or `unknown_connection`
    when the stream has to be opened again.
    """
    presence = protocol.connections.controllers
    try:
        conn = presence.beat(
            principal.controller_id, body.connection_id, body.generation
        )
    except ControllerConnectionError as exc:
        raise _connection_refusal(exc) from exc
    agents = presence.agents_of(principal.controller_id)
    for agent_id, cursor in body.cursors.items():
        binding = presence.binding(agent_id)
        if agent_id not in agents or binding is None:
            continue
        # Clamped to the head, as an agent's own beat is: a higher number
        # belongs to a previous life of this process.
        confirmed = min(cursor, protocol.event_buffer.head(agent_id))
        protocol.event_buffer.confirm(agent_id, presence.holder_id(binding), confirmed)
        presence.resume_from(conn, agent_id, confirmed)
    presence.replace_placements(conn, body.placements)
    return {"agents": sorted(agents)}


@router.post("/v1/controllers/{controller_id}/agents/{agent_id}/worker")
async def attach_worker(
    agent_id: str,
    body: WorkerAttachRequest,
    principal: PathController,
    protocol: Protocol,
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict[str, Any]:
    """Attach a cloud agent's worker that opened its stream on this controller's relay.

    Refused in the management envelope when the controller connection is not
    open with its stream attached, or the agent is not bound to it: the
    relay then asks its worker to retry. The worker's own admission is
    refused as Core refuses a worker opening its own stream
    (`{"detail": {code, message}}`), which the relay hands the worker as it
    came. Answers `{attached}`, the `worker_attached` payload.
    """
    presence = protocol.connections.controllers
    try:
        conn = presence.require(
            principal.controller_id, body.connection_id, body.generation
        )
    except ControllerConnectionError as exc:
        raise _connection_refusal(exc) from exc
    if not conn.stream_attached:
        raise ManagementError(
            409,
            reason_codes.NO_STREAM,
            "The controller connection has no stream attached; a worker attaches "
            "only while the controller's stream is up.",
            retryable=True,
        )
    binding = presence.binding(agent_id)
    if binding is None or binding.controller_id != principal.controller_id:
        raise ManagementError(
            403,
            reason_codes.NOT_ASSIGNED,
            f"Agent {agent_id} is not assigned to this controller.",
        )
    worker = body.worker
    attached = await attach_controller_worker(
        protocol=protocol,
        config=config,
        conn=conn,
        agent_id=agent_id,
        identity=ControllerWorkerIdentity(
            connection_id=worker.connection_id,
            generation=worker.generation,
            spawn_capable=worker.spawn_capable,
            protocol=worker.protocol,
            protocol_accepts=worker.protocol_accepts,
            capability=worker.capability,
            boot_id=worker.boot_id,
            instance_id=worker.instance_id,
            state_version=worker.state_version,
        ),
    )
    return {"attached": attached}


@router.post(
    "/v1/controllers/{controller_id}/agents/{agent_id}/worker/detach",
    status_code=204,
)
async def detach_worker(
    agent_id: str,
    body: WorkerDetachRequest,
    principal: PathController,
    protocol: Protocol,
) -> Response:
    """The worker's stream on the relay ended. Detaching a worker that is not
    the attached one changes nothing, so a late detach cannot undo a newer
    attach."""
    presence = protocol.connections.controllers
    try:
        presence.require(principal.controller_id, body.connection_id, body.generation)
    except ControllerConnectionError as exc:
        raise _connection_refusal(exc) from exc
    binding = presence.binding(agent_id)
    if binding is not None and binding.controller_id == principal.controller_id:
        presence.detach_worker(
            agent_id, body.worker.connection_id, body.worker.generation
        )
    return Response(status_code=204)
