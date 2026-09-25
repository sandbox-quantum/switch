"""Merging a retained worker volume's pre-cutover work with what Core captured.

The cutover-manifest revision copied the old server-side session tables into
`hosted_cutover_items`; the worker's preflight lists what its journals hold.
Every record for one room message is merged by `(agent, room, message)` and
decided once, strongest evidence first, so a message runs at most once: only
an `import` becomes a mailbox row, under `origin = cutover`.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.attachments import parse_attachment_group
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AttachmentRef,
    MessagePayload,
)
from switch_core.clients.admin_messages import (
    PLATFORM_MARKER,
    platform_on_behalf_of,
    platform_replies_in_channel,
)
from switch_core.db.models import (
    HostedCutoverItem,
    HostedCutoverVolume,
    MediaBlob,
    Message,
    MessageAttachment,
    Room,
    require_tenant_id,
)
from switch_core.db.stores.hosted_mailbox_store import HostedMailboxStore, MailboxEntry
from switch_core.transport.stored import to_inbound
from switch_core.transport.types import InboundMedia, InboundMessage

logger = logging.getLogger(__name__)

HostState = Literal["accepted", "dispatched", "finished"]
Disposition = Literal[
    "ran",
    "uncertain",
    "unrecoverable",
    "import",
    "settled_by_host",
    "owner_notice",
    "interrupted",
    "preserved",
]
CutoverNoticeReason = Literal[
    "cutover_uncertain",
    "cutover_unrecoverable",
    "cutover_interrupted",
    "cutover_run_now",
]

_HOST_RANK: dict[str | None, int] = {
    None: 0,
    "accepted": 1,
    "dispatched": 2,
    "finished": 3,
}

MANIFEST_ITEM_LIMIT = 100_000


class RoomMessageRecord(BaseModel):
    """A room message the volume still holds: pending in its room inbox, or a host command."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["room_message"]
    session_id: str | None
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    thread_id: str | None
    room_pending: bool
    failure_notified: bool
    host: HostState | None


class ConsoleCommandRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["console_command"]
    session_id: str = Field(min_length=1)
    command_id: str = Field(min_length=1)
    host: HostState


class RequestOpenRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["request_open"]
    session_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    room_id: str | None
    thread_id: str | None


class ResetPendingRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["reset_pending"]
    session_id: str = Field(min_length=1)


ManifestItem = Annotated[
    RoomMessageRecord | ConsoleCommandRecord | RequestOpenRecord | ResetPendingRecord,
    Field(discriminator="kind"),
]


class CutoverManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    items: list[ManifestItem] = Field(max_length=MANIFEST_ITEM_LIMIT)


class CutoverConflict(Exception):
    """The volume's manifest was already applied with a different digest."""


@dataclass(frozen=True)
class CutoverNotice:
    """A notice owed to a room for one cutover item, posted after the commit."""

    item_id: str
    agent_id: str
    room_id: str
    message_id: str | None
    request_id: str | None
    thread_id: str | None
    reason: CutoverNoticeReason


@dataclass(frozen=True)
class WorkerEvidence:
    """Every record the volume holds for one room message, merged."""

    session_id: str | None
    thread_id: str | None
    room_pending: bool
    failure_notified: bool
    host: HostState | None

    def wire(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "room_pending": self.room_pending,
            "failure_notified": self.failure_notified,
            "host": self.host,
        }


def merge_worker(records: Iterable[RoomMessageRecord]) -> WorkerEvidence | None:
    merged: WorkerEvidence | None = None
    for record in records:
        if merged is None:
            merged = WorkerEvidence(
                session_id=record.session_id,
                thread_id=record.thread_id,
                room_pending=record.room_pending,
                failure_notified=record.failure_notified,
                host=record.host,
            )
            continue
        stronger = _HOST_RANK[record.host] > _HOST_RANK[merged.host]
        merged = WorkerEvidence(
            session_id=record.session_id if stronger else merged.session_id,
            thread_id=merged.thread_id or record.thread_id,
            room_pending=merged.room_pending or record.room_pending,
            failure_notified=merged.failure_notified or record.failure_notified,
            host=record.host if stronger else merged.host,
        )
    return merged


