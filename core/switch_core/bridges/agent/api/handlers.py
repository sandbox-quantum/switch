from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from typing import Annotated, Any, cast

from fastapi import (
    APIRouter,
    Depends,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
)
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import Response, StreamingResponse

from switch_core.bridges.agent.api.schemas import (
    AcceptTaskRequest,
    AgentInfo,
    AgentListResponse,
    BulkRegisterResult,
    CancelTaskRequest,
    ConnectionBeatRequest,
    ConnectionRenewRequest,
    ConnectionSubscribeRequest,
    CreateModerationRoomRequest,
    CreateModerationRoomResponse,
    DelegateTaskRequest,
    DelegateTaskResponse,
    EventResponse,
    FeatureFlagInfo,
    FeatureFlagListResponse,
    FinaliseTaskRequest,
    HistoryMessage,
    HistoryResponse,
    InviteAgentRequest,
    ListBridgesResponse,
    ParticipantInfo,
    ParticipantsResponse,
    PostLlmResponseRequest,
    PostLlmResponseResponse,
    PostToolResultRequest,
    PostToolResultResponse,
    PreLlmRequestRequest,
    PreLlmRequestResponse,
    PreToolCallRequest,
    PreToolCallResponse,
    RegisterAgentRequest,
    RegisterAgentResponse,
    RegisterKnownAgentBulkRequest,
    RegisterKnownAgentBulkResponse,
    RegisterKnownAgentRequest,
    ReportEventsRequest,
    RoomDetailResponse,
    RoomInfo,
    RoomListResponse,
    RuntimeStateRequest,
    SendMessageRequest,
    SetFeatureFlagRequest,
    StatusRequest,
    TaskAgentsResponse,
    TaskInfo,
    TaskListResponse,
    TypingRequest,
    UpdateAgentRequest,
    UpdateTaskRequest,
)
from switch_core.bridges.agent.auth import (
    get_agent_from_scope,
)
from switch_core.bridges.agent.dependencies import (
    get_api_key_store,
    get_protocol,
    get_session,
)
from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionError_,
    DeliveryFilter,
    NoStreamAttachedError,
    ProtocolVersionError,
    RoomOccupiedError,
    Scope,
    UnknownConnectionError,
    evicted_session_warning,
)
from switch_core.bridges.agent.protocol.service import AgentExistsError, ProtocolService
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.db.models import Agent, Task
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.feature_flag_store import FeatureFlagStore
from switch_core.feature_flags import is_known_flag
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

router = APIRouter()

MEDIATION_TIMEOUT_SECONDS = 10.0


def parse_timestamp_ms(iso: str) -> int:
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


def _task_info(task: Task) -> TaskInfo:
    return TaskInfo(
        id=task.id,
        room_id=task.room_id,
        requester_agent_id=task.requester_agent_id,
        performer_agent_id=task.performer_agent_id,
        summary=task.summary,
        description=task.description,
        status=task.status,
        updates=task.updates or [],
        outcome=task.outcome,
        created_at=str(task.created_at),
        accepted_at=str(task.accepted_at) if task.accepted_at else None,
        finalised_at=str(task.finalised_at) if task.finalised_at else None,
    )


