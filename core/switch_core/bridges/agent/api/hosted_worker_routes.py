"""A hosted agent's worker: attaching, and the up-calls only the worker may make.

A hosted agent's connections are all workers: every open proves the
capability the controller minted for the launch's current revision. Each
up-call below names the connection and generation it comes from and is
refused unless that is the attached worker still.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_protocol, get_session
from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
    SupersededControlError,
    UnfencedControlError,
    UnknownConnectionError,
    WorkerAlreadyAttachedError,
)
from switch_core.bridges.agent.protocol.hosted_workers import (
    HOSTED_PROTOCOL_REVISION,
    HOSTED_WORKER_ONLY_MESSAGE,
    HOSTED_WORKER_STATE_VERSION,
    IDLE_FRESH_FOR_SECONDS,
    IDLE_REPORT_EVERY_SECONDS,
    NOTICE_MESSAGES,
    RELAY_REPLY_ENVELOPE_BYTES,
    RELAY_REPLY_LIMIT_BYTES,
    IdleReport,
    WorkerBinding,
    hosted_launch_of,
)
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.config import SwitchConfig
from switch_core.db.models import (
    Agent,
    Client,
    HostedLaunch,
    Message,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore, lock_launch
from switch_core.db.stores.hosted_mailbox_store import (
    ACKS_PER_CALL,
    HostedMailboxStore,
    MailboxNotice,
    MailboxOutcome,
    by_room,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def refusal(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def hosted_worker_only() -> HTTPException:
    return refusal(403, "hosted_worker_only", HOSTED_WORKER_ONLY_MESSAGE)


def require_worker(
    registry: ConnectionRegistry, agent: Agent, connection_id: str, generation: int
) -> Connection:
    """The attached worker making this call, or the refusal saying why not."""
    if hosted_launch_of(agent.metadata_) is None:
        raise hosted_worker_only()
    try:
        conn = registry.require_current(agent.id, connection_id, generation=generation)
    except (
        SupersededControlError,
        UnfencedControlError,
        UnknownConnectionError,
    ) as exc:
        raise refusal(409, "generation_changed", str(exc)) from exc
    if conn.worker is None:
        raise hosted_worker_only()
    return conn


def require_self(agent_id: str, agent: Agent) -> None:
    if agent_id != agent.id:
        raise HTTPException(
            status_code=403, detail=f"authenticated as agent {agent.id}, not {agent_id}"
        )


@dataclass(frozen=True, slots=True)
class WorkerAttach:
    """What a worker attach proved, and who it takes over once opened."""

    binding: WorkerBinding
    attached: dict[str, Any]
    takes_over: Connection | None


async def admit_worker(
    *,
    session: AsyncSession,
    registry: ConnectionRegistry,
    config: SwitchConfig,
    agent: Agent,
    launch_id: str,
    connection_id: str,
    declaration: ClientDeclaration,
    capability: str | None,
    boot_id: str | None,
    instance_id: str | None,
    state_version: int | None,
) -> WorkerAttach:
    """Check a hosted agent's stream open, under the launch lock the caller holds open.

    The lock is taken here and released with the caller's transaction, so the
    open and the binding happen before any revision bump can land.
    """
    if not capability:
        raise refusal(
            403,
            "worker_capability_required",
            "This agent runs on a cloud worker; opening its stream needs the "
            "worker capability.",
        )
    if (declaration.speaks or 0) < HOSTED_PROTOCOL_REVISION:
        raise refusal(
            426,
            "upgrade_required",
            f"A cloud worker must speak agent-protocol {HOSTED_PROTOCOL_REVISION} "
            "or later.",
        )
    if (state_version or 0) < HOSTED_WORKER_STATE_VERSION:
        raise refusal(
            426,
            "upgrade_required",
            f"A cloud worker must have migrated its volume to state version "
            f"{HOSTED_WORKER_STATE_VERSION} before it attaches.",
        )
    if not boot_id or not instance_id:
        raise HTTPException(
            status_code=400,
            detail="X-Switch-Host-Boot-Id and X-Switch-Host-Instance-Id are required "
            "to attach a cloud worker",
        )
    store = HostedLaunchStore()
    launch = await store.locked(session, launch_id)
    if (
        launch is None
        or launch.agent_id != agent.id
        or launch.owner_id != agent.owner_id
        or launch.desired_state != "running"
        or launch.state == "error"
        or not store.capability_matches(launch, capability)
        or await session.get(TenantMember, (require_tenant_id(), launch.owner_id))
        is None
    ):
        raise refusal(
            403,
            "worker_capability_obsolete",
            "This worker capability is not the one for the launch's current "
            "revision, or the launch is not running.",
        )
    try:
        takes_over = registry.admit_worker(agent.id, connection_id, boot_id)
    except WorkerAlreadyAttachedError as exc:
        raise refusal(409, exc.code, str(exc)) from exc
    return WorkerAttach(
        binding=WorkerBinding(
            launch_id=launch.id,
            launch_revision=launch.revision,
            boot_id=boot_id,
            instance_id=instance_id,
        ),
        attached={
            "launch_revision": launch.revision,
            "limits": {"sessions_per_agent": config.hosted_sessions_per_agent},
            "idle": {
                "report_every_s": IDLE_REPORT_EVERY_SECONDS,
                "fresh_for_s": IDLE_FRESH_FOR_SECONDS,
            },
            "credential_revision": await store.credential_revision(session, launch),
            "queued_operations": await store.queued_operation_ids(
                session, launch, boot_id
            ),
            "relay_fence": launch.relay_seq,
            "cancelled": await HostedMailboxStore().cancelled_entries(
                session, agent.id
            ),
        },
        takes_over=takes_over,
    )


class RelayReplyError(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=64)
    message: str = Field(max_length=2048)


class RelayReply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int
    ok: bool
    value: Any = None
    error: RelayReplyError | None = None


class RelayPush(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subscription: str = Field(min_length=1)
    seq: int = Field(ge=0)
    event: Any = None
    failure: Any = None
    health: Any = None


class RelayPushes(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int
    pushes: list[RelayPush]


@router.post("/{agent_id}/connection/relay/push")
async def relay_push(
    agent_id: str,
    body: RelayPushes,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, list[str]]:
    """Live events for Console views, forwarded in order per subscription."""
    require_self(agent_id, agent)
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    pushes = [push.model_dump(exclude_unset=True) for push in body.pushes]
    unsubscribe = protocol.connections.relay_views.deliver(
        agent.id, conn.stream_generation, pushes
    )
    return {"unsubscribe": unsubscribe}


@router.post("/{agent_id}/connection/relay/{relay_id}")
async def relay_reply(
    agent_id: str,
    relay_id: str,
    request: Request,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    """The worker's answer to one relayed Console request."""
    require_self(agent_id, agent)
    raw = await request.body()
    if len(raw) > RELAY_REPLY_LIMIT_BYTES + RELAY_REPLY_ENVELOPE_BYTES:
        raise refusal(
            413, "too_large", "A relay reply is at most 1 MiB; page the answer."
        )
    try:
        body = RelayReply.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    relay = protocol.connections.relays.get(relay_id)
    if (
        relay is None
        or relay.agent_id != agent.id
        or relay.tenant_id != require_tenant_id()
    ):
        raise HTTPException(status_code=404, detail="Relay not found.")
    if relay.connection_id != conn.id or relay.generation != conn.stream_generation:
        raise refusal(
            409,
            "generation_changed",
            "This relay was dispatched to another connection or generation.",
        )
    if relay.future.done():
        raise refusal(409, "relay_resolved", "This relay has already been answered.")
    answer: dict[str, Any] = {"ok": body.ok}
    if body.ok:
        answer["value"] = body.value
    else:
        if body.error is None:
            raise HTTPException(
                status_code=422, detail="A failed relay reply carries an error."
            )
        answer["error"] = body.error.model_dump()
    protocol.connections.relays.resolve(relay, answer)
    return {"ok": True}


