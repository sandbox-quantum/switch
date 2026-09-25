"""Console ⇄ cloud worker relay: one request answered by the worker, and live views.

Owner only. A launch that is not the caller's reads as not found, so its
existence does not leak. Nothing relayed is written to the database or the log;
the only durable write is a mutating relay's `relay_seq`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.connections import Connection
from switch_core.bridges.agent.protocol.hosted_workers import (
    HEALTH_SUBSCRIPTION,
    RELAY_REQUEST_LIMIT_BYTES,
    RELAY_TIMEOUT_LIMIT_MS,
    ConsoleView,
    PendingRelay,
    RelayError,
    classify_message,
    frame_size,
    subscribe_message,
)
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.stream import KEEPALIVE_INTERVAL_SECONDS
from switch_core.db.models import HostedLaunch, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore, is_waking
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_protocol, get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hosted-launches")

#: Room for a relay frame's own fields around the relayed message.
RELAY_FRAME_ENVELOPE_BYTES = 256
#: A subscription the stream asks the worker for itself waits this long.
SUBSCRIPTION_RELAY_TIMEOUT_MS = 30_000
MAX_STREAM_SUBSCRIPTIONS = 32

_dispatches: set[asyncio.Task[Any]] = set()


class RelayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: dict[str, Any]
    timeout_ms: int = Field(gt=0, le=RELAY_TIMEOUT_LIMIT_MS)


def worker_info(conn: Connection | None) -> dict[str, Any] | None:
    if conn is None or conn.worker is None:
        return None
    return {
        "launch_revision": conn.worker.launch_revision,
        "boot_id": conn.worker.boot_id,
        "generation": conn.stream_generation,
    }


def relay_error(error: RelayError, conn: Connection | None) -> JSONResponse:
    body: dict[str, Any] = {
        "ok": False,
        "error": {"code": error.code, "message": str(error)},
        "worker": worker_info(conn),
    }
    if error.code == "worker_sleeping":
        body["wake_available"] = True
    return JSONResponse(status_code=error.status, content=body)


def relay_target(protocol: ProtocolService, launch: HostedLaunch) -> Connection:
    """The worker attached for the launch's current revision, or why there is none."""
    if launch.sleeping and not is_waking(launch):
        raise RelayError("worker_sleeping", "The cloud worker is asleep.", 409)
    if is_waking(launch) or launch.state in ("queued", "provisioning"):
        raise RelayError("worker_waking", "The cloud worker is starting.", 409)
    conn = (
        protocol.connections.attached_worker(launch.agent_id)
        if launch.agent_id
        else None
    )
    if (
        conn is None
        or conn.worker is None
        or conn.worker.launch_id != launch.id
        or conn.worker.launch_revision != launch.revision
    ):
        raise RelayError(
            "worker_not_attached", "The cloud worker is not connected.", 409
        )
    return conn


def relay_frame(
    relay: PendingRelay, message: dict[str, Any], timeout_ms: int
) -> dict[str, Any]:
    return {
        "id": relay.id,
        "deadline_ms": int(time.time() * 1000) + timeout_ms,
        "relay_seq": relay.relay_seq,
        "message": message,
    }


def dispatch_read_only(
    protocol: ProtocolService,
    tenant_id: str,
    conn: Connection,
    message: dict[str, Any],
    timeout_ms: int,
) -> PendingRelay:
    assert conn.worker is not None
    slot = conn.worker_frames.reserve(frame_size(message) + RELAY_FRAME_ENVELOPE_BYTES)
    try:
        relay = protocol.connections.relays.register(
            tenant_id=tenant_id,
            agent_id=conn.agent_id,
            binding=conn.worker,
            relay_seq=None,
            core_boot=protocol.event_buffer.boot,
            connection_id=conn.id,
            generation=conn.stream_generation,
            timeout_ms=timeout_ms,
        )
    except BaseException:
        slot.release()
        raise
    slot.put("relay", relay_frame(relay, message, timeout_ms))
    return relay


async def dispatch_mutating(
    protocol: ProtocolService,
    tenant_id: str,
    launch_id: str,
    message: dict[str, Any],
    timeout_ms: int,
) -> PendingRelay:
    """Sequence and send a mutating relay. Runs to completion even if the caller leaves.

    The slot is reserved before the sequence is taken, so a full queue refuses
    without consuming one; once committed, the frame always goes out.
    """
    async with tenant_session(protocol.session_factory, tenant_id) as session:
        launch = await HostedLaunchStore().locked(session, launch_id)
        if launch is None or launch.desired_state == "deleted":
            raise RelayError("worker_not_attached", "The cloud launch is gone.", 409)
        conn = relay_target(protocol, launch)
        assert conn.worker is not None
        slot = conn.worker_frames.reserve(
            frame_size(message) + RELAY_FRAME_ENVELOPE_BYTES
        )
        relay: PendingRelay | None = None
        try:
            launch.relay_seq += 1
            launch.active_at = datetime.now(UTC)
            relay = protocol.connections.relays.register(
                tenant_id=tenant_id,
                agent_id=conn.agent_id,
                binding=conn.worker,
                relay_seq=launch.relay_seq,
                core_boot=protocol.event_buffer.boot,
                connection_id=conn.id,
                generation=conn.stream_generation,
                timeout_ms=timeout_ms,
            )
            await session.commit()
        except BaseException:
            slot.release()
            if relay is not None:
                protocol.connections.relays.unregister(relay)
            raise
        slot.put("relay", relay_frame(relay, message, timeout_ms))
        return relay