def decide_room_message(
    core_status: str | None, worker: WorkerEvidence | None
) -> Disposition:
    """The one disposition for a room message, strongest evidence across all sources first."""
    host = None if worker is None else worker.host
    if host == "finished" or core_status == "applied":
        return "ran"
    if host == "dispatched" or core_status in ("dispatched", "unknown"):
        return "uncertain"
    if core_status == "rejected":
        return "unrecoverable"
    return "import"


def cutover_event(
    room: Room, row: Message, files: list[MessageAttachment]
) -> dict[str, Any]:
    """The mailbox event for a stored message, as the agent client would have built it."""
    inbound = to_inbound(row, files, transport_room_id=room.matrix_room_id)
    if not isinstance(inbound, InboundMessage):
        raise ValueError(f"event {row.transport_event_id} is not a room message")
    thread_id = inbound.thread_root_id
    if platform_replies_in_channel(inbound.content):
        thread_id = None
    sender_name = inbound.sender_name or inbound.sender
    sender_kind: str | None = None
    on_behalf_of: str | None = None
    if PLATFORM_MARKER in inbound.content:
        sender_kind = "platform"
        person = platform_on_behalf_of(inbound.content)
        if person is not None:
            on_behalf_of = person.name
            sender_name = person.name
    attachments = (
        [
            AttachmentRef(
                filename=inbound.filename or inbound.body,
                mimetype=inbound.mimetype or "",
                size=inbound.size or 0,
                mxc=inbound.uri,
                msgtype=inbound.msgtype,
            )
        ]
        if isinstance(inbound, InboundMedia)
        else []
    )
    event = AgentEvent(
        type="message",
        room_id=room.id,
        bridge_id=room.bridge_id,
        channel_type=room.channel_type,
        payload=MessagePayload(
            addressed=True,
            sender=inbound.sender,
            sender_name=sender_name,
            sender_kind=sender_kind,
            on_behalf_of=on_behalf_of,
            message_id=inbound.event_id,
            body=inbound.body,
            timestamp=inbound.timestamp,
            thread_id=thread_id,
            attachments=attachments,
        ),
    )
    entry = MailboxEntry.of(event)
    assert entry is not None
    return entry.event


async def rebuild_event(
    session: AsyncSession, room_id: str, message_id: str
) -> dict[str, Any] | str:
    """The stored message rebuilt as a mailbox event, or why it cannot be."""
    room = await session.scalar(select(Room).where(Room.id == room_id))
    if room is None:
        return "the room is gone"
    row = await session.scalar(
        select(Message).where(
            Message.room_id == room_id, Message.transport_event_id == message_id
        )
    )
    if row is None:
        return "the message is gone"
    group = parse_attachment_group(row.content)
    if group is not None and group[2] > 1:
        return "it is part of a multi-file message"
    files = list(
        await session.scalars(
            select(MessageAttachment)
            .where(MessageAttachment.message_id == row.id)
            .order_by(MessageAttachment.position)
        )
    )
    if len(files) > 1:
        return "it carries several files"
    for file in files:
        blob = await session.scalar(
            select(MediaBlob.id).where(MediaBlob.uri == file.uri)
        )
        if blob is None:
            return f"its attachment {file.uri} is gone"
    try:
        return cutover_event(room, row, files)
    except ValueError as exc:
        return str(exc)


def _item(
    *,
    agent_id: str,
    launch_id: str,
    session_id: str | None,
    kind: str,
    evidence: dict[str, Any],
    disposition: Disposition,
    room_id: str | None,
    message_id: str | None,
    thread_id: str | None,
) -> HostedCutoverItem:
    return HostedCutoverItem(
        tenant_id=require_tenant_id(),
        id=str(uuid4()),
        agent_id=agent_id,
        launch_id=launch_id,
        session_id=session_id,
        kind=kind,
        room_id=room_id,
        message_id=message_id,
        thread_id=thread_id,
        evidence=evidence,
        disposition=disposition,
    )