async def _resolve_registration_user_id(
    authorization: Annotated[str, Header()],
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
) -> str:
    """Validate the registration token in the Authorization header and
    return the owning user_id."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    key = await api_key_store.get_by_hash(session, token_hash)
    if key is None or key.type != "registration":
        raise HTTPException(status_code=401, detail="Invalid registration token")
    return key.user_id


# Registration endpoints


@router.post("")
async def register_agent_endpoint(
    req: RegisterAgentRequest,
    owner_id: Annotated[str, Depends(_resolve_registration_user_id)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> RegisterAgentResponse:
    try:
        result = await protocol.register_agent(
            name=req.name,
            description=req.description,
            icon_url=req.icon_url,
            connector_type=req.connector_type,
            integration_profile=req.integration_profile,
            tools=req.tools,
            models=req.models,
            metadata=req.metadata or None,
            owner_id=owner_id,
            overwrite=req.overwrite,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except AgentExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return RegisterAgentResponse(id=result.agent_id, api_key=result.api_key)


async def _register_known(
    *,
    agent_type: str,
    name: str,
    description: str,
    icon_url: str | None,
    options_raw: dict,
    parent_agent_id: str | None,
    overwrite: bool,
    owner_id: str,
    protocol: ProtocolService,
) -> tuple[str, str]:
    """Register one known agent, translating domain errors to HTTP errors.

    Returns ``(agent_id, api_key)``. Shared by the single and bulk
    register-known endpoints.
    """
    spec = KNOWN_AGENTS.get(agent_type)
    if spec is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown agent type: {agent_type}",
        )

    try:
        options = spec.parse_options(options_raw)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc

    integration_profile = spec.build_profile(options)
    metadata = {
        "known_agent_type": agent_type,
        "known_agent_options": options.model_dump(),
    }

    try:
        result = await protocol.register_agent(
            name=name,
            description=description,
            icon_url=icon_url,
            connector_type=spec.connector_type,
            integration_profile=integration_profile,
            tools=spec.tools,
            models=spec.models,
            metadata=metadata,
            owner_id=owner_id,
            parent_agent_id=parent_agent_id,
            overwrite=overwrite,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except AgentExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result.agent_id, result.api_key


@router.post("/register-known")
async def register_known_agent_endpoint(
    req: RegisterKnownAgentRequest,
    owner_id: Annotated[str, Depends(_resolve_registration_user_id)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> RegisterAgentResponse:
    agent_id, api_key = await _register_known(
        agent_type=req.agent_type,
        name=req.name,
        description=req.description,
        icon_url=req.icon_url,
        options_raw=req.options,
        parent_agent_id=req.parent_agent_id,
        overwrite=req.overwrite,
        owner_id=owner_id,
        protocol=protocol,
    )
    return RegisterAgentResponse(id=agent_id, api_key=api_key)


@router.post("/register-known-bulk")
async def register_known_agents_bulk_endpoint(
    req: RegisterKnownAgentBulkRequest,
    owner_id: Annotated[str, Depends(_resolve_registration_user_id)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> RegisterKnownAgentBulkResponse:
    """Register many Claude Code subagents under one parent agent.

    Each Switch agent name is derived as ``<parent-name>.<subagent_name>``.
    Names are pre-checked against existing agents (unless ``overwrite``) so a
    name clash fails the whole batch up front rather than leaving a partial
    set registered.
    """
    if not req.subagents:
        raise HTTPException(status_code=400, detail="No subagents provided")

    parent = await protocol.agent_store.get(session, req.parent_agent_id)
    if parent is None:
        raise HTTPException(
            status_code=404, detail=f"Parent agent not found: {req.parent_agent_id}"
        )

    # Subagents inherit the parent's operational settings unless the caller
    # overrides them: they should run in the same channels mode and use the
    # same repo dir as their parent.
    # The bridge exposes no GET-profile endpoint, so inheriting here means the
    # caller (the configure skill) doesn't have to recover these from the
    # parent — passing just `parent_agent_id` is enough.
    parent_md = parent.metadata_ if isinstance(parent.metadata_, dict) else {}
    parent_opts = parent_md.get("known_agent_options")
    inherited: dict[str, Any] = {}
    if isinstance(parent_opts, dict):
        for key in ("channels_enabled", "repo_dir"):
            if parent_opts.get(key) is not None:
                inherited[key] = parent_opts[key]

    # Derive names and reject duplicates within the batch.
    derived: list[tuple[str, str, str]] = []  # (subagent_name, name, description)
    seen: set[str] = set()
    for sub in req.subagents:
        name = f"{parent.name}.{sub.subagent_name}"
        if name in seen:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate subagent in batch: {sub.subagent_name!r}",
            )
        seen.add(name)
        derived.append((sub.subagent_name, name, sub.description))

    # Pre-check existence so a clash fails the batch before any registration.
    if not req.overwrite:
        clashes = [
            name
            for _, name, _ in derived
            if await protocol.agent_store.get_by_name(session, name) is not None
        ]
        if clashes:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Subagents already exist: "
                    + ", ".join(clashes)
                    + ". Pass overwrite=true to re-register."
                ),
            )

    results: list[BulkRegisterResult] = []
    for subagent_name, name, description in derived:
        # Inherited parent settings are the base; explicit request options
        # win over them; the per-subagent name is always set last.
        options = {**inherited, **req.options, "subagent_name": subagent_name}
        agent_id, api_key = await _register_known(
            agent_type=req.agent_type,
            name=name,
            description=description,
            # Subagents deliberately do not inherit the parent's icon: sharing
            # one would make every child render identically in a list, whereas
            # no icon lets each fall back to something derived from its own
            # name. An individual subagent can still be given one afterwards.
            icon_url=None,
            options_raw=options,
            parent_agent_id=req.parent_agent_id,
            overwrite=req.overwrite,
            owner_id=owner_id,
            protocol=protocol,
        )
        results.append(
            BulkRegisterResult(
                subagent_name=subagent_name,
                name=name,
                id=agent_id,
                api_key=api_key,
            )
        )

    return RegisterKnownAgentBulkResponse(results=results)


@router.patch("/{agent_id}")
async def update_agent(
    agent_id: str,
    req: UpdateAgentRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    await protocol.update_agent(
        agent_id,
        description=req.description,
        integration_profile=(
            req.integration_profile.model_dump() if req.integration_profile else None
        ),
        metadata=req.metadata,
    )

    return {"ok": True}


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.delete_agent(agent_id=agent_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    logger.info("Deleted agent: %s (%s)", agent.name, agent_id)
    return {"ok": True}


# Messages endpoints


@router.post("/{agent_id}/message")
async def send_message(
    agent_id: str,
    req: SendMessageRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, object]:
    logger.debug("Recieved message from agent %s: %s", agent.name, req.content)
    try:
        event_id = await protocol.send_message(agent.id, req.room_id, req.content)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True, "event_id": event_id}


@router.get("/{agent_id}/rooms/{room_id}/media", response_model=None)
async def download_media(
    agent_id: str,
    room_id: str,
    mxc: Annotated[str, Query(description="The mxc:// URI of the attachment")],
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> Response:
    """Stream an attachment's bytes from the Matrix media repo.

    The local channel uses this to materialise inbound images to disk (it holds
    only the bridge API token, not Matrix credentials).
    """
    try:
        data, content_type, filename = await protocol.download_media(
            agent.id, room_id, mxc
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    headers = {}
    if filename:
        headers["Content-Disposition"] = f'inline; filename="{filename}"'
    return Response(
        content=data,
        media_type=content_type or "application/octet-stream",
        headers=headers,
    )


@router.post("/{agent_id}/rooms/{room_id}/media")
async def upload_media(
    agent_id: str,
    room_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    file: UploadFile | None = None,
    files: list[UploadFile] | None = None,
    caption: Annotated[str | None, Form()] = None,
    thread_id: Annotated[str | None, Form()] = None,
) -> dict[str, object]:
    """Post one or more attachments to a room as the agent (multipart upload).

    The inverse of the GET media endpoint: the local channel (or any connector
    holding the bridge API token) sends the files' bytes here; they are
    uploaded to the Matrix media repo and posted to the room as
    m.image / m.file events, with optional caption and threading.

    Accepts either a single `file` part or repeated `files` parts. Several
    files become one logical message (they share an attachment-group marker).
    Validation is all-or-nothing: if any file is empty or oversize the whole
    request fails with 400 and nothing is posted.
    """
    uploads = list(files or [])
    if file is not None:
        uploads.insert(0, file)
    if not uploads:
        raise HTTPException(
            status_code=400, detail="no file provided (expected 'file' or 'files')"
        )
    payload = [
        (
            await upload.read(),
            upload.filename or "attachment",
            upload.content_type or "application/octet-stream",
        )
        for upload in uploads
    ]
    try:
        result = await protocol.send_media(
            agent.id,
            room_id,
            payload,
            caption=caption,
            thread_id=thread_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True, **result}


@router.post("/{agent_id}/typing")
async def set_typing(
    agent_id: str,
    req: TypingRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    logger.debug("Set Typing recieved %s, %s", agent.name, req.is_typing)
    try:
        await protocol.set_typing(agent.id, req.room_id, req.is_typing)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True}


@router.post("/{agent_id}/leases/renew")
async def renew_role_lease(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    """Refresh the agent's role-lease heartbeat (room-agnostic).

    Called on a fast cadence by the channel process while the agent holds a
    role, so an exclusive seat stays held while the session is alive and
    auto-releases shortly after it stops renewing. `held` is False when the
    agent holds no lease (the caller may then stop renewing).
    """
    held = await protocol.touch_role_lease(agent.id)
    return {"ok": True, "held": held}


@router.post("/{agent_id}/connection/renew")
async def renew_connection(
    agent_id: str,
    req: ConnectionRenewRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    """Refresh the agent's room-scoped liveness heartbeat.

    Called on a fast cadence by the channel process for the room it is
    currently connected to, decoupled from the long-poll so the liveness TTL
    can stay short (a closed session drops to "no session" within seconds).
    """
    try:
        await protocol.touch_connection(agent.id, req.room_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True}


@router.post("/{agent_id}/watch/heartbeat")
async def watch_heartbeat(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    """Refresh an auto_session connector's global "watching" heartbeat.

    Pinged on a cadence by the connector (Switch Console) while it is watching this
    agent's rooms. Keeps the agent reporting DORMANT (rather than offline) in
    rooms with no live session, so addressing it yields a "Starting a session…"
    reply while the connector spins one up. Room-agnostic; decoupled from the
    notification long-poll.
    """
    await protocol.touch_watch_heartbeat(agent.id)
    return {"ok": True}


@router.post("/{agent_id}/status")
async def update_status(
    agent_id: str,
    req: StatusRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    if req.detail:
        try:
            await protocol.update_status(agent.id, req.room_id, req.detail)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True}


@router.post("/{agent_id}/runtime-state")
async def set_runtime_state(
    agent_id: str,
    req: RuntimeStateRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    """Report the agent's session runtime state (working/awaiting-input/idle).

    Persists the state and emits a room event the collaboration bridge surfaces
    on the bridged channel. Reported by the Switch Console connector for sessions
    it manages.
    """
    try:
        await protocol.set_runtime_state(
            agent.id,
            req.room_id,
            req.state,
            thread_id=req.thread_id,
            deeplink_url=req.deeplink_url,
            detail=req.detail,
            control_capabilities=req.control_capabilities,
            anchor_event_id=req.anchor_event_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True}


# Events endpoints


@router.get("/{agent_id}/events", response_model=None)
async def poll_events(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    timeout: Annotated[float, Query()] = 10,
    accept: Annotated[str | None, Header()] = None,
    connection_id: Annotated[str | None, Query()] = None,
    scope: Annotated[str, Query()] = "single",
    event_filter: Annotated[str, Query(alias="filter")] = "all",
    start_from: Annotated[str, Query()] = "head",
    spawn_capable: Annotated[bool, Query()] = False,
    protocol_version: Annotated[int | None, Query(alias="protocol")] = None,
    protocol_accepts: Annotated[int | None, Query()] = None,
    client: Annotated[str | None, Query()] = None,
    client_version: Annotated[str | None, Query()] = None,
    rooms: Annotated[str | None, Query()] = None,
    last_event_id: Annotated[str | None, Header(alias="last-event-id")] = None,
) -> EventResponse | Response:
    """Deliver the agent's events, as a push stream or a long poll.

    `Accept: text/event-stream` opens a connection and streams: catch-up from
    the client's cursor, then live delivery. Anything else falls back to the
    long poll, which is served from the same buffer so the two cannot diverge
    while both exist.

    The four declaration parameters are all optional and all default to None,
    meaning *unknown* (CHOO-1865). `protocol` previously defaulted to the
    server's own value, so a client that said nothing was read as having
    agreed — and since no shipped client sent it, the check had never once
    fired. Absent now records as unknown, and still connects.
    """
    if accept and "text/event-stream" in accept:
        return await _open_event_stream(
            agent=agent,
            protocol=protocol,
            connection_id=connection_id,
            scope=scope,
            event_filter=event_filter,
            start_from=start_from,
            spawn_capable=spawn_capable,
            declaration=ClientDeclaration(
                speaks=protocol_version,
                accepts=protocol_accepts,
                artifact=client,
                version=client_version,
            ),
            rooms=rooms,
            last_event_id=last_event_id,
        )

    events = await protocol.poll_events(agent.id, timeout=timeout)
    if not events:
        return Response(status_code=204)
    return EventResponse(events=events)


def _resolve_start_cursor(
    protocol: ProtocolService,
    agent_id: str,
    start_from: str,
    last_event_id: str | None,
) -> int:
    """Where a stream begins.

    `Last-Event-ID` wins when present: a reconnecting SSE client sends it
    automatically and it is the most accurate statement of what it processed.
    """
    raw = last_event_id or start_from
    if raw in ("", "head"):
        return protocol.event_buffer.head(agent_id)
    try:
        return max(int(raw), 0)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"start_from must be 'head' or a sequence number, got {raw!r}",
        ) from exc


async def _open_event_stream(
    *,
    agent: Agent,
    protocol: ProtocolService,
    connection_id: str | None,
    scope: str,
    event_filter: str,
    start_from: str,
    spawn_capable: bool,
    declaration: ClientDeclaration,
    rooms: str | None,
    last_event_id: str | None,
) -> StreamingResponse:
    if not connection_id:
        raise HTTPException(
            status_code=400,
            detail="connection_id is required to open an event stream; generate a "
            "UUID and reuse it when reconnecting so the connection survives the "
            "drop",
        )
    if scope not in ("single", "all"):
        raise HTTPException(
            status_code=400, detail=f"scope must be 'single' or 'all', got {scope!r}"
        )
    if event_filter not in ("all", "addressed"):
        raise HTTPException(
            status_code=400,
            detail=f"filter must be 'all' or 'addressed', got {event_filter!r}",
        )

    cursor = _resolve_start_cursor(protocol, agent.id, start_from, last_event_id)

    try:
        conn = protocol.connections.open(
            agent_id=agent.id,
            connection_id=connection_id,
            scope=cast(Scope, scope),
            delivery_filter=cast(DeliveryFilter, event_filter),
            spawn_capable=spawn_capable,
            cursor=cursor,
            declaration=declaration,
        )
    except ProtocolVersionError as exc:
        # The refused client never receives a connection_state frame, so this
        # body is the only chance to tell it what the server speaks. Structured
        # rather than a bare string so the runtime can act on it instead of
        # showing the user a sentence to parse (CHOO-1865).
        raise HTTPException(
            status_code=409,
            detail={
                "message": str(exc),
                "contract": "agent-protocol",
                "server": {
                    "version": switch_core_version(),
                    "speaks": exc.server_speaks,
                    "accepts": exc.server_accepts,
                },
                "client": {"speaks": exc.client_speaks, "accepts": exc.client_accepts},
                "remedy": exc.remedy,
            },
        ) from exc
    except ConnectionError_ as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    # After the connection is open, so a bookkeeping failure can never be the
    # reason an agent could not connect.
    await protocol.record_client_declaration(agent.id, connection_id, declaration)

    # Rooms are claimed before the stream starts, not after it opens. A client
    # reconnecting already knows which room it was in; making it re-subscribe
    # afterwards would race the catch-up, and buffered events for that room
    # would be skipped as "not covered" and the cursor advanced past them —
    # losing exactly the events resume exists to recover.
    for room_id in [r for r in (rooms or "").split(",") if r]:
        try:
            await protocol.require_room_member(agent.id, room_id)
            # Declaring a room on the URL takes it over; a tool call does not.
            #
            # The client doing the delivering owns the slot. Naming a room here
            # is a supervisor asserting ownership of a session it manages and
            # is about to feed — a stream it opens must work, or the session it
            # restored is silent. A `connect_to_room` claim is cooperative and
            # yields to whoever is already covering the room.
            #
            # Without this, a session started before its supervisor learned to
            # share connections keeps the slot, and the supervisor's restored
            # stream 409s and retries forever.
            protocol.connections.claim_room(conn, room_id, takeover=True)
        except (ValueError, PermissionError) as exc:
            protocol.connections.close(conn.id, "invalid room subscription")
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ConnectionError_ as exc:
            protocol.connections.close(conn.id, "room already claimed")
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return StreamingResponse(
        event_stream(
            conn=conn,
            registry=protocol.connections,
            buffer=protocol.event_buffer,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Proxies that buffer would defeat the point of a push channel.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{agent_id}/connection/beat")
async def connection_beat(
    agent_id: str,
    req: ConnectionBeatRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, Any]:
    """The single per-connection heartbeat.

    Proves the client is alive and reports its cursor. Rejected when the
    connection is unknown, dead, or has no stream attached — an agent that can
    still make calls but is receiving nothing must be told, not left believing
    it is connected.
    """
    # A cursor above the buffer's head belongs to a previous life of this
    # process: the buffer is in memory, so a restart resets the sequence while
    # the client keeps beating the number it had reached. Both consumers below
    # only ever move a cursor forward, so adopting it undoes the rewind the
    # stream performs on resume — the connection then skips every event up to
    # the stale value and confirms events it was never delivered. Clamp it here,
    # where the untrusted value enters, rather than in either consumer.
    head = protocol.event_buffer.head(agent.id)
    cursor = min(req.cursor, head)

    try:
        conn = protocol.connections.beat(agent.id, req.connection_id, cursor)
    except NoStreamAttachedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except UnknownConnectionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    protocol.event_buffer.confirm(agent.id, conn.id, cursor)
    return {"ok": True, "rooms": sorted(conn.rooms), "cursor": conn.cursor}


@router.post("/{agent_id}/connection/subscribe")
async def connection_subscribe(
    agent_id: str,
    req: ConnectionSubscribeRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, Any]:
    """Claim a room on an open connection.

    Membership is checked here, so a connection can only cover rooms the agent
    already belongs to: subscribing is not joining. On a `single`-scope
    connection this also drops whichever room it held before, which is how
    "one room at a time" stops being a convention and becomes a guarantee.
    """
    try:
        conn = protocol.connections.require(agent.id, req.connection_id)
    except UnknownConnectionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        await protocol.require_room_member(agent.id, req.room_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    try:
        evicted = protocol.connections.claim_room(
            conn, req.room_id, takeover=req.takeover
        )
    except RoomOccupiedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if evicted is not None:
        logger.warning(
            "[CONN] agent=%s connection=%s took room %s from connection %s",
            agent.id,
            conn.id,
            req.room_id,
            evicted.id,
        )

    return {
        "ok": True,
        "rooms": sorted(conn.rooms),
        "evicted_connection_id": evicted.id if evicted else None,
        "warning": (
            evicted_session_warning(req.room_id, evicted.id)
            if evicted is not None
            else None
        ),
    }


@router.post("/{agent_id}/connection/unsubscribe")
async def connection_unsubscribe(
    agent_id: str,
    req: ConnectionSubscribeRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, Any]:
    """Release a room, returning coverage to any all-scope connection."""
    try:
        conn = protocol.connections.require(agent.id, req.connection_id)
    except UnknownConnectionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    protocol.connections.release_room(conn, req.room_id)
    return {"ok": True, "rooms": sorted(conn.rooms)}


@router.get("/{agent_id}/notifications", response_model=None)
async def poll_notifications(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    timeout: Annotated[float, Query()] = 10,
) -> EventResponse | Response:
    """Long-poll the agent's notification stream across all its rooms.

    Returns notifiable events only (addressed messages, task events, room_join
    events the agent listens for). Backed by a separate queue, so it never
    drains the per-room event queues live session pollers consume. Used by the
    auto_session watcher to decide when to spawn a session.
    """
    events = await protocol.poll_notifications(agent.id, timeout=timeout)
    if not events:
        return Response(status_code=204)
    return EventResponse(events=events)


@router.get("/{agent_id}/rooms/{room_id}/events", response_model=None)
async def poll_room_events(
    agent_id: str,
    room_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    timeout: Annotated[float, Query()] = 10,
) -> EventResponse | Response:
    try:
        events = await protocol.poll_room_events(agent.id, room_id, timeout=timeout)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if not events:
        return Response(status_code=204)
    return EventResponse(events=events)


@router.get("/{agent_id}/rooms/{room_id}/history")
async def get_room_history(
    agent_id: str,
    room_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    since: Annotated[
        str | None,
        Query(description="ISO 8601 timestamp — return events from this point forward"),
    ] = None,
    before: Annotated[
        str | None,
        Query(description="ISO 8601 timestamp — return events before this point"),
    ] = None,
    limit: Annotated[int, Query()] = 50,
) -> HistoryResponse:
    since_ms = parse_timestamp_ms(since) if since else None
    before_ms = parse_timestamp_ms(before) if before else None

    try:
        context = await protocol.read_context(
            agent.id,
            room_id,
            limit=limit,
            since_ms=since_ms,
            before_ms=before_ms,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    messages: list[HistoryMessage] = []
    for group in context["threads"]:
        for entry in [group["root"], *group["replies"]]:
            body = entry.get("body")
            if not body:
                continue
            sender = entry.get("sender")
            messages.append(
                HistoryMessage(
                    sender=sender,
                    sender_name=entry.get("sender_name") or sender,
                    body=body,
                    timestamp=entry.get("timestamp"),
                )
            )
    messages.sort(key=lambda m: m.timestamp or 0)

    return HistoryResponse(events=messages, has_more=context["truncated"])


# Participants endpoint


@router.get("/rooms/{room_id}/participants")
async def list_participants(
    room_id: str,
    _agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> ParticipantsResponse:
    try:
        participants_desc = await protocol.list_participants(room_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    participants = [
        ParticipantInfo(
            type=p.type,
            agent_id=p.id if p.type == "agent" else None,
            name=p.name,
            status=p.status,
        )
        for p in participants_desc
    ]

    return ParticipantsResponse(participants=participants)


# Tasks endpoints


@router.post("/{agent_id}/tasks/delegate")
async def delegate_task(
    agent_id: str,
    req: DelegateTaskRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> DelegateTaskResponse:
    # TODO: do we still need this ?
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        result = await protocol.delegate_task(
            requester_id=agent.id,
            room_id=req.room_id,
            performer_id=req.performer_agent_id,
            summary=req.summary,
            description=req.description,
        )
        task = await protocol.get_task(agent.id, result.task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return DelegateTaskResponse(
        task=_task_info(task), target_status=result.target_status
    )


@router.post("/{agent_id}/tasks/accept")
async def accept_task(
    agent_id: str,
    req: AcceptTaskRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> TaskInfo:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.accept_task(agent.id, req.task_id)
        task = await protocol.get_task(agent.id, req.task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return _task_info(task)


@router.post("/{agent_id}/tasks/cancel")
async def cancel_task(
    agent_id: str,
    req: CancelTaskRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> TaskInfo:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.cancel_task(agent.id, req.task_id, req.reason)
        task = await protocol.get_task(agent.id, req.task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return _task_info(task)


@router.get("/{agent_id}/tasks")
async def list_tasks(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    room_id: Annotated[str | None, Query()] = None,
    role: Annotated[str | None, Query(description="'delegated' or 'assigned'")] = None,
    status: Annotated[str | None, Query()] = None,
) -> TaskListResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    tasks = await protocol.list_tasks(
        agent.id, room_id=room_id, role=role, status=status
    )
    return TaskListResponse(tasks=[_task_info(t) for t in tasks])


@router.get("/{agent_id}/tasks/{task_id}")
async def get_task(
    agent_id: str,
    task_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> TaskInfo:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        task = await protocol.get_task(agent.id, task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return _task_info(task)


@router.get("/{agent_id}/tasks/agents")
async def list_task_agents(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    room_id: Annotated[str, Query()],
) -> TaskAgentsResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        performers = await protocol.list_delegatable_agents(agent.id, room_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    agents = [AgentInfo(id=p.id, name=p.name, description="") for p in performers]

    return TaskAgentsResponse(agents=agents)


@router.post("/{agent_id}/tasks/update")
async def update_task(
    agent_id: str,
    req: UpdateTaskRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> TaskInfo:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.update_task(agent.id, req.task_id, req.update)
        task = await protocol.get_task(agent.id, req.task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return _task_info(task)


@router.post("/{agent_id}/tasks/finalise")
async def finalise_task(
    agent_id: str,
    req: FinaliseTaskRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> TaskInfo:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.finalise_task(agent.id, req.task_id, req.outcome)
        task = await protocol.get_task(agent.id, req.task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return _task_info(task)


# Reporting endpoint


@router.post("/{agent_id}/events/report")
async def report_events(
    agent_id: str,
    req: ReportEventsRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> Response:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.report_events(agent.id, req.room_id, req.events)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return Response(status_code=202)


# Mediation endpoints


@router.post("/{agent_id}/mediation/pre-tool-call")
async def pre_tool_call(
    agent_id: str,
    req: PreToolCallRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> PreToolCallResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        result = await protocol.pre_tool_call(
            agent.id,
            req.room_id,
            req.tool_name,
            req.arguments,
            req.request_id,
            MEDIATION_TIMEOUT_SECONDS,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return PreToolCallResponse(verdict=result["verdict"], reason=result["reason"])  # type: ignore[arg-type]


@router.post("/{agent_id}/mediation/pre-llm-request")
async def pre_llm_request(
    agent_id: str,
    req: PreLlmRequestRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> PreLlmRequestResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        result = await protocol.pre_llm_request(
            agent.id,
            req.room_id,
            req.model,
            req.messages,
            req.request_id,
            MEDIATION_TIMEOUT_SECONDS,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return PreLlmRequestResponse(verdict=result["verdict"], reason=result["reason"])  # type: ignore[arg-type]


@router.post("/{agent_id}/mediation/post-tool-result")
async def post_tool_result(
    agent_id: str,
    req: PostToolResultRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> PostToolResultResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        result = await protocol.post_tool_result(
            agent.id,
            req.room_id,
            req.tool_name,
            req.result,
            req.request_id,
            MEDIATION_TIMEOUT_SECONDS,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return PostToolResultResponse(verdict=result["verdict"])  # type: ignore[arg-type]


@router.post("/{agent_id}/mediation/post-llm-response")
async def post_llm_response(
    agent_id: str,
    req: PostLlmResponseRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> PostLlmResponseResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        result = await protocol.post_llm_response(
            agent.id,
            req.room_id,
            req.model,
            req.response,
            req.request_id,
            MEDIATION_TIMEOUT_SECONDS,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return PostLlmResponseResponse(verdict=result["verdict"])  # type: ignore[arg-type]


# Moderation endpoints


@router.post("/{agent_id}/moderation/rooms")
async def create_room(
    agent_id: str,
    req: CreateModerationRoomRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> CreateModerationRoomResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        result = await protocol.create_moderation_room(
            agent_id=agent.id,
            name=req.name,
            description=req.description,
            agent_names=req.agent_names,
            include_subagents_for=req.include_subagents_for,
            user_names=req.user_names,
            channel_type=req.channel_type,
            bridge_id=req.bridge_id,
            internal_only=req.internal_only,
            admin_mode=req.admin_mode,
            security_config=req.security_config,
            instructions=req.instructions,
            reference_ids=req.reference_ids,
            package_ids=req.package_ids,
            linked_rooms=(
                [lr.model_dump() for lr in req.linked_rooms]
                if req.linked_rooms
                else None
            ),
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return CreateModerationRoomResponse(
        id=result.room.id,
        name=result.room.name,
        matrix_room_id=result.room.matrix_room_id,
        failed_attachments=result.failed_attachments,
    )


@router.post("/{agent_id}/moderation/rooms/{room_id}/invite")
async def invite_agent(
    agent_id: str,
    room_id: str,
    req: InviteAgentRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        await protocol.invite_agent_to_room(
            agent.id, room_id, req.agent_name, include_subagents=req.include_subagents
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True}


@router.get("/{agent_id}/moderation/rooms")
async def list_rooms(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> RoomListResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    rooms = await protocol.list_all_rooms(agent.id)
    return RoomListResponse(
        rooms=[RoomInfo(id=r.id, name=r.name, description=r.description) for r in rooms]
    )


@router.get("/{agent_id}/moderation/rooms/{room_id}")
async def get_room(
    agent_id: str,
    room_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> RoomDetailResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    try:
        room_detail = await protocol.get_room_detail(agent.id, room_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    return RoomDetailResponse(
        id=room_detail.id,
        name=room_detail.name,
        description=room_detail.description,
        channel_type=room_detail.channel_type,
        admin_mode=room_detail.admin_mode,
        agent_names=room_detail.agent_names,
    )


@router.get("/{agent_id}/moderation/agents")
async def list_agents(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> AgentListResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    agents = await protocol.list_all_agents(agent.id)
    return AgentListResponse(
        agents=[
            AgentInfo(id=a.id, name=a.name, description=a.description) for a in agents
        ]
    )


@router.get("/{agent_id}/moderation/bridges")
async def list_bridges(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> ListBridgesResponse:
    if agent.id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

    bridges = await protocol.list_bridges()
    return ListBridgesResponse(bridges=bridges)


# Feature flag endpoints


@router.get("/feature-flags")
async def list_feature_flags(
    _agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> FeatureFlagListResponse:
    """List every server-global feature flag and its current state.

    Any authenticated agent may read the flags.
    """
    flags = await FeatureFlagStore().get_all(session)
    return FeatureFlagListResponse(
        flags=[FeatureFlagInfo(key=k, enabled=v) for k, v in sorted(flags.items())]
    )


@router.put("/feature-flags/{key}")
async def set_feature_flag(
    key: str,
    req: SetFeatureFlagRequest,
    _agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> FeatureFlagInfo:
    """Flip a server-global feature flag on or off.

    Gated by any valid agent API token. Only keys in the known-flag registry
    are accepted so the endpoint cannot write arbitrary rows.
    """
    if not is_known_flag(key):
        raise HTTPException(status_code=400, detail=f"Unknown feature flag: {key}")

    store = FeatureFlagStore()
    await store.set(session, key, req.enabled)
    await session.commit()
    return FeatureFlagInfo(key=key, enabled=req.enabled)
