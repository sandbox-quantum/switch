from __future__ import annotations

import hashlib
import logging
from contextvars import ContextVar
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

from switch_core.bridges.agent.api.hosted_worker_routes import (
    admit_worker,
    hosted_worker_only,
)
from switch_core.bridges.agent.api.schemas import (
    BulkRegisterResult,
    ConnectionBeatRequest,
    ConnectionPlacementsRequest,
    ConnectionRenewRequest,
    ConnectionSubscribeRequest,
    RegisterAgentRequest,
    RegisterAgentResponse,
    RegisterKnownAgentBulkRequest,
    RegisterKnownAgentBulkResponse,
    RegisterKnownAgentRequest,
    SendMessageRequest,
    TypingRequest,
)
from switch_core.bridges.agent.auth import (
    get_agent_from_scope,
)
from switch_core.bridges.agent.dependencies import (
    get_api_key_store,
    get_config,
    get_protocol,
    get_session,
)
from switch_core.bridges.agent.hosted_mailbox import deliver_on_attach
from switch_core.bridges.agent.protocol.agent_connections import (
    TAKEN_OVER,
    AgentConnection,
    ClientDeclaration,
    Closure,
    ConnectionError_,
    DeliveryFilter,
    NoStreamAttachedError,
    ProtocolVersionError,
    RoomOccupiedError,
    Scope,
    SupersededConnectionError,
    SupersededControlError,
    SupersededReattachError,
    UnfencedBeatError,
    UnfencedControlError,
    UnknownConnectionError,
    evicted_session_warning,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore, AgentExistsError
from switch_core.bridges.agent.protocol.event_buffer import Reader
from switch_core.bridges.agent.protocol.hosted_workers import hosted_launch_of
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_TYPE,
    REGISTRATION_KEY_TYPES,
    resolve_registration_owner_id,
)
from switch_core.budgets import BudgetExceeded
from switch_core.config import SwitchConfig
from switch_core.db.models import Agent, HostedLaunch, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

router = APIRouter()


def parse_timestamp_ms(iso: str) -> int:
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


