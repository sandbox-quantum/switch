"""`/chats`: Switch Console's view of the rooms a person is a member of.

Every route except creating a chat requires the caller's membership of the
room (`ChatService.require_member`); adding a member requires managing it.
Owning an agent in a room makes its owner a member (`sync_owned_rooms`), so
the list, the event stream and the room routes bring that up to date first.
Refusals are `ChatError`s, answered as `{"detail": {"code", "message"}}`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.chats.service import ChatError, ChatService
from switch_core.chats.views import (
    CamelModel,
    ChatMember,
    ChatMessage,
    ChatSummary,
    chat_messages,
    chat_summary,
)
from switch_core.db.models import Room, User, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

PING_SECONDS = 20.0
RECHECK_SECONDS = 30.0
_CATCH_UP_PAGE = 200
MAX_PAGE = 200


def get_chat_service(request: Request) -> ChatService:
    return request.app.state.chat_service  # type: ignore[no-any-return]


async def chat_error_response(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ChatError)
    return JSONResponse(
        status_code=exc.status,
        content={"detail": {"code": exc.code, "message": exc.message}},
    )


class ChatList(CamelModel):
    chats: list[ChatSummary]


class ChatEnvelope(CamelModel):
    chat: ChatSummary


class CreateChatRequest(CamelModel):
    """`agentIds` names the chat's agents; `agentId` is the one-agent form
    earlier clients send. Exactly one of the two is given."""

    agent_id: str | None = None
    agent_ids: list[str] | None = None
    name: str | None = None
    request_id: str

    def chosen_agents(self) -> list[str]:
        if (self.agent_id is None) == (self.agent_ids is None):
            raise ChatError(
                422,
                "AGENTS_REQUIRED",
                "Name the chat's agents in agentIds, or one in agentId; not both.",
            )
        ids = [self.agent_id] if self.agent_id is not None else self.agent_ids or []
        return list(dict.fromkeys(ids))


class MessagePage(CamelModel):
    messages: list[ChatMessage]
    head_seq: int
    has_more: bool


class SendRequest(CamelModel):
    request_id: str
    body: str
    thread_root_id: str | None = None
    upload_ids: list[str] = []
    mention_agent_id: str | None = None


class SentMessages(CamelModel):
    messages: list[ChatMessage]


class StagedUploadResponse(CamelModel):
    upload_id: str
    uri: str
    filename: str
    mimetype: str
    size: int


class MemberList(CamelModel):
    members: list[ChatMember]


class AddMemberRequest(CamelModel):
    user_id: str


Service = Annotated[ChatService, Depends(get_chat_service)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def _summary(
    service: ChatService, session: AsyncSession, tenant_id: str, user: User, room: Room
) -> ChatSummary:
    return await chat_summary(
        session,
        room,
        viewer_id=user.id,
        can_manage=await service.can_manage(session, tenant_id, user, room),
    )


async def _member_list(
    service: ChatService, session: AsyncSession, room: Room
) -> MemberList:
    return MemberList(
        members=[
            ChatMember(user_id=member.id, name=member.name, is_owner=is_owner)
            for member, is_owner in await service.members(session, room)
        ]
    )


@router.get("", response_model=ChatList)
async def list_chats(user: CurrentUser, service: Service) -> ChatList:
    tenant_id = require_tenant_id()
    await service.sync_owned_rooms(tenant_id, user.id)
    async with tenant_session(service.session_factory, tenant_id) as session:
        if not await service.has_tenant_role(session, tenant_id, user.id):
            return ChatList(chats=[])
        rooms = await service.list_chats(session, user.id)
        return ChatList(
            chats=[
                await _summary(service, session, tenant_id, user, room)
                for room in rooms
            ]
        )


@router.post("", response_model=ChatEnvelope)
async def create_chat(
    req: CreateChatRequest, user: CurrentUser, service: Service
) -> ChatEnvelope:
    tenant_id = require_tenant_id()
    room = await service.create_chat(
        tenant_id,
        user,
        agent_ids=req.chosen_agents(),
        name=req.name,
        request_id=req.request_id,
    )
    async with tenant_session(service.session_factory, tenant_id) as session:
        return ChatEnvelope(
            chat=await _summary(service, session, tenant_id, user, room)
        )


@router.get("/events")
async def chat_events_stream(
    user: CurrentUser,
    service: Service,
    after: Annotated[str | None, Query()] = None,
) -> StreamingResponse:
    tenant_id = require_tenant_id()
    return StreamingResponse(
        chat_events(
            service,
            tenant_id,
            user,
            parse_after(after),
            ping_seconds=PING_SECONDS,
            recheck_seconds=RECHECK_SECONDS,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/{room_id}/messages", response_model=MessagePage)
async def list_messages(
    room_id: str,
    user: CurrentUser,
    service: Service,
    before_seq: Annotated[int | None, Query(alias="beforeSeq")] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> MessagePage:
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        room, _ = await service.require_member(session, tenant_id, user, room_id)
        rows, head_seq, has_more = await service.page(
            session, room.id, before_seq, limit
        )
        return MessagePage(
            messages=await chat_messages(session, room, rows),
            head_seq=head_seq,
            has_more=has_more,
        )


@router.post("/{room_id}/attachments", response_model=StagedUploadResponse)
async def upload_attachment(
    room_id: str,
    user: CurrentUser,
    service: Service,
    file: Annotated[UploadFile, File()],
    upload_id: Annotated[str, Form(alias="uploadId")],
) -> StagedUploadResponse:
    tenant_id = require_tenant_id()
    staged = await service.stage_upload(
        tenant_id,
        user,
        room_id,
        upload_id=upload_id,
        data=await file.read(),
        filename=file.filename or "attachment",
        mimetype=file.content_type or "application/octet-stream",
    )
    return StagedUploadResponse(
        upload_id=staged.upload_id,
        uri=staged.uri,
        filename=staged.filename,
        mimetype=staged.mimetype,
        size=staged.size,
    )


@router.post("/{room_id}/messages", response_model=SentMessages)
async def send_message(
    room_id: str, req: SendRequest, user: CurrentUser, service: Service
) -> SentMessages:
    tenant_id = require_tenant_id()
    room, posted = await service.send(
        tenant_id,
        user,
        room_id,
        request_id=req.request_id,
        body=req.body,
        thread_root_id=req.thread_root_id,
        upload_ids=req.upload_ids,
        mention_agent_id=req.mention_agent_id,
    )
    async with tenant_session(service.session_factory, tenant_id) as session:
        return SentMessages(messages=await chat_messages(session, room, posted))


@router.get("/{room_id}/media")
async def get_media(
    room_id: str,
    user: CurrentUser,
    service: Service,
    uri: Annotated[str, Query()],
) -> Response:
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        room, _ = await service.require_member(session, tenant_id, user, room_id)
        blob = await service.media(session, room, uri)
    return Response(
        content=blob.data,
        media_type=blob.content_type or "application/octet-stream",
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/{room_id}/members", response_model=MemberList)
async def list_members(room_id: str, user: CurrentUser, service: Service) -> MemberList:
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        room, _ = await service.require_member(session, tenant_id, user, room_id)
        return await _member_list(service, session, room)


@router.post("/{room_id}/members", response_model=MemberList)
async def add_member(
    room_id: str, req: AddMemberRequest, user: CurrentUser, service: Service
) -> MemberList:
    """Manager only, and the one route a non-member may call: a manager may
    add themselves to a room they manage."""
    tenant_id = require_tenant_id()
    room = await service.add_member(tenant_id, user, room_id, req.user_id)
    async with tenant_session(service.session_factory, tenant_id) as session:
        return await _member_list(service, session, room)


@router.delete("/{room_id}/members/{member_user_id}", status_code=204)
async def remove_member(
    room_id: str, member_user_id: str, user: CurrentUser, service: Service
) -> Response:
    await service.remove_member(require_tenant_id(), user, room_id, member_user_id)
    return Response(status_code=204)


@router.put("/{room_id}/hidden", status_code=204)
async def hide_chat(room_id: str, user: CurrentUser, service: Service) -> Response:
    await service.set_hidden(require_tenant_id(), user, room_id, True)
    return Response(status_code=204)


@router.delete("/{room_id}/hidden", status_code=204)
async def unhide_chat(room_id: str, user: CurrentUser, service: Service) -> Response:
    await service.set_hidden(require_tenant_id(), user, room_id, False)
    return Response(status_code=204)


@router.post("/{room_id}/archive", status_code=204)
async def archive_chat(room_id: str, user: CurrentUser, service: Service) -> Response:
    await service.archive(require_tenant_id(), user, room_id)
    return Response(status_code=204)


# ── Live updates ─────────────────────────────────────────────────────────────


def parse_after(raw: str | None) -> dict[str, int]:
    """`roomId:seq,roomId:seq` → `{roomId: seq}`."""
    cursors: dict[str, int] = {}
    for item in (raw or "").split(","):
        if not item:
            continue
        room_id, sep, seq = item.rpartition(":")
        if not sep or not room_id:
            raise HTTPException(422, f"Malformed cursor: {item!r}")
        try:
            cursors[room_id] = int(seq)
        except ValueError as exc:
            raise HTTPException(422, f"Malformed cursor: {item!r}") from exc
    return cursors


def _frame(event: str, data: object) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


class _ChatStream:
    """One caller's live view of their chats.

    Every wake-up re-reads what the caller may see before reading anything
    else, so a removal from a room or from the tenant ends that room's events
    at once. Database sessions are opened per pass and closed before waiting.
    """

    def __init__(
        self, service: ChatService, tenant_id: str, user: User, after: dict[str, int]
    ) -> None:
        self.service = service
        self.tenant_id = tenant_id
        self.user = user
        self.after = after
        self.cursors: dict[str, int] = {}
        self.dirty: set[str] = set()
        self.wake = asyncio.Event()

    async def on_room(self, room_id: str) -> None:
        self.dirty.add(room_id)
        self.wake.set()

    def on_memberships(self) -> None:
        self.wake.set()

    def close(self) -> None:
        for room_id in self.cursors:
            self.service.listener.unsubscribe(room_id, self.on_room)
        self.cursors.clear()

    def _untrack(self, room_id: str) -> bytes:
        self.service.listener.unsubscribe(room_id, self.on_room)
        self.cursors.pop(room_id, None)
        return _frame("chat.removed", {"roomId": room_id})

    async def refresh(
        self, read: set[str] | None, initial: bool
    ) -> tuple[list[bytes], bool]:
        """Frames for what changed, and whether the stream may continue.

        `read` names the rooms to read new messages from; None reads all,
        and first brings the caller's agent-owner memberships up to date.
        """
        frames: list[bytes] = []
        service = self.service
        if read is None:
            await service.sync_owned_rooms(self.tenant_id, self.user.id)
        async with tenant_session(service.session_factory, self.tenant_id) as session:
            if not await service.has_tenant_role(session, self.tenant_id, self.user.id):
                frames.extend(self._untrack(room_id) for room_id in list(self.cursors))
                frames.extend(
                    _frame("chat.removed", {"roomId": room_id})
                    for room_id in self.after
                    if initial
                )
                return frames, False
            rooms = {
                room.id: room
                for room in await service.stream_rooms(session, self.user.id)
            }
            for room_id in [r for r in self.cursors if r not in rooms]:
                frames.append(self._untrack(room_id))
            if initial:
                frames.extend(
                    _frame("chat.removed", {"roomId": room_id})
                    for room_id in self.after
                    if room_id not in rooms
                )
            for room_id, room in rooms.items():
                if room_id in self.cursors:
                    continue
                if initial and room_id in self.after:
                    self.cursors[room_id] = self.after[room_id]
                else:
                    summary = await _summary(
                        service, session, self.tenant_id, self.user, room
                    )
                    frames.append(_frame("chat", summary.model_dump(by_alias=True)))
                    self.cursors[room_id] = await service.head_seq(session, room_id)
                service.listener.subscribe(room_id, self.on_room)
            for room_id in list(self.cursors) if read is None else read:
                followed = rooms.get(room_id)
                if followed is not None:
                    frames.extend(await self._read(session, followed))
        return frames, True

    async def _read(self, session: AsyncSession, room: Room) -> list[bytes]:
        frames: list[bytes] = []
        while True:
            rows = await self.service.messages_after(
                session, room.id, self.cursors[room.id], _CATCH_UP_PAGE
            )
            if not rows:
                return frames
            self.cursors[room.id] = rows[-1].seq
            frames.extend(
                _frame("message", message.model_dump(by_alias=True))
                for message in await chat_messages(session, room, rows)
            )
            if len(rows) < _CATCH_UP_PAGE:
                return frames


async def chat_events(
    service: ChatService,
    tenant_id: str,
    user: User,
    after: dict[str, int],
    *,
    ping_seconds: float,
    recheck_seconds: float,
) -> AsyncIterator[bytes]:
    """The caller's chat events as SSE frames.

    Catches every member room up from its cursor in `after`, says `ready`,
    then pushes as rooms move. A room the caller joined since is announced as
    `chat` and followed from its head; one they lost is `chat.removed`. A
    re-read every `recheck_seconds` recovers anything a missed notification
    or another process's membership change left behind.
    """
    stream = _ChatStream(service, tenant_id, user, after)
    service.watch_memberships(tenant_id, user.id, stream.on_memberships)
    try:
        frames, alive = await stream.refresh(None, initial=True)
        for frame in frames:
            yield frame
        if not alive:
            return
        yield _frame("ready", {})
        now = time.monotonic()
        next_ping = now + ping_seconds
        next_recheck = now + recheck_seconds
        while True:
            timeout = max(0.0, min(next_ping, next_recheck) - time.monotonic())
            try:
                await asyncio.wait_for(stream.wake.wait(), timeout=timeout)
            except TimeoutError:
                pass
            now = time.monotonic()
            if now >= next_ping:
                next_ping = now + ping_seconds
                yield b": ping\n\n"
            read: set[str] | None
            if now >= next_recheck:
                next_recheck = now + recheck_seconds
                read = None
            elif stream.wake.is_set():
                read = set(stream.dirty)
            else:
                continue
            stream.wake.clear()
            stream.dirty.clear()
            frames, alive = await stream.refresh(read, initial=False)
            for frame in frames:
                yield frame
            if not alive:
                return
    finally:
        service.unwatch_memberships(tenant_id, user.id, stream.on_memberships)
        stream.close()
