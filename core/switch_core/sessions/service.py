from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import get_args

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import can_address, parse_policy
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.types import MessagePayload
from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    MediaBlob,
    Room,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
    SessionRequestPost,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.sessions.attachments import (
    MAX_ATTACHMENTS,
    attachment_metadata,
    attachment_uri,
    validate_attachment,
)
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalResult,
    Attachment,
    Command,
    CommandResult,
    CommandStatus,
    HostEvent,
    ItemUpsert,
    MessageSend,
    Notice,
    Origin,
    RequestAnswer,
    RequestOpened,
    RequestSettled,
    RequestSubmitting,
    ServerBody,
    ServerEvent,
    Session,
    SessionCompact,
    SessionConnectivity,
    SessionModelSet,
    SessionReset,
    SessionStop,
    SessionUpsert,
    Snapshot,
    Surface,
    TurnInterrupt,
    TurnUpsert,
    parse_host_event,
)
from switch_core.sessions.projection import SessionProjection
from switch_core.sessions.validation import validate_answer

logger = logging.getLogger(__name__)

LEASE_SECONDS = 30


class SessionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SessionAuthority:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    @staticmethod
    async def _now(db: AsyncSession) -> datetime:
        now = await db.scalar(select(func.clock_timestamp()))
        if not isinstance(now, datetime):
            raise RuntimeError("PostgreSQL did not return its current time.")
        return now

    async def acquire(
        self, agent_id: str, session: Session, operation_id: str | None = None
    ) -> Snapshot:
        if session.agent_id != agent_id:
            raise SessionError("NOT_AUTHORIZED", "Session belongs to another agent.")
        session = session.model_copy(update={"room_ids": [], "retired": False})
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            # The agent row also serializes the first lease, before a session row exists.
            agent = await db.scalar(
                select(Agent).where(Agent.id == agent_id).with_for_update()
            )
            if agent is None or agent.owner_id is None:
                raise SessionError(
                    "NOT_AUTHORIZED", "A shared session requires an owned agent."
                )
            row = await db.scalar(
                select(SdkSession)
                .where(
                    SdkSession.tenant_id == require_tenant_id(),
                    SdkSession.id == session.session_id,
                )
                .with_for_update()
            )
            now = await self._now(db)
            if row is not None:
                if row.agent_id != agent_id:
                    raise SessionError(
                        "NOT_AUTHORIZED", "Session belongs to another agent."
                    )
                if (
                    operation_id is not None
                    and row.recovery.get("acquire_id") == operation_id
                ):
                    if Session.model_validate(
                        row.recovery.get("acquire_session")
                    ).model_dump(by_alias=True) != session.model_dump(by_alias=True):
                        raise SessionError(
                            "IDEMPOTENCY_CONFLICT", "Acquisition host changed."
                        )
                    return Snapshot.model_validate(row.snapshot)
                if row.lease_expires_at > now:
                    raise SessionError(
                        "LEASE_BUSY", "The session already has a live host."
                    )
                raise SessionError(
                    "RECOVERY_REQUIRED",
                    "Resume the saved session before acquiring a replacement lease.",
                )
            verified = session.model_copy(
                update={
                    "epoch": str(uuid.uuid4()),
                    "connectivity": "online",
                    "pending_request_ids": [],
                }
            )
            snapshot = Snapshot(
                contract_version=1,
                through_sequence=0,
                session=verified,
                turns=[],
                items=[],
                requests=[],
                command_statuses=[],
                next_page_token=None,
            )
            row = SdkSession(
                id=verified.session_id,
                agent_id=agent_id,
                host_id=verified.host_id,
                epoch=verified.epoch,
                lease_expires_at=now + timedelta(seconds=LEASE_SECONDS),
                snapshot=snapshot.model_dump(by_alias=True),
                host_sequence=0,
                recovery={
                    "acquire_id": operation_id,
                    "acquire_session": session.model_dump(by_alias=True),
                    "quiesced": False,
                },
            )
            db.add(row)
            await db.flush()
            await self._append(
                db, row, SessionUpsert(type="session.upsert", session=verified)
            )
            return Snapshot.model_validate(row.snapshot)

    async def quiesce(
        self, agent_id: str, session_id: str, host_id: str, epoch: str
    ) -> None:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._host_identity(db, agent_id, session_id, host_id, epoch)
            if row.recovery.get("quiesced"):
                return
            row.recovery = {**row.recovery, "quiesced": True}
            row.lease_expires_at = await self._now(db)
            await self._append(
                db,
                row,
                SessionConnectivity(
                    type="session.connectivity", connectivity="offline"
                ),
            )

    async def retire(self, session_id: str, user_id: str, epoch: str) -> Snapshot:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            if row.recovery.get("retired_epoch") == epoch:
                return Snapshot.model_validate(row.snapshot)
            if row.epoch != epoch:
                raise SessionError("STALE_EPOCH", "Session generation changed.")
            now = await self._now(db)
            if row.lease_expires_at > now:
                raise SessionError(
                    "LEASE_BUSY", "Stop the active host before retiring this session."
                )
            snapshot = Snapshot.model_validate(row.snapshot)
            await self._interrupt_pending(db, row, snapshot, "SESSION_RETIRED")
            row.epoch = str(uuid.uuid4())
            row.connection_id = None
            row.recovery = {"retired_epoch": epoch, "quiesced": True}
            snapshot = Snapshot.model_validate(row.snapshot)
            snapshot = snapshot.model_copy(
                update={
                    "session": snapshot.session.model_copy(update={"epoch": row.epoch})
                }
            )
            row.snapshot = snapshot.model_dump(by_alias=True)
            await self._append(
                db,
                row,
                SessionUpsert(
                    type="session.upsert",
                    session=snapshot.session.model_copy(
                        update={
                            "epoch": row.epoch,
                            "status": "error",
                            "connectivity": "offline",
                            "retired": True,
                            "room_ids": [],
                        }
                    ),
                ),
            )
            await self._append(
                db,
                row,
                Notice(
                    type="notice",
                    level="warning",
                    code="SESSION_RETIRED",
                    message="The owner retired this session. Prior execution outcomes remain unknown. Recovery and automatic replay are disabled; history is retained.",
                ),
            )
            return Snapshot.model_validate(row.snapshot)

    async def _interrupt_pending(
        self, db: AsyncSession, row: SdkSession, snapshot: Snapshot, code: str
    ) -> None:
        for request in snapshot.requests:
            if request.state in ("open", "submitting"):
                await self._append(
                    db,
                    row,
                    RequestSettled(
                        type="request.settled",
                        request_id=request.request_id,
                        revision=request.revision + 1,
                        outcome="interrupted",
                        command_id=None,
                        result=None,
                    ),
                )
        for turn in snapshot.turns:
            if turn.status in ("queued", "running"):
                await self._append(
                    db, row, turn.model_copy(update={"status": "interrupted"})
                )
        commands = (
            await db.scalars(
                select(SdkSessionCommand).where(
                    SdkSessionCommand.tenant_id == row.tenant_id,
                    SdkSessionCommand.session_id == row.id,
                )
            )
        ).all()
        for command in commands:
            status = CommandStatus.model_validate(command.status)
            if status.status in ("accepted", "dispatched"):
                status = status.model_copy(
                    update={
                        "status": "unknown",
                        "code": code,
                        "message": "The command was not confirmed. It will not be resent.",
                    }
                )
                command.status = status.model_dump(by_alias=True)
                await self._append(db, row, status)

    async def recover(
        self,
        agent_id: str,
        session_id: str,
        host_id: str,
        previous_epoch: str,
        operation_id: str,
        through_host_sequence: int,
    ) -> Snapshot:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._locked(db, session_id)
            if row.recovery.get("retired_epoch"):
                raise SessionError(
                    "SESSION_RETIRED",
                    "This session was retired by its owner and cannot resume.",
                )
            if row.agent_id != agent_id or row.host_id != host_id:
                raise SessionError(
                    "NOT_AUTHORIZED", "Recovery belongs to another host."
                )
            if row.recovery.get("operation_id") == operation_id:
                if (
                    row.recovery.get("previous_epoch") != previous_epoch
                    or row.recovery.get("through_host_sequence")
                    != through_host_sequence
                ):
                    raise SessionError(
                        "IDEMPOTENCY_CONFLICT", "Recovery operation changed."
                    )
                return Snapshot.model_validate(row.snapshot)
            if row.epoch != previous_epoch:
                raise SessionError("STALE_EPOCH", "Session generation changed.")
            if not row.recovery.get("quiesced"):
                raise SessionError(
                    "FENCING_REQUIRED",
                    "Confirm the previous execution has stopped before recovery.",
                )
            if row.host_sequence != through_host_sequence:
                raise SessionError(
                    "EXPECTED_SEQUENCE",
                    "Reconcile every durable upload before recovery.",
                )
            snapshot = Snapshot.model_validate(row.snapshot)
            await self._interrupt_pending(db, row, snapshot, "HOST_RESTARTED")
            row.epoch = str(uuid.uuid4())
            row.host_sequence = 0
            row.lease_expires_at = (await self._now(db)) + timedelta(
                seconds=LEASE_SECONDS
            )
            row.recovery = {
                "operation_id": operation_id,
                "previous_epoch": previous_epoch,
                "through_host_sequence": through_host_sequence,
                "quiesced": False,
            }
            snapshot = Snapshot.model_validate(row.snapshot)
            session = snapshot.session.model_copy(
                update={
                    "epoch": row.epoch,
                    "connectivity": "online",
                    "status": "starting",
                }
            )
            row.snapshot = snapshot.model_copy(update={"session": session}).model_dump(
                by_alias=True
            )
            await self._append(
                db, row, SessionUpsert(type="session.upsert", session=session)
            )
            return Snapshot.model_validate(row.snapshot)

    async def renew(
        self, agent_id: str, session_id: str, host_id: str, epoch: str
    ) -> None:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._host(db, agent_id, session_id, host_id, epoch)
            row.lease_expires_at = (await self._now(db)) + timedelta(
                seconds=LEASE_SECONDS
            )

    async def ingest(
        self, agent_id: str, host_id: str, event: HostEvent, *, reconcile: bool = False
    ) -> int:
        try:
            event = parse_host_event(event.model_dump(by_alias=True))
        except ValueError as exc:
            raise SessionError("INVALID_EVENT", str(exc)) from exc
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            if reconcile:
                row = await self._host_identity(
                    db, agent_id, event.session_id, host_id, event.epoch
                )
                if not row.recovery.get("quiesced"):
                    raise SessionError(
                        "FENCING_REQUIRED", "Reconciliation requires stopped execution."
                    )
            else:
                row = await self._host(
                    db, agent_id, event.session_id, host_id, event.epoch
                )
            previous = await db.scalar(
                select(SdkSessionEvent).where(
                    SdkSessionEvent.tenant_id == row.tenant_id,
                    SdkSessionEvent.session_id == row.id,
                    SdkSessionEvent.epoch == row.epoch,
                    SdkSessionEvent.host_sequence == event.host_sequence,
                )
            )
            payload = event.model_dump(by_alias=True)
            if previous is not None:
                if (
                    parse_host_event(previous.host_event).model_dump(by_alias=True)
                    != payload
                ):
                    raise SessionError(
                        "IDEMPOTENCY_CONFLICT", "Host sequence has different content."
                    )
                return row.host_sequence
            if event.host_sequence != row.host_sequence + 1:
                raise SessionError(
                    "EXPECTED_SEQUENCE",
                    f"Expected host sequence {row.host_sequence + 1}.",
                )
            if await db.scalar(
                select(SdkSessionEvent).where(
                    SdkSessionEvent.tenant_id == row.tenant_id,
                    SdkSessionEvent.session_id == row.id,
                    SdkSessionEvent.event_id == event.event_id,
                )
            ):
                raise SessionError(
                    "IDEMPOTENCY_CONFLICT", "Event ID has already been used."
                )
            await self._validate_event(db, row, event)
            body = event.body
            if isinstance(body, SessionUpsert):
                body = body.model_copy(
                    update={
                        "session": body.session.model_copy(
                            update={
                                "room_ids": Snapshot.model_validate(
                                    row.snapshot
                                ).session.room_ids,
                                "retired": Snapshot.model_validate(
                                    row.snapshot
                                ).session.retired,
                            }
                        )
                    }
                )
            elif isinstance(body, RequestOpened):
                deadline = (await self._now(db)) + timedelta(minutes=30)
                if body.request.expires_at:
                    deadline = min(
                        deadline, datetime.fromisoformat(body.request.expires_at)
                    )
                body = body.model_copy(
                    update={
                        "request": body.request.model_copy(
                            update={"expires_at": deadline.isoformat()}
                        )
                    }
                )
            await self._append(db, row, body, event)
            row.host_sequence = event.host_sequence
            if isinstance(event.body, CommandResult):
                stored = await db.get(
                    SdkSessionCommand,
                    (require_tenant_id(), row.id, event.body.command_id),
                )
                status = CommandStatus(
                    type="command.status",
                    command_id=event.body.command_id,
                    status=event.body.status,
                    code=event.body.code,
                    message=event.body.message,
                )
                if stored is None:
                    raise SessionError("NOT_FOUND", "Unknown command result.")
                stored.status = status.model_dump(by_alias=True)
                await self._append(db, row, status)
            return row.host_sequence

    async def submit(
        self, command: Command, *, user_id: str | None, bridge_id: str | None
    ) -> CommandStatus:
        if len(command.model_dump_json().encode("utf-8")) > 60 * 1024:
            raise SessionError("PAYLOAD_TOO_LARGE", "Command exceeds 60 KiB.")
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._locked(db, command.session_id)
            await self._authorize(db, row, command.origin, user_id, bridge_id)
            try:
                return await self._accept(db, row, command, bridge_id)
            except SessionError as exc:
                if exc.code in ("NOT_AUTHORIZED", "IDEMPOTENCY_CONFLICT"):
                    raise
                existing = await db.get(
                    SdkSessionCommand,
                    (require_tenant_id(), row.id, command.command_id),
                )
                if existing is not None:
                    raise
                return await self._record_rejection(
                    db, row, command, exc.code, str(exc)
                )

    async def reconcile(self, command: Command, user_id: str) -> CommandStatus:
        if len(command.model_dump_json().encode("utf-8")) > 60 * 1024:
            raise SessionError("PAYLOAD_TOO_LARGE", "Command exceeds 60 KiB.")
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._locked(db, command.session_id)
            await self._authorize(db, row, command.origin, user_id, None)
            previous = await db.get(
                SdkSessionCommand, (require_tenant_id(), row.id, command.command_id)
            )
            if previous is not None:
                if self._command_identity(previous.command) != self._command_identity(
                    command.model_dump(by_alias=True)
                ):
                    raise SessionError(
                        "IDEMPOTENCY_CONFLICT",
                        "Command ID has different content or origin.",
                    )
                return CommandStatus.model_validate(previous.status)
            return await self._record_rejection(
                db,
                row,
                command,
                "NOT_ACCEPTED",
                "The server did not accept this command. It will not execute under this ID. Review before sending again.",
            )

    async def _record_rejection(
        self,
        db: AsyncSession,
        row: SdkSession,
        command: Command,
        code: str,
        message: str,
    ) -> CommandStatus:
        status = CommandStatus(
            type="command.status",
            command_id=command.command_id,
            status="rejected",
            code=code,
            message=message,
        )
        snapshot = Snapshot.model_validate(row.snapshot)
        db.add(
            SdkSessionCommand(
                session_id=row.id,
                command_id=command.command_id,
                accepted_sequence=snapshot.through_sequence + 1,
                command=command.model_dump(by_alias=True),
                status=status.model_dump(by_alias=True),
            )
        )
        await self._append(db, row, status)
        return status

    async def submit_room_message(
        self,
        agent_id: str,
        session_id: str,
        host_id: str,
        epoch: str,
        room_id: str,
        message_id: str,
        sequence: int,
        missed_count: int,
        gap_reason: str | None,
        buffer: EventBuffer,
    ) -> CommandStatus:
        command_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL, f"switch-room:{agent_id}:{room_id}:{message_id}"
            )
        )
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            agent = await db.scalar(
                select(Agent).where(Agent.id == agent_id).with_for_update()
            )
            row = await self._host(db, agent_id, session_id, host_id, epoch)
            room = await db.get(Room, room_id)
            if (
                agent is None
                or room is None
                or await db.get(ClientRoom, (agent.client_id, room_id)) is None
            ):
                raise SessionError(
                    "NOT_AUTHORIZED", "The agent is not a member of this room."
                )
            previous = await db.scalar(
                select(SdkSessionCommand)
                .join(
                    SdkSession,
                    (SdkSession.id == SdkSessionCommand.session_id)
                    & (SdkSession.tenant_id == SdkSessionCommand.tenant_id),
                )
                .where(
                    SdkSession.tenant_id == require_tenant_id(),
                    SdkSession.agent_id == agent_id,
                    SdkSessionCommand.command_id == command_id,
                )
            )
            if previous is not None:
                if previous.session_id != session_id:
                    raise SessionError(
                        "ROOM_MESSAGE_RESERVED",
                        "This room message belongs to another session.",
                    )
                return CommandStatus.model_validate(previous.status)
            try:
                candidates = buffer.read_from(agent_id, sequence - 1, limit=1)
            except CursorExpiredError as error:
                raise SessionError(
                    "ROOM_EVENT_UNAVAILABLE",
                    "The room event is no longer retained; it was not submitted.",
                ) from error
            entry = candidates[0] if candidates else None
            if entry is None or entry.seq != sequence or entry.room_id != room_id:
                raise SessionError(
                    "ROOM_EVENT_UNAVAILABLE", "The verified room event is unavailable."
                )
            payload = entry.event.payload
            if entry.event.type == "room_join" or entry.event.type.startswith("task_"):
                canonical = json.dumps(
                    payload.model_dump(mode="json"),
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
                expected_id = (
                    f"{entry.event.type}:"
                    + hashlib.sha256(canonical.encode()).hexdigest()
                )
                if not entry.notifiable or message_id != expected_id:
                    raise SessionError(
                        "NOT_AUTHORIZED",
                        "Only the verified subscribed event can be submitted.",
                    )
                payload = MessagePayload(
                    addressed=True,
                    sender="switch",
                    sender_name="Switch",
                    message_id=expected_id,
                    body=f"{entry.event.type}: {canonical}",
                    timestamp=0,
                )
            if (
                not isinstance(payload, MessagePayload)
                or not payload.addressed
                or payload.message_id != message_id
            ):
                raise SessionError(
                    "NOT_AUTHORIZED",
                    "Only the verified addressed message can be submitted.",
                )
            bridge = (
                await db.get(CollaborationBridge, room.bridge_id)
                if room.bridge_id
                else None
            )
            if (
                (bridge is not None and bridge.type not in get_args(Surface))
                or entry.event.bridge_id != (bridge.id if bridge else None)
                or (room.bridge_id is not None and bridge is None)
            ):
                raise SessionError(
                    "NOT_AUTHORIZED", "The room event has no verified platform origin."
                )
            attachments = []
            attachment_notices = []
            capabilities = Snapshot.model_validate(row.snapshot).session.capabilities
            for index, reference in enumerate(payload.attachments):
                try:
                    if index >= MAX_ATTACHMENTS:
                        raise ValueError(
                            "At most eight attachments can be delivered per message."
                        )
                    source = await db.scalar(
                        select(MediaBlob).where(
                            MediaBlob.tenant_id == require_tenant_id(),
                            MediaBlob.uri == reference.mxc,
                        )
                    )
                    if source is None:
                        raise ValueError(
                            "The room attachment bytes are unavailable; ask the sender to upload the file again."
                        )
                    mime_type = source.content_type or reference.mimetype
                    validate_attachment(reference.filename, mime_type, source.data)
                    if mime_type not in capabilities.attachment_mime_types:
                        raise ValueError(
                            "The selected provider model does not support this attachment type."
                        )
                    if (
                        source.sha256
                        and hashlib.sha256(source.data).hexdigest() != source.sha256
                    ):
                        raise ValueError(
                            "The room attachment failed its integrity check."
                        )
                    attachment_id = str(
                        uuid.uuid5(
                            uuid.NAMESPACE_URL,
                            f"{room_id}:{message_id}:{index}:{reference.mxc}",
                        )
                    )
                    uri = attachment_uri(session_id, attachment_id)
                    blob = await db.scalar(
                        select(MediaBlob).where(
                            MediaBlob.tenant_id == require_tenant_id(),
                            MediaBlob.uri == uri,
                        )
                    )
                    if blob is None:
                        blob = MediaBlob(
                            uri=uri,
                            filename=reference.filename,
                            content_type=mime_type,
                            size=len(source.data),
                            data=source.data,
                            sdk_session_id=session_id,
                            sha256=hashlib.sha256(source.data).hexdigest(),
                        )
                        db.add(blob)
                        await db.flush()
                    attachments.append(attachment_metadata(attachment_id, blob))
                except ValueError as exc:
                    attachment_notices.append(
                        f"Attachment {reference.filename!r} was not delivered: {exc}"
                    )
            text = (
                f"[Switch] {payload.sender_name} addressed you in room {room_id} (message_id {message_id}, thread_id {payload.thread_id or 'none'}):\n{payload.body}"
                + ("\n\n" + "\n".join(attachment_notices) if attachment_notices else "")
            )
            if missed_count > 0:
                plural = "" if missed_count == 1 else "s"
                text += f"\n({missed_count} unaddressed room message{plural} arrived since the previous message you were sent — call read_context to catch up.)"
            if gap_reason:
                text += f"\n⚠️ Some earlier room events were dropped and cannot be replayed ({gap_reason}) — call read_context before responding."
            command = Command(
                contract_version=1,
                command_id=command_id,
                session_id=session_id,
                epoch=epoch,
                origin=Origin.model_validate(
                    {
                        "actorId": payload.sender,
                        "surface": bridge.type if bridge else "switch-web",
                        "roomId": room_id,
                        "threadId": payload.thread_id,
                        "messageId": payload.message_id,
                    }
                ),
                body=MessageSend(
                    type="message.send",
                    text=text,
                    attachments=attachments,
                    delivery="queue",
                ),
            )
            if len(command.model_dump_json().encode("utf-8")) > 60 * 1024:
                raise SessionError("PAYLOAD_TOO_LARGE", "Command exceeds 60 KiB.")
            return await self._accept(db, row, command, bridge.id if bridge else None)

    async def _accept(
        self, db: AsyncSession, row: SdkSession, command: Command, bridge_id: str | None
    ) -> CommandStatus:
        previous = await db.get(
            SdkSessionCommand, (require_tenant_id(), row.id, command.command_id)
        )
        payload = command.model_dump(by_alias=True)
        if previous is not None:
            if self._command_identity(previous.command) != self._command_identity(
                payload
            ):
                raise SessionError(
                    "IDEMPOTENCY_CONFLICT",
                    "Command ID has different content or origin.",
                )
            return CommandStatus.model_validate(previous.status)
        if command.epoch != row.epoch:
            status = CommandStatus(
                type="command.status",
                command_id=command.command_id,
                status="rejected",
                code="STALE_EPOCH",
                message="Session generation changed. Review the session before sending again.",
            )
            snapshot = Snapshot.model_validate(row.snapshot)
            db.add(
                SdkSessionCommand(
                    session_id=row.id,
                    command_id=command.command_id,
                    accepted_sequence=snapshot.through_sequence + 1,
                    command=payload,
                    status=status.model_dump(by_alias=True),
                )
            )
            await self._append(db, row, status)
            return status
        if row.lease_expires_at <= (await self._now(db)):
            raise SessionError("HOST_OFFLINE", "The session host is offline.")
        snapshot = Snapshot.model_validate(row.snapshot)
        body = command.body
        if isinstance(body, RequestAnswer):
            request = next(
                (r for r in snapshot.requests if r.request_id == body.request_id),
                None,
            )
            if request is None or request.state in ("resolved", "closed"):
                raise SessionError("REQUEST_CLOSED", "This request is no longer open.")
            if bridge_id is not None:
                turn = next(t for t in snapshot.turns if t.turn_id == request.turn_id)
                source = await db.get(
                    SdkSessionCommand, (require_tenant_id(), row.id, turn.command_id)
                )
                if source is None:
                    raise SessionError("NOT_FOUND", "Request has no source command.")
                origin = Command.model_validate(source.command).origin
                # Cards may be threaded under a channel-level prompt, and their
                # destination uses platform IDs rather than SDK message IDs.
                post = await db.scalar(
                    select(SessionRequestPost).where(
                        SessionRequestPost.bridge_id == bridge_id,
                        SessionRequestPost.session_id == row.id,
                        SessionRequestPost.request_id == request.request_id,
                        SessionRequestPost.epoch == row.epoch,
                    )
                )
                expected_thread = post.thread_id if post else origin.thread_id
                if (origin.room_id, expected_thread) != (
                    command.origin.room_id,
                    command.origin.thread_id,
                ) or (post is not None and post.room_id != origin.room_id):
                    raise SessionError(
                        "NOT_AUTHORIZED",
                        "Answer came from a different request destination.",
                    )
            if request.revision != body.expected_revision:
                raise SessionError("STALE_REVISION", "The request has changed.")
            if request.state == "submitting":
                raise SessionError(
                    "REQUEST_BUSY", "Another answer has reserved this request."
                )
            if request.expires_at and datetime.fromisoformat(request.expires_at) <= (
                await self._now(db)
            ):
                raise SessionError("REQUEST_CLOSED", "The request expired.")
            try:
                validate_answer(request.content, body.answer)
            except ValueError as exc:
                raise SessionError("INVALID_ANSWER", str(exc)) from exc
        elif isinstance(body, MessageSend):
            if body.delivery != "queue":
                raise SessionError(
                    "UNSUPPORTED_CAPABILITY", "Only queued input is supported."
                )
            if len(body.attachments) > MAX_ATTACHMENTS or len(
                {a.attachment_id for a in body.attachments}
            ) != len(body.attachments):
                raise SessionError(
                    "INVALID_ATTACHMENT", "Use at most eight distinct attachments."
                )
            for attachment in body.attachments:
                blob = await self._attachment(db, row.id, attachment.attachment_id)
                if attachment_metadata(attachment.attachment_id, blob) != attachment:
                    raise SessionError(
                        "INVALID_ATTACHMENT",
                        "Attachment metadata differs from the uploaded file.",
                    )
                if (
                    attachment.mime_type
                    not in snapshot.session.capabilities.attachment_mime_types
                ):
                    raise SessionError(
                        "UNSUPPORTED_CAPABILITY",
                        "This session cannot accept the attachment MIME type.",
                    )
            if snapshot.session.status not in ("ready", "running"):
                raise SessionError("HOST_OFFLINE", "The session is not ready.")
        elif isinstance(body, TurnInterrupt):
            if not snapshot.session.capabilities.interrupt:
                raise SessionError(
                    "UNSUPPORTED_CAPABILITY", "Interrupt is unavailable."
                )
            if not any(
                turn.turn_id == body.turn_id and turn.status == "running"
                for turn in snapshot.turns
            ):
                raise SessionError("TURN_NOT_ACTIVE", "The turn is no longer running.")
        elif isinstance(body, (SessionReset, SessionModelSet, SessionCompact)):
            supported = (
                snapshot.session.capabilities.reset
                if isinstance(body, SessionReset)
                else snapshot.session.capabilities.compact
                if isinstance(body, SessionCompact)
                else snapshot.session.capabilities.model_change
            )
            if not supported:
                raise SessionError(
                    "UNSUPPORTED_CAPABILITY", "Session control is unavailable."
                )
            if (
                snapshot.session.status
                not in (
                    ("ready", "error") if isinstance(body, SessionReset) else ("ready",)
                )
                or any(turn.status in ("queued", "running") for turn in snapshot.turns)
                or any(
                    request.state in ("open", "submitting")
                    for request in snapshot.requests
                )
            ):
                raise SessionError(
                    "SESSION_BUSY", "Finish or interrupt the current turn first."
                )
            if isinstance(body, SessionModelSet):
                model = next(
                    (m for m in snapshot.session.models if m.id == body.model_id), None
                )
                if model is None or any(
                    value not in model.options.get(key, [])
                    for key, value in body.options.items()
                ):
                    raise SessionError(
                        "UNSUPPORTED_MODEL", "Choose an offered model and options."
                    )
        elif isinstance(body, SessionStop):
            if snapshot.session.status == "stopped":
                raise SessionError(
                    "SESSION_STOPPED", "The session has already stopped."
                )
        else:
            raise SessionError(
                "UNSUPPORTED_CAPABILITY",
                "This session command is not available yet.",
            )
        status = CommandStatus(
            type="command.status",
            command_id=command.command_id,
            status="accepted",
            code=None,
            message=None,
        )
        db.add(
            SdkSessionCommand(
                session_id=row.id,
                command_id=command.command_id,
                accepted_sequence=snapshot.through_sequence + 1,
                command=payload,
                status=status.model_dump(by_alias=True),
            )
        )
        await self._append(db, row, status)
        if isinstance(body, RequestAnswer):
            await self._append(
                db,
                row,
                RequestSubmitting(
                    type="request.submitting",
                    request_id=body.request_id,
                    revision=body.expected_revision,
                    command_id=command.command_id,
                    actor_id=command.origin.actor_id,
                    surface=command.origin.surface,
                ),
            )
        return status

    async def pending(
        self, agent_id: str, session_id: str, host_id: str, epoch: str
    ) -> list[Command]:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._host(db, agent_id, session_id, host_id, epoch)
            snapshot = Snapshot.model_validate(row.snapshot)
            now = await self._now(db)
            for request in snapshot.requests:
                if (
                    request.state != "open"
                    or not request.expires_at
                    or datetime.fromisoformat(request.expires_at) > now
                ):
                    continue
                command_id = str(
                    uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"switch:request-timeout:{row.id}:{row.epoch}:{request.request_id}",
                    )
                )
                if (
                    await db.get(
                        SdkSessionCommand, (require_tenant_id(), row.id, command_id)
                    )
                    is not None
                ):
                    continue
                body: TurnInterrupt | SessionStop = (
                    TurnInterrupt(type="turn.interrupt", turn_id=request.turn_id)
                    if snapshot.session.capabilities.interrupt
                    else SessionStop(type="session.stop")
                )
                await self._accept(
                    db,
                    row,
                    Command(
                        contract_version=1,
                        session_id=row.id,
                        epoch=row.epoch,
                        command_id=command_id,
                        origin=Origin(
                            surface="switch-web",
                            actor_id="switch-session-authority",
                            room_id=None,
                            thread_id=None,
                            message_id=None,
                        ),
                        body=body,
                    ),
                    None,
                )
                await self._append(
                    db,
                    row,
                    Notice(
                        type="notice",
                        level="warning",
                        code="REQUEST_EXPIRED",
                        message="The request expired without an answer. Execution cancellation was queued; no approval was granted.",
                    ),
                )
            records = (
                await db.scalars(
                    select(SdkSessionCommand)
                    .where(
                        SdkSessionCommand.tenant_id == row.tenant_id,
                        SdkSessionCommand.session_id == row.id,
                        SdkSessionCommand.status["status"].astext.in_(
                            ["accepted", "dispatched"]
                        ),
                    )
                    .order_by(SdkSessionCommand.accepted_sequence)
                    .limit(100)
                )
            ).all()
            pending = []
            for record in records:
                status = CommandStatus.model_validate(record.status)
                if status.status not in ("accepted", "dispatched"):
                    continue
                pending.append(Command.model_validate(record.command))
                if status.status == "accepted":
                    status = status.model_copy(update={"status": "dispatched"})
                    record.status = status.model_dump(by_alias=True)
                    await self._append(db, row, status)
            return pending

    async def submit_room_control(
        self,
        agent_id: str,
        room_id: str,
        action: str,
        actor_id: str,
        message_id: str | None,
        thread_id: str | None,
        connections: ConnectionRegistry,
    ) -> CommandStatus | None:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            candidates = list(
                (
                    await db.scalars(
                        select(SdkSession)
                        .where(
                            SdkSession.tenant_id == require_tenant_id(),
                            SdkSession.agent_id == agent_id,
                            SdkSession.connection_id.is_not(None),
                        )
                        .with_for_update()
                    )
                ).all()
            )
            live = [
                row
                for row in candidates
                if row.connection_id is not None
                and (connection := connections.get(row.connection_id)) is not None
                and connection.agent_id == agent_id
                and connection.is_alive(time.monotonic())
                and room_id in connection.rooms
            ]
            if not live:
                if candidates:
                    raise SessionError(
                        "HOST_OFFLINE",
                        "No live SDK session is connected to this room. The command was not queued.",
                    )
                return None
            if len(live) != 1:
                raise SessionError(
                    "FENCING_REQUIRED", "More than one SDK session claims this room."
                )
            row = live[0]
            if not message_id:
                raise SessionError(
                    "INVALID_COMMAND", "The room command has no stable message ID."
                )
            room = await db.get(Room, room_id)
            if room is None:
                raise SessionError("NOT_FOUND", "The room no longer exists.")
            bridge = (
                await db.get(CollaborationBridge, room.bridge_id)
                if room.bridge_id
                else None
            )
            origin = Origin.model_validate(
                {
                    "surface": bridge.type if bridge else "switch-web",
                    "actorId": actor_id,
                    "roomId": room_id,
                    "threadId": thread_id,
                    "messageId": message_id,
                }
            )
            await self._authorize(
                db,
                row,
                origin,
                None if bridge else actor_id,
                bridge.id if bridge else None,
            )
            command_id = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"sdk-control:{agent_id}:{room_id}:{message_id}:{action}",
                )
            )
            previous = await db.get(
                SdkSessionCommand, (require_tenant_id(), row.id, command_id)
            )
            if previous is not None:
                return CommandStatus.model_validate(previous.status)
            snapshot = Snapshot.model_validate(row.snapshot)
            body: SessionReset | SessionCompact | TurnInterrupt
            if action == "reset":
                body = SessionReset(type="session.reset")
            elif action == "compact":
                body = SessionCompact(type="session.compact")
            elif action == "interrupt":
                turn = next(
                    (turn for turn in snapshot.turns if turn.status == "running"), None
                )
                if turn is None:
                    raise SessionError(
                        "TURN_NOT_ACTIVE", "There is no running turn to interrupt."
                    )
                body = TurnInterrupt(type="turn.interrupt", turn_id=turn.turn_id)
            else:
                raise SessionError(
                    "UNSUPPORTED_CAPABILITY", "This room command is unsupported."
                )
            return await self._accept(
                db,
                row,
                Command(
                    contract_version=1,
                    command_id=command_id,
                    session_id=row.id,
                    epoch=row.epoch,
                    origin=origin,
                    body=body,
                ),
                bridge.id if bridge else None,
            )

    async def bind_connection(
        self,
        agent_id: str,
        session_id: str,
        host_id: str,
        epoch: str,
        connection_id: str,
        connections: ConnectionRegistry,
    ) -> list[str]:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            agent = await db.scalar(
                select(Agent).where(Agent.id == agent_id).with_for_update()
            )
            row = await self._host(db, agent_id, session_id, host_id, epoch)
            connection = connections.get(connection_id)
            if (
                agent is None
                or connection is None
                or connection.agent_id != agent_id
                or connection.scope != "single"
                or not connection.is_alive(time.monotonic())
            ):
                raise SessionError(
                    "NOT_AUTHORIZED",
                    "The SDK room connection is not live or belongs to another agent.",
                )
            previous = await db.scalar(
                select(SdkSession.id).where(
                    SdkSession.tenant_id == require_tenant_id(),
                    SdkSession.connection_id == connection_id,
                    SdkSession.id != session_id,
                )
            )
            if previous is not None:
                raise SessionError(
                    "FENCING_REQUIRED", "Another SDK session owns this room connection."
                )
            rooms = sorted(connection.rooms)
            for room_id in rooms:
                if await db.get(ClientRoom, (agent.client_id, room_id)) is None:
                    raise SessionError(
                        "NOT_AUTHORIZED", "The agent is no longer a room member."
                    )
            row.connection_id = connection_id
            snapshot = Snapshot.model_validate(row.snapshot)
            if snapshot.session.room_ids != rooms:
                await self._append(
                    db,
                    row,
                    SessionUpsert(
                        type="session.upsert",
                        session=snapshot.session.model_copy(update={"room_ids": rooms}),
                    ),
                )
            return rooms

    async def upload_attachment(
        self,
        session_id: str,
        user_id: str,
        attachment_id: str,
        name: str,
        mime_type: str,
        data: bytes,
    ) -> Attachment:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            try:
                uri = attachment_uri(session_id, attachment_id)
                validate_attachment(name, mime_type, data)
            except ValueError as exc:
                raise SessionError("INVALID_ATTACHMENT", str(exc)) from exc
            blob = await db.scalar(
                select(MediaBlob).where(
                    MediaBlob.tenant_id == require_tenant_id(), MediaBlob.uri == uri
                )
            )
            if blob is not None:
                if (blob.filename, blob.content_type, blob.data) != (
                    name,
                    mime_type,
                    data,
                ):
                    raise SessionError(
                        "IDEMPOTENCY_CONFLICT", "Attachment ID has different content."
                    )
            else:
                blob = MediaBlob(
                    uri=uri,
                    sha256=hashlib.sha256(data).hexdigest(),
                    sdk_session_id=session_id,
                    filename=name,
                    content_type=mime_type,
                    size=len(data),
                    data=data,
                )
                db.add(blob)
                await db.flush()
            return attachment_metadata(attachment_id, blob)

    async def attachment(
        self,
        agent_id: str,
        session_id: str,
        host_id: str,
        epoch: str,
        attachment_id: str,
    ) -> MediaBlob:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            await self._host(db, agent_id, session_id, host_id, epoch)
            return await self._attachment(db, session_id, attachment_id)

    async def _attachment(
        self, db: AsyncSession, session_id: str, attachment_id: str
    ) -> MediaBlob:
        try:
            uri = attachment_uri(session_id, attachment_id)
        except ValueError as exc:
            raise SessionError("INVALID_ATTACHMENT", "Invalid attachment ID.") from exc
        blob = await db.scalar(
            select(MediaBlob).where(
                MediaBlob.tenant_id == require_tenant_id(), MediaBlob.uri == uri
            )
        )
        if blob is None:
            raise SessionError(
                "NOT_FOUND", "Attachment does not belong to this session."
            )
        if (
            blob.sha256 is not None
            and hashlib.sha256(blob.data).hexdigest() != blob.sha256
        ):
            raise SessionError(
                "INVALID_ATTACHMENT", "Stored attachment failed its integrity check."
            )
        return blob

    async def list_sessions(self, user_id: str) -> list[Session]:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            rows = (
                await db.scalars(
                    select(SdkSession)
                    .join(Agent, Agent.id == SdkSession.agent_id)
                    .where(
                        SdkSession.tenant_id == require_tenant_id(),
                        Agent.owner_id == user_id,
                    )
                    .order_by(SdkSession.id)
                )
            ).all()
            return [
                Snapshot.model_validate(row.snapshot).session.model_copy(
                    update={
                        "connectivity": "online"
                        if row.lease_expires_at > (await self._now(db))
                        else "offline"
                    }
                )
                for row in rows
            ]

    async def command_status(
        self, session_id: str, command_id: str, user_id: str
    ) -> CommandStatus:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            command = await db.get(
                SdkSessionCommand, (require_tenant_id(), session_id, command_id)
            )
            if command is None:
                raise SessionError("NOT_FOUND", "Command not found.")
            return CommandStatus.model_validate(command.status)

    async def snapshot(self, session_id: str, user_id: str) -> Snapshot:
        async with tenant_session(self._sessions, require_tenant_id()) as db:
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            snapshot = Snapshot.model_validate(row.snapshot)
            if row.lease_expires_at <= (await self._now(db)):
                snapshot = snapshot.model_copy(
                    update={
                        "session": snapshot.session.model_copy(
                            update={"connectivity": "offline"}
                        )
                    }
                )
            return snapshot

    async def events(
        self, session_id: str, user_id: str, after: int
    ) -> list[ServerEvent]:
        async with (
            tenant_session(self._sessions, require_tenant_id()) as db,
            db.begin(),
        ):
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            snapshot = Snapshot.model_validate(row.snapshot)
            if (
                row.lease_expires_at <= (await self._now(db))
                and snapshot.session.connectivity == "online"
            ):
                await self._append(
                    db,
                    row,
                    SessionConnectivity(
                        type="session.connectivity", connectivity="offline"
                    ),
                )
            rows = (
                await db.scalars(
                    select(SdkSessionEvent)
                    .where(
                        SdkSessionEvent.tenant_id == require_tenant_id(),
                        SdkSessionEvent.session_id == session_id,
                        SdkSessionEvent.sequence > after,
                    )
                    .order_by(SdkSessionEvent.sequence)
                    .limit(100)
                )
            ).all()
            return [ServerEvent.model_validate(r.event) for r in rows]

    @staticmethod
    def _command_identity(payload: dict) -> dict:
        payload = Command.model_validate(payload).model_dump(by_alias=True)
        origin = {
            key: value for key, value in payload["origin"].items() if key != "messageId"
        }
        return {**payload, "origin": origin}

    async def _locked(self, db: AsyncSession, session_id: str) -> SdkSession:
        row = await db.scalar(
            select(SdkSession)
            .where(
                SdkSession.tenant_id == require_tenant_id(), SdkSession.id == session_id
            )
            .with_for_update()
        )
        if row is None:
            raise SessionError("NOT_FOUND", "Session not found.")
        return row

    async def _host(
        self, db: AsyncSession, agent_id: str, session_id: str, host_id: str, epoch: str
    ) -> SdkSession:
        row = await self._host_identity(db, agent_id, session_id, host_id, epoch)
        if row.recovery.get("quiesced"):
            raise SessionError("HOST_OFFLINE", "Host execution is quiesced.")
        if row.lease_expires_at <= (await self._now(db)):
            raise SessionError("HOST_OFFLINE", "Host lease expired.")
        return row

    async def _host_identity(
        self, db: AsyncSession, agent_id: str, session_id: str, host_id: str, epoch: str
    ) -> SdkSession:
        row = await self._locked(db, session_id)
        if row.agent_id != agent_id or row.host_id != host_id:
            raise SessionError("NOT_AUTHORIZED", "This host does not own the session.")
        if row.epoch != epoch:
            raise SessionError("STALE_EPOCH", "Session generation changed.")
        return row

    async def _owner(self, db: AsyncSession, row: SdkSession, user_id: str) -> None:
        agent = await db.get(Agent, row.agent_id)
        if agent is None or agent.owner_id != user_id:
            raise SessionError(
                "NOT_AUTHORIZED", "Only the agent owner can access the shared session."
            )

    async def _authorize(
        self,
        db: AsyncSession,
        row: SdkSession,
        origin: Origin,
        user_id: str | None,
        bridge_id: str | None,
    ) -> None:
        agent = await db.get(Agent, row.agent_id)
        if agent is None or (user_id is not None and bridge_id is not None):
            raise SessionError("NOT_AUTHORIZED", "Invalid session principal.")
        if user_id is not None:
            await self._owner(db, row, user_id)
            if origin.actor_id != user_id or origin.surface not in (
                "console",
                "switch-web",
            ):
                raise SessionError("NOT_AUTHORIZED", "Invalid gateway origin.")
        else:
            if bridge_id is None or origin.room_id is None:
                raise SessionError(
                    "NOT_AUTHORIZED", "Verified bridge identity is required."
                )
            room = await db.get(Room, origin.room_id)
            bridge = await db.get(CollaborationBridge, bridge_id)
            if (
                room is None
                or room.bridge_id != bridge_id
                or bridge is None
                or bridge.type != origin.surface
            ):
                raise SessionError(
                    "NOT_AUTHORIZED", "Callback destination does not match the bridge."
                )
            external_user_id = await db.scalar(
                select(ExternalUser.id)
                .join(Client, Client.id == ExternalUser.client_id)
                .join(ClientRoom, ClientRoom.client_id == Client.id)
                .where(
                    ExternalUser.bridge_id == bridge_id,
                    Client.matrix_user_id == origin.actor_id,
                    ClientRoom.room_id == origin.room_id,
                )
            )
            if external_user_id is None:
                logger.warning(
                    "Answer rejected for session %s: %s in room %s is not a "
                    "Switch-tracked member of this bridge.",
                    row.id,
                    origin.actor_id,
                    origin.room_id,
                )
                raise SessionError(
                    "NOT_AUTHORIZED",
                    "Room visibility does not grant permission to answer.",
                )
            claimants = list(
                await db.scalars(
                    select(ExternalUserClaim.user_id).where(
                        ExternalUserClaim.external_user_id == external_user_id
                    )
                )
            )
            allowed = can_address(
                parse_policy(agent.addressing_policy),
                room_id=origin.room_id,
                group_id=room.group_id,
                sender_kind="user",
                sender_id=external_user_id,
                sender_user_ids=claimants,
                sender_owner_user_id=None,
                owner_user_id=agent.owner_id,
            )
            if not allowed:
                logger.warning(
                    "Answer rejected for session %s: %s in room %s is not "
                    "admitted by agent %s's addressing policy.",
                    row.id,
                    origin.actor_id,
                    origin.room_id,
                    agent.name,
                )
                raise SessionError(
                    "NOT_AUTHORIZED",
                    "Room visibility does not grant permission to answer.",
                )
        if origin.room_id is not None:
            if await db.get(ClientRoom, (agent.client_id, origin.room_id)) is None:
                raise SessionError(
                    "NOT_AUTHORIZED", "The agent is not a member of this room."
                )

    async def _append(
        self,
        db: AsyncSession,
        row: SdkSession,
        body: ServerBody,
        host: HostEvent | None = None,
    ) -> None:
        snapshot = Snapshot.model_validate(row.snapshot)
        event = ServerEvent(
            contract_version=1,
            event_id=host.event_id if host else str(uuid.uuid4()),
            session_id=row.id,
            sequence=snapshot.through_sequence + 1,
            occurred_at=host.occurred_at
            if host
            else datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            body=body,
        )
        projection = SessionProjection(snapshot)
        try:
            projection.apply(event)
        except ValueError as exc:
            raise SessionError("INVALID_EVENT", str(exc)) from exc
        row.snapshot = projection.snapshot.model_dump(by_alias=True)
        db.add(
            SdkSessionEvent(
                session_id=row.id,
                sequence=event.sequence,
                epoch=row.epoch,
                event_id=event.event_id,
                host_sequence=host.host_sequence if host else None,
                host_event=host.model_dump(by_alias=True) if host else None,
                event=event.model_dump(by_alias=True),
            )
        )
        await db.flush()

    async def _validate_event(
        self, db: AsyncSession, row: SdkSession, event: HostEvent
    ) -> None:
        body = event.body
        snapshot = Snapshot.model_validate(row.snapshot)
        if isinstance(body, SessionUpsert):
            if (
                body.session.session_id != row.id
                or body.session.epoch != row.epoch
                or body.session.connectivity != "online"
                or body.session.host_id != row.host_id
                or body.session.agent_id != row.agent_id
            ):
                raise SessionError("NOT_AUTHORIZED", "Host session identity mismatch.")
        if isinstance(body, TurnUpsert):
            stored = (
                await db.get(
                    SdkSessionCommand, (require_tenant_id(), row.id, body.command_id)
                )
                if body.command_id
                else None
            )
            turn = next((t for t in snapshot.turns if t.turn_id == body.turn_id), None)
            if (
                stored is None
                or not isinstance(
                    Command.model_validate(stored.command).body, MessageSend
                )
                or (turn is not None and turn.command_id != body.command_id)
                or any(
                    t.command_id == body.command_id and t.turn_id != body.turn_id
                    for t in snapshot.turns
                )
            ):
                raise SessionError(
                    "NOT_AUTHORIZED",
                    "A turn requires its server-issued message command.",
                )
        if isinstance(body, RequestOpened):
            existing = next(
                (
                    r
                    for r in snapshot.requests
                    if r.request_id == body.request.request_id
                ),
                None,
            )
            if body.request.state != "open" or existing is not None:
                raise SessionError(
                    "STALE_REVISION", "A new request must be open and use a new ID."
                )
        if isinstance(body, (RequestOpened, ItemUpsert)):
            value = body.request if isinstance(body, RequestOpened) else body.item
            turn = next((t for t in snapshot.turns if t.turn_id == value.turn_id), None)
            if turn is None:
                raise SessionError("NOT_FOUND", "The event has no known turn.")
            if isinstance(body, ItemUpsert):
                command = await db.get(
                    SdkSessionCommand, (require_tenant_id(), row.id, turn.command_id)
                )
                if command is None:
                    raise SessionError("NOT_FOUND", "Unknown source command.")
                expected = (
                    Command.model_validate(command.command).origin
                    if body.item.kind == "user-message"
                    else None
                )
                source_command = Command.model_validate(command.command)
                if body.item.kind == "user-message" and (
                    not isinstance(source_command.body, MessageSend)
                    or body.item.text != source_command.body.text
                    or body.item.attachments != source_command.body.attachments
                ):
                    raise SessionError(
                        "NOT_AUTHORIZED",
                        "User message differs from the verified command.",
                    )
                if body.item.origin != expected:
                    raise SessionError(
                        "NOT_AUTHORIZED",
                        "Item origin differs from the verified command.",
                    )
        if isinstance(body, RequestSettled):
            request = next(
                (r for r in snapshot.requests if r.request_id == body.request_id), None
            )
            if request is not None and request.result == body:
                return
            if (
                request is None
                or request.state in ("closed", "resolved")
                or body.revision != request.revision + 1
            ):
                raise SessionError(
                    "STALE_REVISION", "Settlement does not match an open request."
                )
            if body.command_id is not None:
                if (
                    request.decided_by is None
                    or request.decided_by.command_id != body.command_id
                ):
                    raise SessionError(
                        "NOT_AUTHORIZED",
                        "Settlement does not match the reserved command.",
                    )
                stored = await db.get(
                    SdkSessionCommand, (require_tenant_id(), row.id, body.command_id)
                )
                if stored is None:
                    raise SessionError("NOT_FOUND", "Unknown reserved command.")
                answer = Command.model_validate(stored.command).body
                if (
                    isinstance(request.content, ApprovalContent)
                    and isinstance(answer, RequestAnswer)
                    and isinstance(answer.answer, ApprovalResult)
                ):
                    option = next(
                        o
                        for o in request.content.options
                        if o.option_id == answer.answer.option_id
                    )
                    if option.decision == "cancel" and body.outcome == "answered":
                        raise SessionError(
                            "INVALID_ANSWER",
                            "Cancellation cannot be settled as an answer.",
                        )
                if not isinstance(answer, RequestAnswer) or (
                    body.outcome == "answered" and body.result != answer.answer
                ):
                    raise SessionError(
                        "INVALID_ANSWER", "Settlement differs from the reserved answer."
                    )
            elif body.outcome == "answered":
                raise SessionError(
                    "NOT_AUTHORIZED", "An answer requires a reserved command."
                )
            if body.outcome != "answered" and body.result is not None:
                raise SessionError(
                    "INVALID_ANSWER",
                    "A closed request cannot contain an answer result.",
                )
        if isinstance(body, CommandResult):
            stored = await db.get(
                SdkSessionCommand, (require_tenant_id(), row.id, body.command_id)
            )
            if stored is None:
                raise SessionError("NOT_FOUND", "Unknown command result.")
            previous_status = CommandStatus.model_validate(stored.status)
            if previous_status.status in ("applied", "rejected") and (
                previous_status.status != body.status
                or previous_status.code != body.code
                or previous_status.message != body.message
            ):
                raise SessionError(
                    "IDEMPOTENCY_CONFLICT", "A confirmed command result cannot change."
                )
            settled_command = Command.model_validate(stored.command)
            if (
                isinstance(settled_command.body, RequestAnswer)
                and body.status == "applied"
            ):
                request = next(
                    r
                    for r in snapshot.requests
                    if r.request_id == settled_command.body.request_id
                )
                if (
                    request.result is None
                    or request.result.command_id != settled_command.command_id
                ):
                    raise SessionError(
                        "REQUEST_BUSY",
                        "Settle the request before confirming application.",
                    )
