from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.types import MessagePayload
from switch_core.bridges.collaboration.session.contract import (
    ApprovalContent,
    ApprovalResult,
    Command,
    CommandResult,
    CommandStatus,
    HostEvent,
    ItemUpsert,
    MessageSend,
    Origin,
    RequestAnswer,
    RequestOpened,
    RequestSettled,
    RequestSubmitting,
    ServerBody,
    ServerEvent,
    Session,
    SessionConnectivity,
    SessionStop,
    SessionUpsert,
    Snapshot,
    Surface,
    TurnInterrupt,
    TurnUpsert,
    parse_host_event,
)
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
)
from switch_core.sessions.validation import validate_answer

LEASE_SECONDS = 30


class SessionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SessionAuthority:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    async def acquire(
        self, agent_id: str, session: Session, operation_id: str | None = None
    ) -> Snapshot:
        if session.agent_id != agent_id:
            raise SessionError("NOT_AUTHORIZED", "Session belongs to another agent.")
        async with self._sessions() as db, db.begin():
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
                .where(SdkSession.id == session.session_id)
                .with_for_update()
            )
            now = datetime.now(UTC)
            if row is not None:
                if row.agent_id != agent_id:
                    raise SessionError(
                        "NOT_AUTHORIZED", "Session belongs to another agent."
                    )
                if (
                    operation_id is not None
                    and row.recovery.get("acquire_id") == operation_id
                ):
                    if row.recovery.get("acquire_session") != session.model_dump(
                        by_alias=True
                    ):
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
        async with self._sessions() as db, db.begin():
            row = await self._host_identity(db, agent_id, session_id, host_id, epoch)
            if row.recovery.get("quiesced"):
                return
            row.recovery = {**row.recovery, "quiesced": True}
            row.lease_expires_at = datetime.now(UTC)
            await self._append(
                db,
                row,
                SessionConnectivity(
                    type="session.connectivity", connectivity="offline"
                ),
            )

    async def recover(
        self,
        agent_id: str,
        session_id: str,
        host_id: str,
        previous_epoch: str,
        operation_id: str,
        through_host_sequence: int,
    ) -> Snapshot:
        async with self._sessions() as db, db.begin():
            row = await self._locked(db, session_id)
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
                        SdkSessionCommand.session_id == row.id
                    )
                )
            ).all()
            for command in commands:
                status = CommandStatus.model_validate(command.status)
                if status.status in ("accepted", "dispatched"):
                    status = status.model_copy(
                        update={
                            "status": "unknown",
                            "code": "HOST_RESTARTED",
                            "message": "The host restarted before confirming the command. It will not resend it.",
                        }
                    )
                    command.status = status.model_dump(by_alias=True)
                    await self._append(db, row, status)
            row.epoch = str(uuid.uuid4())
            row.host_sequence = 0
            row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=LEASE_SECONDS)
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
        async with self._sessions() as db, db.begin():
            row = await self._host(db, agent_id, session_id, host_id, epoch)
            row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=LEASE_SECONDS)

    async def ingest(
        self, agent_id: str, host_id: str, event: HostEvent, *, reconcile: bool = False
    ) -> int:
        try:
            event = parse_host_event(event.model_dump(by_alias=True))
        except ValueError as exc:
            raise SessionError("INVALID_EVENT", str(exc)) from exc
        async with self._sessions() as db, db.begin():
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
                    SdkSessionEvent.session_id == row.id,
                    SdkSessionEvent.epoch == row.epoch,
                    SdkSessionEvent.host_sequence == event.host_sequence,
                )
            )
            payload = event.model_dump(by_alias=True)
            if previous is not None:
                if previous.host_event != payload:
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
                    SdkSessionEvent.session_id == row.id,
                    SdkSessionEvent.event_id == event.event_id,
                )
            ):
                raise SessionError(
                    "IDEMPOTENCY_CONFLICT", "Event ID has already been used."
                )
            await self._validate_event(db, row, event)
            await self._append(db, row, event.body, event)
            row.host_sequence = event.host_sequence
            if isinstance(event.body, CommandResult):
                stored = await db.get(
                    SdkSessionCommand, (row.id, event.body.command_id)
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
        async with self._sessions() as db, db.begin():
            row = await self._locked(db, command.session_id)
            await self._authorize(db, row, command.origin, user_id, bridge_id)
            return await self._accept(db, row, command, bridge_id)

    async def submit_room_message(
        self,
        agent_id: str,
        session_id: str,
        host_id: str,
        epoch: str,
        room_id: str,
        message_id: str,
        sequence: int,
        buffer: EventBuffer,
    ) -> CommandStatus:
        command_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL, f"switch-room:{agent_id}:{room_id}:{message_id}"
            )
        )
        async with self._sessions() as db, db.begin():
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
                .join(SdkSession, SdkSession.id == SdkSessionCommand.session_id)
                .where(
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
                bridge is None
                or bridge.type not in get_args(Surface)
                or entry.event.bridge_id != bridge.id
            ):
                raise SessionError(
                    "NOT_AUTHORIZED", "The room event has no verified platform origin."
                )
            if payload.attachments:
                raise SessionError(
                    "UNSUPPORTED_CAPABILITY", "Room attachment staging is unavailable."
                )
            command = Command(
                contract_version=1,
                command_id=command_id,
                session_id=session_id,
                epoch=epoch,
                origin=Origin.model_validate(
                    {
                        "actorId": payload.sender,
                        "surface": bridge.type,
                        "roomId": room_id,
                        "threadId": payload.thread_id,
                        "messageId": payload.message_id,
                    }
                ),
                body=MessageSend(
                    type="message.send",
                    text=f"[Switch] {payload.sender_name} addressed you in room {room_id} (message_id {message_id}):\n{payload.body}",
                    attachments=[],
                    delivery="queue",
                ),
            )
            if len(command.model_dump_json().encode("utf-8")) > 60 * 1024:
                raise SessionError("PAYLOAD_TOO_LARGE", "Command exceeds 60 KiB.")
            return await self._accept(db, row, command, bridge.id)

    async def _accept(
        self, db: AsyncSession, row: SdkSession, command: Command, bridge_id: str | None
    ) -> CommandStatus:
        if command.epoch != row.epoch:
            raise SessionError("STALE_EPOCH", "Session generation changed.")
        previous = await db.get(SdkSessionCommand, (row.id, command.command_id))
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
        if row.lease_expires_at <= datetime.now(UTC):
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
                source = await db.get(SdkSessionCommand, (row.id, turn.command_id))
                if source is None:
                    raise SessionError("NOT_FOUND", "Request has no source command.")
                origin = Command.model_validate(source.command).origin
                if (origin.room_id, origin.thread_id) != (
                    command.origin.room_id,
                    command.origin.thread_id,
                ):
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
            if request.expires_at and datetime.fromisoformat(
                request.expires_at
            ) <= datetime.now(UTC):
                raise SessionError("REQUEST_CLOSED", "The request expired.")
            try:
                validate_answer(request.content, body.answer)
            except ValueError as exc:
                raise SessionError("INVALID_ANSWER", str(exc)) from exc
        elif isinstance(body, MessageSend):
            if body.delivery != "queue" or body.attachments:
                raise SessionError(
                    "UNSUPPORTED_CAPABILITY", "Only queued text is supported."
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
        async with self._sessions() as db, db.begin():
            row = await self._host(db, agent_id, session_id, host_id, epoch)
            records = (
                await db.scalars(
                    select(SdkSessionCommand)
                    .where(
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

    async def list_sessions(self, user_id: str) -> list[Session]:
        async with self._sessions() as db:
            rows = (
                await db.scalars(
                    select(SdkSession)
                    .join(Agent, Agent.id == SdkSession.agent_id)
                    .where(Agent.owner_id == user_id)
                    .order_by(SdkSession.id)
                )
            ).all()
            return [
                Snapshot.model_validate(row.snapshot).session.model_copy(
                    update={
                        "connectivity": "online"
                        if row.lease_expires_at > datetime.now(UTC)
                        else "offline"
                    }
                )
                for row in rows
            ]

    async def command_status(
        self, session_id: str, command_id: str, user_id: str
    ) -> CommandStatus:
        async with self._sessions() as db:
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            command = await db.get(SdkSessionCommand, (session_id, command_id))
            if command is None:
                raise SessionError("NOT_FOUND", "Command not found.")
            return CommandStatus.model_validate(command.status)

    async def snapshot(self, session_id: str, user_id: str) -> Snapshot:
        async with self._sessions() as db:
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            snapshot = Snapshot.model_validate(row.snapshot)
            if row.lease_expires_at <= datetime.now(UTC):
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
        async with self._sessions() as db, db.begin():
            row = await self._locked(db, session_id)
            await self._owner(db, row, user_id)
            snapshot = Snapshot.model_validate(row.snapshot)
            if (
                row.lease_expires_at <= datetime.now(UTC)
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
        origin = {
            key: value for key, value in payload["origin"].items() if key != "messageId"
        }
        return {**payload, "origin": origin}

    async def _locked(self, db: AsyncSession, session_id: str) -> SdkSession:
        row = await db.scalar(
            select(SdkSession).where(SdkSession.id == session_id).with_for_update()
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
        if row.lease_expires_at <= datetime.now(UTC):
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
            owner = await db.scalar(
                select(ExternalUserClaim.user_id)
                .join(
                    ExternalUser,
                    ExternalUser.id == ExternalUserClaim.external_user_id,
                )
                .join(Client, Client.id == ExternalUser.client_id)
                .join(
                    ClientRoom,
                    ClientRoom.client_id == Client.id,
                )
                .where(
                    ExternalUser.bridge_id == bridge_id,
                    Client.matrix_user_id == origin.actor_id,
                    ClientRoom.room_id == origin.room_id,
                    ExternalUserClaim.user_id == agent.owner_id,
                )
            )
            if owner is None:
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
        projection.apply(event)
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
                await db.get(SdkSessionCommand, (row.id, body.command_id))
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
                command = await db.get(SdkSessionCommand, (row.id, turn.command_id))
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
                stored = await db.get(SdkSessionCommand, (row.id, body.command_id))
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
            stored = await db.get(SdkSessionCommand, (row.id, body.command_id))
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