async def _locked_volume(session: AsyncSession, launch_id: str) -> HostedCutoverVolume:
    tenant_id = require_tenant_id()
    await session.execute(
        insert(HostedCutoverVolume)
        .values(tenant_id=tenant_id, launch_id=launch_id)
        .on_conflict_do_nothing()
    )
    volume = await session.scalar(
        select(HostedCutoverVolume)
        .where(
            HostedCutoverVolume.tenant_id == tenant_id,
            HostedCutoverVolume.launch_id == launch_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert volume is not None
    return volume


async def apply_manifest(
    session: AsyncSession,
    *,
    agent_id: str,
    launch_id: str,
    manifest: CutoverManifest,
) -> None:
    """Decide every pre-cutover item of the agent once, and queue the imports.

    Idempotent by digest: the same manifest again changes nothing, a different
    one for a completed volume raises `CutoverConflict`. The caller commits.
    """
    volume = await _locked_volume(session, launch_id)
    if volume.preflight_state == "complete":
        if volume.manifest_sha256 != manifest.manifest_sha256:
            raise CutoverConflict(
                f"launch {launch_id} already applied manifest {volume.manifest_sha256}, "
                f"not {manifest.manifest_sha256}"
            )
        return

    core = list(
        await session.scalars(
            select(HostedCutoverItem)
            .where(
                HostedCutoverItem.tenant_id == require_tenant_id(),
                HostedCutoverItem.agent_id == agent_id,
                HostedCutoverItem.disposition.is_(None),
            )
            .with_for_update()
        )
    )

    rooms: dict[tuple[str, str], list[RoomMessageRecord]] = {}
    consoles: dict[str, ConsoleCommandRecord] = {}
    requests: dict[str, RequestOpenRecord] = {}
    for record in manifest.items:
        if isinstance(record, RoomMessageRecord):
            rooms.setdefault((record.room_id, record.message_id), []).append(record)
        elif isinstance(record, ConsoleCommandRecord):
            consoles[record.command_id] = record
        elif isinstance(record, RequestOpenRecord):
            requests[record.request_id] = record
        else:
            session.add(
                _item(
                    agent_id=agent_id,
                    launch_id=launch_id,
                    session_id=record.session_id,
                    kind="reset_pending",
                    evidence={"worker": {}},
                    disposition="preserved",
                    room_id=None,
                    message_id=None,
                    thread_id=None,
                )
            )

    core_rooms = {
        (item.room_id, item.message_id): item
        for item in core
        if item.kind == "room_message" and item.room_id and item.message_id
    }
    for key in sorted(set(core_rooms) | set(rooms)):
        room_id, message_id = key
        existing = core_rooms.get(key)
        worker = merge_worker(rooms.get(key, []))
        core_status = None if existing is None else existing.evidence["core"]["status"]
        disposition = decide_room_message(core_status, worker)
        event: dict[str, Any] | None = None
        if disposition == "import":
            rebuilt = await rebuild_event(session, room_id, message_id)
            if isinstance(rebuilt, str):
                logger.warning(
                    "Pre-cutover message %s in room %s for agent %s cannot be run: %s",
                    message_id,
                    room_id,
                    agent_id,
                    rebuilt,
                )
                disposition = "unrecoverable"
            else:
                event = rebuilt
        if existing is None:
            assert worker is not None
            existing = _item(
                agent_id=agent_id,
                launch_id=launch_id,
                session_id=worker.session_id,
                kind="room_message",
                evidence={},
                disposition=disposition,
                room_id=room_id,
                message_id=message_id,
                thread_id=worker.thread_id,
            )
            session.add(existing)
        existing.evidence = {
            **existing.evidence,
            **({} if worker is None else {"worker": worker.wire()}),
        }
        existing.disposition = disposition
        existing.payload = event
        if event is not None:
            thread_id = event["payload"].get("thread_id")
            await HostedMailboxStore().write(
                session,
                agent_id=agent_id,
                launch_id=launch_id,
                entry=MailboxEntry(
                    room_id=room_id,
                    message_id=message_id,
                    thread_id=thread_id if isinstance(thread_id, str) else None,
                    event=event,
                    origin="cutover",
                ),
                offered_to=None,
            )

    for item in core:
        if item.kind == "console_command":
            command_id = item.evidence["core"]["command_id"]
            console = consoles.pop(command_id, None)
            if console is None:
                logger.warning(
                    "Console command %s for agent %s was accepted by Core before the "
                    "cutover and never reached its worker; it did not run",
                    command_id,
                    agent_id,
                )
                item.disposition = "owner_notice"
            else:
                item.evidence = {**item.evidence, "worker": {"host": console.host}}
                item.disposition = "settled_by_host"
        elif item.kind == "request_open":
            request_id = item.evidence["core"]["request_id"]
            worker_request = requests.pop(request_id, None)
            if worker_request is not None:
                item.evidence = {**item.evidence, "worker": {}}
                item.room_id = item.room_id or worker_request.room_id
                item.thread_id = item.thread_id or worker_request.thread_id
            item.disposition = "interrupted"
        elif item.kind in ("session", "operation", "reset_pending"):
            item.disposition = "preserved"
    for command_id, console in consoles.items():
        session.add(
            _item(
                agent_id=agent_id,
                launch_id=launch_id,
                session_id=console.session_id,
                kind="console_command",
                evidence={"worker": {"command_id": command_id, "host": console.host}},
                disposition="settled_by_host",
                room_id=None,
                message_id=None,
                thread_id=None,
            )
        )
    for request_id, request in requests.items():
        session.add(
            _item(
                agent_id=agent_id,
                launch_id=launch_id,
                session_id=request.session_id,
                kind="request_open",
                evidence={"worker": {"request_id": request_id}},
                disposition="interrupted",
                room_id=request.room_id,
                message_id=None,
                thread_id=request.thread_id,
            )
        )

    volume.preflight_state = "complete"
    volume.manifest_sha256 = manifest.manifest_sha256
    volume.completed_at = datetime.now(UTC)
    await session.flush()


_NOTICE_REASONS: dict[str, CutoverNoticeReason] = {
    "uncertain": "cutover_uncertain",
    "unrecoverable": "cutover_unrecoverable",
    "interrupted": "cutover_interrupted",
    "import": "cutover_run_now",
}


async def owed_notices(session: AsyncSession, agent_id: str) -> list[CutoverNotice]:
    """The agent's cutover notices not yet posted, oldest item first."""
    items = await session.scalars(
        select(HostedCutoverItem)
        .where(
            HostedCutoverItem.tenant_id == require_tenant_id(),
            HostedCutoverItem.agent_id == agent_id,
            HostedCutoverItem.notice_posted_at.is_(None),
            HostedCutoverItem.room_id.is_not(None),
            or_(
                HostedCutoverItem.disposition.in_(
                    ("uncertain", "unrecoverable", "interrupted")
                ),
                (HostedCutoverItem.disposition == "import")
                & (
                    HostedCutoverItem.evidence["worker"]["failure_notified"].astext
                    == "true"
                ),
            ),
        )
        .order_by(HostedCutoverItem.created_at, HostedCutoverItem.id)
    )
    notices = []
    for item in items:
        assert item.room_id is not None and item.disposition is not None
        request_id = None
        if item.kind == "request_open":
            request_id = (item.evidence.get("core") or item.evidence["worker"])[
                "request_id"
            ]
        notices.append(
            CutoverNotice(
                item_id=item.id,
                agent_id=item.agent_id,
                room_id=item.room_id,
                message_id=item.message_id,
                request_id=request_id,
                thread_id=item.thread_id,
                reason=_NOTICE_REASONS[item.disposition],
            )
        )
    return notices


async def mark_notice_posted(session: AsyncSession, item_id: str) -> None:
    item = await session.get(HostedCutoverItem, (require_tenant_id(), item_id))
    assert item is not None
    item.notice_posted_at = datetime.now(UTC)