async def _resolve_registration_user_id(
    authorization: Annotated[str, Header()],
    session: Annotated[AsyncSession, Depends(get_session)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> str:
    """Validate the registration token in the Authorization header and
    return the user_id new agents should be owned by.

    A personal ``"registration"`` key resolves to the user who minted it. The
    deployment-wide ``"bootstrap"`` key (see ``registration_bootstrap.py``)
    resolves to a dedicated, non-admin account instead of the admin who
    seeded it, so holding it never confers admin authority.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    key = await api_key_store.get_by_hash(session, token_hash)
    if key is None or key.type not in REGISTRATION_KEY_TYPES:
        raise HTTPException(status_code=401, detail="Invalid registration token")
    # Which credential this was is worth keeping: a deployment bootstrapping
    # its first agents through the shared key and a user minting a key of
    # their own are different moments in adoption, and the key type is the
    # only place that distinction exists.
    _REGISTRATION_PATH.set(
        "bootstrap" if key.type == BOOTSTRAP_KEY_TYPE else "personal_key"
    )
    try:
        return await resolve_registration_owner_id(session, protocol.user_store, key)
    except RuntimeError as exc:
        logger.error("Agent-registration bootstrap owner resolution failed: %s", exc)
        raise HTTPException(
            status_code=503, detail="Agent registration is temporarily unavailable"
        ) from exc


# How the current registration authenticated. A contextvar rather than a
# parameter because the owner-id dependency is where the credential is
# resolved and the endpoint body is where the agent is registered — threading
# it would mean changing the dependency's return type and every caller of it.
_REGISTRATION_PATH: ContextVar[str] = ContextVar("switch_registration_path")


def registration_path() -> str:
    """How this registration authenticated, or `other` outside one."""
    return _REGISTRATION_PATH.get("other")


# Registration endpoints


@router.post("")
async def register_agent_endpoint(
    req: RegisterAgentRequest,
    owner_id: Annotated[str, Depends(_resolve_registration_user_id)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> RegisterAgentResponse:
    try:
        result = await protocol.register_agent(
            registration_path=registration_path(),
            name=req.name,
            description=req.description,
            icon_url=req.icon_url,
            display_name=req.display_name,
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
    display_name: str | None,
    options_raw: dict,
    parent_agent_id: str | None,
    overwrite: bool,
    owner_id: str,
    protocol: AgentCore,
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
            registration_path=registration_path(),
            name=name,
            description=description,
            icon_url=icon_url,
            display_name=display_name,
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> RegisterAgentResponse:
    agent_id, api_key = await _register_known(
        agent_type=req.agent_type,
        name=req.name,
        description=req.description,
        icon_url=req.icon_url,
        display_name=req.display_name,
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
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
            # Nor a display name: the whole point of a subagent's derived
            # `<parent>.<child>` identifier is that it says which parent it
            # belongs to, and one shared human label would erase that.
            display_name=None,
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


# Messages endpoints


@router.post("/{agent_id}/message")
async def send_message(
    agent_id: str,
    req: SendMessageRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, object]:
    logger.debug("Recieved message from agent %s: %s", agent.name, req.content)
    try:
        event_id = await protocol.send_message(agent.id, req.room_id, req.content)
    except BudgetExceeded as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {"ok": True, "event_id": event_id}


@router.get("/{agent_id}/rooms/{room_id}/media", response_model=None)
async def download_media(
    agent_id: str,
    room_id: str,
    mxc: Annotated[
        str, Query(description="The media URI of the attachment (its `mxc` field)")
    ],
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> Response:
    """Stream an attachment's bytes from Switch's media store.

    The local channel uses this to materialise inbound images to disk (it holds
    only the bridge API token, no other credentials).
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    file: UploadFile | None = None,
    files: list[UploadFile] | None = None,
    caption: Annotated[str | None, Form()] = None,
    thread_id: Annotated[str | None, Form()] = None,
) -> dict[str, object]:
    """Post one or more attachments to a room as the agent (multipart upload).

    The inverse of the GET media endpoint: the local channel (or any connector
    holding the bridge API token) sends the files' bytes here; they are
    stored in Switch's media store and posted to the room as
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
    except BudgetExceeded as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    connection_id: Annotated[str | None, Header(alias="x-switch-connection-id")] = None,
) -> dict[str, bool]:
    """Refresh the caller's role-lease heartbeat (room-agnostic).

    Called on a fast cadence by a process that owns its connection while it
    holds a role, so an exclusive seat stays held while that process is alive
    and auto-releases shortly after it stops renewing. `held` is False when
    the caller holds no lease, and it may then stop renewing.

    `X-Switch-Connection-Id` says which of the agent's holders is beating.
    Only a self-renewing holder beats at all — a seat held by an SDK session
    is kept alive by that session's own host lease — so the connection is the
    whole of the identity needed here, and no session selector is read.
    """
    held = await protocol.touch_role_lease(agent.id, connection_id)
    return {"ok": True, "held": held}


@router.post("/{agent_id}/connection/renew")
async def renew_connection(
    agent_id: str,
    req: ConnectionRenewRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, bool]:
    """Refresh the agent's room-scoped liveness heartbeat.

    Called on a fast cadence by the channel process for the room it is
    currently connected to, so the liveness TTL can stay short (a closed
    session drops to "no session" within seconds).
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, bool]:
    """Refresh an auto_session connector's global "watching" heartbeat.

    Pinged on a cadence by the connector (Switch Console) while it is watching this
    agent's rooms. Keeps the agent reporting DORMANT (rather than offline) in
    rooms with no live session, so addressing it yields a "Starting a session…"
    reply while the connector spins one up. Room-agnostic.
    """
    await protocol.touch_watch_heartbeat(agent.id)
    return {"ok": True}


# Events endpoints