class IdleReason(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(min_length=1, max_length=64)
    session_id: str | None
    count: int = Field(ge=0)


class IdleSessions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    total: int = Field(ge=0)
    live: int = Field(ge=0)
    parked: int = Field(ge=0)
    failed: int = Field(ge=0)


class IdleReportBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int
    report_seq: int = Field(ge=0)
    relays_through: int = Field(ge=0)
    busy: bool
    reasons: list[IdleReason] = Field(max_length=1000)
    sessions: IdleSessions


@router.post("/{agent_id}/connection/idle")
async def idle_report(
    agent_id: str,
    body: IdleReportBody,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """Keep the worker's latest idle report; answer the doorbells it may have missed."""
    require_self(agent_id, agent)
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    assert conn.worker is not None
    protocol.connections.record_idle_report(
        conn,
        IdleReport(
            report_seq=body.report_seq,
            relays_through=body.relays_through,
            busy=body.busy,
            reasons=[reason.model_dump() for reason in body.reasons],
            sessions=body.sessions.model_dump(),
            launch_revision=conn.worker.launch_revision,
            generation=conn.stream_generation,
            received_monotonic=time.monotonic(),
            received_at=datetime.now(UTC),
        ),
    )
    store = HostedLaunchStore()
    launch = await session.get(
        HostedLaunch, (require_tenant_id(), conn.worker.launch_id)
    )
    if launch is None or launch.revision != conn.worker.launch_revision:
        return {"queued_operations": [], "credential_revision": None}
    return {
        "queued_operations": await store.queued_operation_ids(
            session, launch, conn.worker.boot_id
        ),
        "credential_revision": await store.credential_revision(session, launch),
    }


NoticeReason = Literal[
    "startup",
    "delivery",
    "conversation",
    "capacity",
    "auto_start_off",
    "stopped",
    "expired",
    "cancelled",
    "revoked",
    "upgrade",
]


#: Reasons only Core posts, for outcomes only the wake mailbox knows.
CoreNoticeReason = Literal[
    "started_before_stop",
    "started_before_expiry",
    "expired_uncertain",
    "cutover_uncertain",
    "cutover_unrecoverable",
    "cutover_run_now",
]


class RoomNotice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    thread_id: str | None
    reason: NoticeReason


async def post_room_notice(
    protocol: ProtocolService,
    agent: Agent,
    room_id: str,
    message_id: str,
    thread_id: str | None,
    reason: NoticeReason | CoreNoticeReason,
) -> bool:
    """Tell a room why a message was not processed, once per message and reason.

    True when this call posted it. Core's own reasons go through here too.
    """
    return await post_notice_once(
        protocol,
        agent,
        room_id,
        key=json.dumps([agent.id, room_id, message_id, reason]),
        body=NOTICE_MESSAGES[reason].format(name=agent.name),
        thread_id=thread_id,
        anchor=message_id,
    )


async def post_notice_once(
    protocol: ProtocolService,
    agent: Agent,
    room_id: str,
    *,
    key: str,
    body: str,
    thread_id: str | None,
    anchor: str | None,
) -> bool:
    """Post `body` to the room unless the agent already posted one under `key`.

    `anchor`, when set, is the message the notice is about, and must be in
    the room. True when this call posted it.
    """
    async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"room-failure:{require_tenant_id()}:{key}"},
        )
        if anchor is not None:
            target = await db.scalar(
                select(Message.id).where(
                    Message.room_id == room_id, Message.transport_event_id == anchor
                )
            )
            if target is None:
                raise ValueError(f"Message {anchor} is not in room {room_id}")
        sender = (
            select(Client.matrix_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .where(Agent.id == agent.id)
            .scalar_subquery()
        )
        previous = await db.scalar(
            select(Message.id)
            .where(
                Message.room_id == room_id,
                Message.sender_id == sender,
                Message.content["switch_room_failure"].astext == key,
            )
            .limit(1)
        )
        if previous is not None:
            return False
        await protocol.send_message(
            agent.id,
            room_id,
            body,
            thread_id=thread_id,
            extra_content={"switch_room_failure": key},
        )
        await db.commit()
    return True


@router.post("/{agent_id}/room-notices")
async def room_notice(
    agent_id: str,
    body: RoomNotice,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, Any]:
    """A failure notice the worker owes a room, posted at most once."""
    require_self(agent_id, agent)
    require_worker(protocol.connections, agent, body.connection_id, body.generation)
    try:
        posted = await post_room_notice(
            protocol, agent, body.room_id, body.message_id, body.thread_id, body.reason
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"room_id": body.room_id, "message_id": body.message_id, "posted": posted}


async def post_mailbox_notices(
    protocol: ProtocolService, notices: Sequence[MailboxNotice]
) -> None:
    """Post what the mailbox owes rooms, one notice per room and reason, after the commit.

    Each row keeps its `notice_owed` mark until the room has the notice, so a
    send that fails is logged and left for the upkeep to retry; the per
    message and reason receipt keeps a retry from posting it twice.
    """
    agents: dict[str, Agent | None] = {}
    store = HostedMailboxStore()
    for notice, message_ids in by_room(notices):
        if notice.agent_id not in agents:
            async with tenant_session(
                protocol.session_factory, require_tenant_id()
            ) as db:
                agents[notice.agent_id] = await db.get(Agent, notice.agent_id)
        agent = agents[notice.agent_id]
        if agent is None:
            logger.warning(
                "Mailbox notice %s for room %s dropped: agent %s is gone",
                notice.reason,
                notice.room_id,
                notice.agent_id,
            )
        else:
            try:
                await post_room_notice(
                    protocol,
                    agent,
                    notice.room_id,
                    notice.message_id,
                    notice.thread_id,
                    cast(NoticeReason | CoreNoticeReason, notice.reason),
                )
            except Exception:
                logger.warning(
                    "Could not post the %s notice for message %s in room %s; "
                    "the mailbox upkeep retries it",
                    notice.reason,
                    notice.message_id,
                    notice.room_id,
                    exc_info=True,
                )
                continue
        async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
            await store.notice_posted(
                db, notice.agent_id, notice.room_id, notice.reason, message_ids
            )
            await db.commit()


class MailboxAckEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    outcome: MailboxOutcome
    reason: str | None = Field(default=None, max_length=64)


class MailboxAcks(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int
    entries: list[MailboxAckEntry] = Field(max_length=ACKS_PER_CALL)


@router.post("/{agent_id}/connection/mailbox/ack")
async def mailbox_ack(
    agent_id: str,
    body: MailboxAcks,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """The attached worker says how far each delivered row has got; forward moves only."""
    require_self(agent_id, agent)
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    assert conn.worker is not None
    await lock_launch(session, conn.worker.launch_id)
    launch = await session.get(
        HostedLaunch,
        (require_tenant_id(), conn.worker.launch_id),
        populate_existing=True,
    )
    if launch is None or launch.revision != conn.worker.launch_revision:
        raise refusal(
            409,
            "generation_changed",
            "The launch moved to a newer revision; acknowledge again after "
            "reattaching.",
        )
    states, notices = await HostedMailboxStore().ack(
        session,
        agent.id,
        [(entry.room_id, entry.message_id, entry.outcome) for entry in body.entries],
    )
    await session.commit()
    await post_mailbox_notices(protocol, notices)
    return {
        "entries": [
            {
                "room_id": entry.room_id,
                "message_id": entry.message_id,
                "state": states.get((entry.room_id, entry.message_id)),
            }
            for entry in body.entries
        ]
    }