async def owned_launch(
    session: AsyncSession, request_id: UUID, user: User
) -> HostedLaunch:
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    if launch is None or launch.desired_state == "deleted":
        raise HTTPException(404, "Cloud launch not found.")
    return launch


@router.post("/{request_id}/relay", response_model=None)
async def relay(
    request_id: UUID,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> JSONResponse:
    raw = await request.body()
    if len(raw) > RELAY_REQUEST_LIMIT_BYTES:
        return relay_error(
            RelayError("too_large", "A relay request is at most 2 MiB.", 413), None
        )
    try:
        body = RelayRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_input=False)) from exc
    launch = await owned_launch(session, request_id, user)
    tenant_id = require_tenant_id()
    conn: Connection | None = None
    try:
        kind = classify_message(body.message)
        if kind == "read_only":
            conn = relay_target(protocol, launch)
            pending = dispatch_read_only(
                protocol, tenant_id, conn, body.message, body.timeout_ms
            )
            await session.rollback()
        else:
            launch_id = launch.id
            await session.rollback()
            task = asyncio.create_task(
                dispatch_mutating(
                    protocol, tenant_id, launch_id, body.message, body.timeout_ms
                )
            )
            _dispatches.add(task)
            task.add_done_callback(_dispatches.discard)
            pending = await asyncio.shield(task)
        conn = protocol.connections.get(pending.connection_id)
        answer = await asyncio.shield(pending.future)
    except RelayError as error:
        return relay_error(error, conn)
    return JSONResponse(
        content={
            **answer,
            "worker": {
                "launch_revision": pending.launch_revision,
                "boot_id": pending.boot_id,
                "generation": pending.generation,
            },
        }
    )


def ask_worker(
    protocol: ProtocolService,
    tenant_id: str,
    conn: Connection,
    subscription: str,
    on: bool,
) -> None:
    """Subscribe or unsubscribe the worker for Console views; the answer is not awaited.

    A subscribe the worker's queue cannot take is shown on every view of it and
    asked again on the next pass. An unsubscribe that cannot be sent is not
    lost either: the worker's next push for it is answered with `unsubscribe`.
    """
    try:
        dispatch_read_only(
            protocol,
            tenant_id,
            conn,
            subscribe_message(subscription, on),
            SUBSCRIPTION_RELAY_TIMEOUT_MS,
        )
    except RelayError as error:
        if on:
            protocol.connections.relay_views.subscribe_failed(
                conn.agent_id, subscription, error
            )
            return
        logger.warning(
            "Could not close worker subscription for agent %s: %s; the worker's next push is refused instead",
            conn.agent_id,
            error.code,
        )


def stream_frame(event: str, data: dict[str, Any]) -> bytes:
    return (
        f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()
    )


NO_WORKER = {"launch_revision": None, "boot_id": None, "generation": None}


def launch_worker(
    protocol: ProtocolService, agent_id: str, launch_id: str
) -> Connection | None:
    conn = protocol.connections.attached_worker(agent_id)
    if conn is None or conn.worker is None or conn.worker.launch_id != launch_id:
        return None
    return conn


async def relay_events(
    protocol: ProtocolService,
    tenant_id: str,
    agent_id: str,
    launch_id: str,
    view: ConsoleView,
) -> AsyncIterator[bytes]:
    views = protocol.connections.relay_views
    views.open(agent_id, view)
    sent: dict[str, Any] | None = None
    last_write = time.monotonic()
    try:
        while True:
            conn = launch_worker(protocol, agent_id, launch_id)
            info = worker_info(conn) or NO_WORKER
            if info != sent:
                sent = info
                last_write = time.monotonic()
                yield stream_frame("worker", info)
            if conn is not None:
                for name in views.unsubscribed(agent_id, conn.stream_generation):
                    ask_worker(protocol, tenant_id, conn, name, True)
            view.wake.clear()
            for event, data in view.drain():
                last_write = time.monotonic()
                yield stream_frame(event, data)
            try:
                await asyncio.wait_for(view.wake.wait(), timeout=1.0)
            except TimeoutError:
                pass
            if time.monotonic() - last_write >= KEEPALIVE_INTERVAL_SECONDS:
                last_write = time.monotonic()
                yield b": keepalive\n\n"
    finally:
        conn = launch_worker(protocol, agent_id, launch_id)
        for name, generation in views.close(agent_id, view):
            if conn is not None and generation == conn.stream_generation:
                ask_worker(protocol, tenant_id, conn, name, False)


@router.get("/{request_id}/relay/stream", response_model=None)
async def relay_stream(
    request_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    subscribe: Annotated[list[UUID] | None, Query()] = None,
    watch_health: Annotated[bool, Query(alias="watchHealth")] = False,
) -> StreamingResponse:
    launch = await owned_launch(session, request_id, user)
    if launch.agent_id is None:
        raise HTTPException(404, "Cloud launch not found.")
    names = {str(session_id) for session_id in subscribe or []}
    if len(names) > MAX_STREAM_SUBSCRIPTIONS:
        raise HTTPException(422, "Too many subscriptions on one relay stream.")
    if watch_health:
        names.add(HEALTH_SUBSCRIPTION)
    tenant_id = require_tenant_id()
    agent_id = launch.agent_id
    launch_id = launch.id
    await session.rollback()
    return StreamingResponse(
        relay_events(
            protocol, tenant_id, agent_id, launch_id, ConsoleView(frozenset(names))
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