@router.get("/{agent_id}/events", response_model=None)
async def open_event_stream(
    agent_id: str,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    accept: Annotated[str | None, Header()] = None,
    connection_id: Annotated[str | None, Query()] = None,
    scope: Annotated[str, Query()] = "single",
    event_filter: Annotated[str, Query(alias="filter")] = "all",
    start_from: Annotated[str, Query()] = "head",
    spawn_capable: Annotated[bool, Query()] = False,
    protocol_version: Annotated[int | None, Query(alias="protocol")] = None,
    protocol_accepts: Annotated[int | None, Query()] = None,
    expected_generation: Annotated[int | None, Query()] = None,
    client: Annotated[str | None, Query()] = None,
    client_version: Annotated[str | None, Query()] = None,
    rooms: Annotated[str | None, Query()] = None,
    last_event_id: Annotated[str | None, Header(alias="last-event-id")] = None,
    worker_capability: Annotated[
        str | None, Header(alias="x-switch-worker-capability")
    ] = None,
    host_boot_id: Annotated[str | None, Header(alias="x-switch-host-boot-id")] = None,
    host_instance_id: Annotated[
        str | None, Header(alias="x-switch-host-instance-id")
    ] = None,
    worker_state_version: Annotated[
        int | None, Header(alias="x-switch-worker-state-version")
    ] = None,
) -> StreamingResponse:
    """Deliver the agent's events as a push stream.

    `Accept: text/event-stream` opens a connection and streams: catch-up from
    the client's cursor, then live delivery. Anything else is refused.

    The four declaration parameters are all optional and all default to None,
    meaning *unknown* (CHOO-1865). `protocol` previously defaulted to the
    server's own value, so a client that said nothing was read as having
    agreed — and since no shipped client sent it, the check had never once
    fired. Absent now records as unknown, and still connects.
    """
    if not accept or "text/event-stream" not in accept:
        raise HTTPException(
            status_code=406,
            detail="The event stream is served as text/event-stream only; send "
            "Accept: text/event-stream.",
        )
    return await _open_event_stream(
        agent=agent,
        protocol=protocol,
        config=config,
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
        expected_generation=expected_generation,
        worker_capability=worker_capability,
        host_boot_id=host_boot_id,
        host_instance_id=host_instance_id,
        worker_state_version=worker_state_version,
    )


def _resolve_start_cursor(
    protocol: AgentCore,
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


def _open_connection(
    *,
    protocol: AgentCore,
    agent: Agent,
    connection_id: str,
    scope: str,
    event_filter: str,
    spawn_capable: bool,
    cursor: int,
    declaration: ClientDeclaration,
    expected_generation: int | None,
) -> AgentConnection:
    try:
        conn = protocol.connections.open(
            agent_id=agent.id,
            connection_id=connection_id,
            scope=cast(Scope, scope),
            delivery_filter=cast(DeliveryFilter, event_filter),
            spawn_capable=spawn_capable,
            cursor=cursor,
            declaration=declaration,
            expected_generation=expected_generation,
        )
    except SupersededReattachError as exc:
        # Structured, like the refused heartbeat: this is the same ending, and
        # the client acts on the code rather than the prose. It is also the
        # last thing this client will be told — a refused reattach means it has
        # no stream and no beat that will be answered.
        raise HTTPException(
            status_code=409, detail={"code": exc.code, "message": str(exc)}
        ) from exc
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
    return conn


async def _open_event_stream(
    *,
    agent: Agent,
    protocol: AgentCore,
    config: SwitchConfig,
    connection_id: str | None,
    scope: str,
    event_filter: str,
    start_from: str,
    spawn_capable: bool,
    declaration: ClientDeclaration,
    rooms: str | None,
    last_event_id: str | None,
    expected_generation: int | None,
    worker_capability: str | None,
    host_boot_id: str | None,
    host_instance_id: str | None,
    worker_state_version: int | None,
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

    def open_connection() -> AgentConnection:
        return _open_connection(
            protocol=protocol,
            agent=agent,
            connection_id=connection_id,
            scope=scope,
            event_filter=event_filter,
            spawn_capable=spawn_capable,
            cursor=cursor,
            declaration=declaration,
            expected_generation=expected_generation,
        )

    launch_id = hosted_launch_of(agent.metadata_)
    if launch_id is None:
        conn = open_connection()
    else:
        # Admission, the open and the binding all happen under the launch
        # lock, so no revision bump lands between the check and the bind.
        async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
            attach = await admit_worker(
                session=db,
                registry=protocol.connections,
                config=config,
                agent=agent,
                launch_id=launch_id,
                connection_id=connection_id,
                declaration=declaration,
                capability=worker_capability,
                boot_id=host_boot_id,
                instance_id=host_instance_id,
                state_version=worker_state_version,
            )
            conn = open_connection()
            if attach.takes_over is not None and attach.takes_over.id != conn.id:
                protocol.connections.close(attach.takes_over.id, TAKEN_OVER)
            protocol.connections.bind_worker(conn, attach.binding, attach.attached)
            launch = await db.get(HostedLaunch, (require_tenant_id(), launch_id))
            assert launch is not None
            await deliver_on_attach(db, protocol, launch)

    # Built before anything below can yield, so it holds the generation this
    # open produced; a reconnect during the bookkeeping supersedes it rather
    # than being detached by it.
    stream = event_stream(
        conn=conn,
        registry=protocol.connections,
        buffer=protocol.event_buffer,
        approvals=protocol.approval_outcomes,
    )

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
            async with protocol.connections.slots(agent.id):
                protocol.connections.claim_room(conn, room_id, takeover=True)
            # The room's unread count follows the slot: whoever is told how far
            # behind the room is has to be the one whose reading clears it.
            protocol.event_buffer.take_counting(agent.id, conn.id, room_id, conn.cursor)
        except (ValueError, PermissionError) as exc:
            protocol.connections.close(
                conn.id,
                Closure(
                    code="closed",
                    message=f"the room declared on connect cannot be served: {exc}",
                    room_id=room_id,
                ),
            )
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ConnectionError_ as exc:
            protocol.connections.close(
                conn.id,
                Closure(code="closed", message=str(exc), room_id=room_id),
            )
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    # Every claim succeeded and the stream is about to be returned, so this is
    # the first moment a session exists. Reporting it where the connection was
    # created instead counted every rejected attempt as a session that began
    # and ended at once, which a retrying client repeats indefinitely.
    #
    # Every stream, a reattach included. The reporter keys sessions on the
    # agent, so a stream on a connection the agent already holds continues its
    # session rather than starting another, and an open that failed after
    # registering its connection, retried on the same id, is still counted.
    await protocol.sessions.started(agent, conn)

    return StreamingResponse(
        stream,
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, Any]:
    """The single per-connection heartbeat.

    Proves the client is alive and reports its cursor. Rejected when the
    connection is unknown, dead, has no stream attached, or belongs to another
    incarnation — an agent that can still make calls but is receiving nothing
    must be told, not left believing it is connected. A refusal carries a code
    beside its prose, because the remedies differ: `taken_over` is terminal for
    the client that receives it, and the rest are recovered by reopening.
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
        conn = protocol.connections.beat(
            agent.id, req.connection_id, cursor, req.generation
        )
    except (
        NoStreamAttachedError,
        SupersededConnectionError,
        UnfencedBeatError,
    ) as exc:
        # All three refuse the tick, and one of them means something the others
        # do not: a superseded tick is terminal for the client that sent it,
        # because reopening is itself a takeover and would pull the connection
        # back off the client that now holds it. Prose alone could not tell
        # them apart, so every refusal was answered with a reopen.
        raise HTTPException(
            status_code=409, detail={"code": exc.code, "message": str(exc)}
        ) from exc
    except UnknownConnectionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    protocol.event_buffer.confirm(agent.id, conn.id, cursor)
    return {"ok": True, "rooms": sorted(conn.rooms), "cursor": conn.cursor}


def _current_connection(
    protocol: AgentCore,
    agent: Agent,
    req: ConnectionSubscribeRequest | ConnectionPlacementsRequest,
) -> AgentConnection:
    """The connection this request may write to, or the refusal saying why not.

    A connection id survives a takeover, so it names the connection rather than
    the client on it. Asked again after any wait, because what a caller was
    admitted on is not what it is still holding.
    """
    if hosted_launch_of(agent.metadata_) is not None:
        named = protocol.connections.get(req.connection_id)
        if named is None or named.agent_id != agent.id or named.worker is None:
            raise hosted_worker_only()
    try:
        return protocol.connections.require_current(
            agent.id, req.connection_id, generation=req.generation
        )
    except (SupersededControlError, UnfencedControlError) as exc:
        raise HTTPException(
            status_code=409, detail={"code": exc.code, "message": str(exc)}
        ) from exc
    except UnknownConnectionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{agent_id}/connection/subscribe")
async def connection_subscribe(
    agent_id: str,
    req: ConnectionSubscribeRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, Any]:
    """Claim a room on an open connection.

    Membership is checked here, so a connection can only cover rooms the agent
    already belongs to: subscribing is not joining. On a `single`-scope
    connection this also drops whichever room it held before, which is how
    "one room at a time" stops being a convention and becomes a guarantee.

    That replacement is done here rather than in `claim_room`, because the
    registry can no longer tell whose room it would be dropping: a connection
    carrying several sessions holds the union of their rooms. A caller at this
    door names no session, so the connection is the whole of what it is, and
    replacing is what it has always been promised.
    """
    conn = _current_connection(protocol, agent, req)

    try:
        await protocol.require_room_member(agent.id, req.room_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    async with protocol.connections.slots(agent.id):
        departing = (
            frozenset(conn.rooms - {req.room_id})
            if conn.scope == "single"
            else frozenset()
        )
        # Named again now the wait for the slots is over, and with nothing
        # awaited between here and the write: a client displaced while it waited
        # would otherwise move a room on the connection its successor holds.
        conn = _current_connection(protocol, agent, req)
        try:
            evicted = protocol.connections.claim_room(
                conn, req.room_id, takeover=req.takeover
            )
        except RoomOccupiedError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        for departed in departing:
            protocol.connections.release_room(conn, departed)

    # A room slot changes hands here as much as it does on the stream URL or in
    # connect_to_room, and the room's unread count follows it: the holder being
    # told how far behind the room is has to be the one whose reading clears it.
    protocol.event_buffer.take_counting(agent.id, conn.id, req.room_id, conn.cursor)

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
            evicted_session_warning(req.room_id, f"connection {evicted.id}")
            if evicted is not None
            else None
        ),
    }


@router.post("/{agent_id}/connection/unsubscribe")
async def connection_unsubscribe(
    agent_id: str,
    req: ConnectionSubscribeRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, Any]:
    """Release a room, returning coverage to any all-scope connection."""
    conn = _current_connection(protocol, agent, req)

    async with protocol.connections.slots(agent.id):
        conn = _current_connection(protocol, agent, req)
        protocol.connections.release_room(conn, req.room_id)
    return {"ok": True, "rooms": sorted(conn.rooms)}


@router.post("/{agent_id}/connection/placements")
async def connection_placements(
    agent_id: str,
    req: ConnectionPlacementsRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, Any]:
    """Replace every session placement on an open connection.

    The agent's watcher places its sessions itself and states the whole set
    here after each change and on every (re)connect, so a restart of either
    side converges on what the watcher knows. A room another connection holds
    is taken over, as `connect_to_room` takes it, and that connection is sent
    `room_released`. Every room must be one the agent belongs to; one that is
    not refuses the whole request and changes nothing.
    """
    if agent_id != agent.id:
        raise HTTPException(
            status_code=403,
            detail=f"authenticated as agent {agent.id}, not {agent_id}",
        )
    conn = _current_connection(protocol, agent, req)

    for room_id in sorted(set(req.placements.values())):
        try:
            await protocol.require_room_member(agent.id, room_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    async with protocol.connections.slots(agent.id):
        conn = _current_connection(protocol, agent, req)
        before = protocol.connections.connection_placements(conn)
        try:
            released = protocol.connections.replace_placements(conn, req.placements)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    for session_id, room_id in req.placements.items():
        if before.get(session_id) != room_id:
            protocol.event_buffer.hand_counting_to(
                agent.id, Reader(id=session_id, is_session=True), room_id
            )
    for lost in released:
        logger.warning(
            "[CONN] agent=%s connection=%s took room %s from connection %s "
            "(session %s)",
            agent.id,
            conn.id,
            lost.room_id,
            lost.connection_id,
            lost.session_id or "-",
        )

    return {
        "ok": True,
        "placements": protocol.connections.connection_placements(conn),
        "rooms": sorted(conn.rooms),
        "released": [
            {
                "connection_id": lost.connection_id,
                "room_id": lost.room_id,
                "session_id": lost.session_id,
            }
            for lost in released
        ],
    }
