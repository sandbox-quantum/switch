"""`/chats`: Switch Console's view of the rooms a person is a member of.

Every route except creating a chat requires the caller's membership of the
room (`ChatService.require_member`); adding a member or adding or removing
an agent requires managing it.
Owning an agent in a chat one started keeps one a
member of it (`sync_owned_rooms`), so the list, the event stream and the room
routes bring that up to date first.
Refusals are `ChatError`s, answered as `{"detail": {"code", "message"}}`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Annotated, Any, Literal

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

from switch_core.bridges.agent.commands import COMMANDS
from switch_core.chats.service import (
    ChatError,
    ChatService,
    RemovalReason,
    RoomControl,
)
from switch_core.chats.views import (
    CamelModel,
    ChatMember,
    ChatMention,
    ChatMessage,
    ChatSummary,
    chat_messages,
    chat_summaries,
)
from switch_core.db.models import (
    AgentSessionActivityItem,
    Room,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.agent_sessions import ApprovalRequestView
from switch_core.gateway.auth import get_current_user
from switch_core.session_activity.listener import Change, RoomSubscription

logger = logging.getLogger(__name__)

router = APIRouter()

PING_SECONDS = 20.0
ACTIVITY_QUEUE_MAX = 256
RECHECK_SECONDS = 30.0
_CATCH_UP_PAGE = 200
# Revisions one activity stream remembers before forgetting them all.
_ACTIVITY_SENT_MAX = 10_000
# Activity stream wake-ups that are not a change: reload everything, or
# re-read the caller's rooms.
_RESYNC = object()
_MEMBERSHIPS = object()
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
    """`agentIds` names the chat's agents, none or more; `agentId` is the
    one-agent form earlier clients send. Exactly one of the two is given.
    `memberUserIds` are the other people to add."""

    agent_id: str | None = None
    agent_ids: list[str] | None = None
    member_user_ids: list[str] = []
    name: str | None = None
    request_id: str
    # What the agent says as it joins, instead of its usual line; older
    # clients send none.
    greeting: str | None = None
    # "group" makes a group even of one agent and nobody else, which would
    # otherwise be a direct chat; older clients send none.
    kind: Literal["group"] | None = None

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
    mention_agent_ids: list[str] = []
    mention_user_ids: list[str] = []
    mention_spans: list[ChatMention] = []


class ControlRequest(CamelModel):
    request_id: str
    agent_id: str
    command: RoomControl
    # The message whose turn a `retry` runs again; absent for every other control.
    message_id: str | None = None


class ControlAccepted(CamelModel):
    """The command is posted, not done: the agent answers it in the room,
    in a thread rooted at `commandId`."""

    command_id: str


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


class ChatCommand(CamelModel):
    name: str
    description: str
    # How it is typed, with its arguments: `!reset <target>`.
    usage: str


class ChatCommands(CamelModel):
    commands: list[ChatCommand]


class AddMemberRequest(CamelModel):
    user_id: str


class AddAgentRequest(CamelModel):
    agent_id: str


class ActivityItemView(CamelModel):
    """One step of a turn; `revision` only grows, so a lower one is stale."""

    agent_id: str
    session_id: str
    turn_id: str
    item_id: str
    kind: str
    revision: int
    status: str
    title: str
    text: str
    command_id: str | None
    room_id: str | None
    thread_id: str | None
    message_id: str | None
    occurred_at: datetime
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, row: AgentSessionActivityItem) -> ActivityItemView:
        return cls(
            agent_id=row.agent_id,
            session_id=row.session_id,
            turn_id=row.turn_id,
            item_id=row.item_id,
            kind=row.kind,
            revision=row.revision,
            status=row.status,
            title=row.title,
            text=row.text,
            command_id=row.command_id,
            room_id=row.room_id,
            thread_id=row.thread_id,
            message_id=row.message_id,
            occurred_at=row.occurred_at,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class RoomActivity(CamelModel):
    items: list[ActivityItemView]
    approvals: list[ApprovalRequestView]


Service = Annotated[ChatService, Depends(get_chat_service)]
CurrentUser = Annotated[User, Depends(get_current_user)]


async def _summary(
    service: ChatService, session: AsyncSession, tenant_id: str, user: User, room: Room
) -> ChatSummary:
    [summary] = await _summaries(service, session, tenant_id, user, [room])
    return summary


async def _summaries(
    service: ChatService,
    session: AsyncSession,
    tenant_id: str,
    user: User,
    rooms: list[Room],
) -> list[ChatSummary]:
    """The rooms' summaries, read in a fixed number of queries."""
    if not rooms:
        return []
    administers = await service.administers(session, tenant_id, user)
    return await chat_summaries(
        session,
        rooms,
        viewer_id=user.id,
        can_manage={
            room.id: administers
            or (room.owner_id is not None and room.owner_id == user.id)
            for room in rooms
        },
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
            chats=await _summaries(service, session, tenant_id, user, rooms)
        )


@router.get("/archived", response_model=ChatList)
async def list_archived_chats(user: CurrentUser, service: Service) -> ChatList:
    """The caller's archived chats: those `GET /chats` would list were they
    not archived, hidden ones included."""
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        if not await service.has_tenant_role(session, tenant_id, user.id):
            return ChatList(chats=[])
        rooms = await service.archived_chats(session, user.id)
        return ChatList(
            chats=await _summaries(service, session, tenant_id, user, rooms)
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
        member_user_ids=req.member_user_ids,
        name=req.name,
        request_id=req.request_id,
        greeting=req.greeting,
        kind=req.kind,
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


class AgentCandidates(CamelModel):
    agent_ids: list[str]


@router.get("/agent-candidates", response_model=AgentCandidates)
async def agent_candidates(
    user: CurrentUser,
    service: Service,
    room_id: Annotated[str | None, Query(alias="roomId")] = None,
) -> AgentCandidates:
    """The agents the caller could add to a new chat, or with `roomId` to
    that chat, which they must manage."""
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        return AgentCandidates(
            agent_ids=await service.agent_candidates(session, tenant_id, user, room_id)
        )


@router.get("/activity/events")
async def chat_activity_stream(
    user: CurrentUser, service: Service
) -> StreamingResponse:
    tenant_id = require_tenant_id()
    return StreamingResponse(
        chat_activity_events(
            service,
            tenant_id,
            user,
            ping_seconds=PING_SECONDS,
            recheck_seconds=RECHECK_SECONDS,
            queue_max=ACTIVITY_QUEUE_MAX,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/{room_id}/activity", response_model=RoomActivity)
async def room_activity(
    room_id: str, user: CurrentUser, service: Service
) -> RoomActivity:
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        room, _ = await service.require_member(session, tenant_id, user, room_id)
        items, approvals = await service.room_activity(session, room.id)
        return RoomActivity(
            items=[ActivityItemView.of(row) for row in items],
            approvals=[ApprovalRequestView.of(row) for row in approvals],
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


@router.get("/{room_id}/threads/{root_id}/messages", response_model=MessagePage)
async def list_thread_messages(
    room_id: str,
    root_id: str,
    user: CurrentUser,
    service: Service,
    before_seq: Annotated[int | None, Query(alias="beforeSeq")] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> MessagePage:
    """The thread's replies, paged like `/messages`; the root is not one."""
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        room, _ = await service.require_member(session, tenant_id, user, room_id)
        rows, head_seq, has_more = await service.thread_page(
            session, room, root_id, before_seq, limit
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
        mention_agent_ids=req.mention_agent_ids,
        mention_user_ids=req.mention_user_ids,
        mention_spans=req.mention_spans,
    )
    async with tenant_session(service.session_factory, tenant_id) as session:
        return SentMessages(messages=await chat_messages(session, room, posted))


@router.post("/{room_id}/controls", response_model=ControlAccepted, status_code=202)
async def send_control(
    room_id: str, req: ControlRequest, user: CurrentUser, service: Service
) -> ControlAccepted:
    command_id = await service.control(
        require_tenant_id(),
        user,
        room_id,
        request_id=req.request_id,
        agent_id=req.agent_id,
        command=req.command,
        message_id=req.message_id,
    )
    return ControlAccepted(command_id=command_id)


class WarmRequest(CamelModel):
    agent_id: str


@router.post("/{room_id}/warm", status_code=202)
async def warm_agent(
    room_id: str, req: WarmRequest, user: CurrentUser, service: Service
) -> Response:
    await service.warm(require_tenant_id(), user, room_id, agent_id=req.agent_id)
    return Response(status_code=202)


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


@router.get("/{room_id}/commands", response_model=ChatCommands)
async def list_commands(
    room_id: str, user: CurrentUser, service: Service
) -> ChatCommands:
    """The room commands a member can type here (`!name`), as the platforms'
    command lists show them: those that do something and are not hidden."""
    tenant_id = require_tenant_id()
    async with tenant_session(service.session_factory, tenant_id) as session:
        await service.require_member(session, tenant_id, user, room_id)
    return ChatCommands(
        commands=[
            ChatCommand(
                name=command.name,
                description=command.description,
                usage=" ".join(
                    [
                        f"!{command.name}",
                        *(f"<{arg.name}>" for arg in command.args_spec),
                    ]
                ),
            )
            for command in COMMANDS
            if command.handler is not None
            and not command.hidden
            and command.description.strip()
        ]
    )


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


@router.post("/{room_id}/agents", response_model=ChatEnvelope)
async def add_agent(
    room_id: str, req: AddAgentRequest, user: CurrentUser, service: Service
) -> ChatEnvelope:
    """Manager only, and only an agent the manager may use in this room."""
    tenant_id = require_tenant_id()
    room = await service.add_agent(tenant_id, user, room_id, req.agent_id)
    async with tenant_session(service.session_factory, tenant_id) as session:
        return ChatEnvelope(
            chat=await _summary(service, session, tenant_id, user, room)
        )


@router.delete("/{room_id}/agents/{agent_id}", status_code=204)
async def remove_agent(
    room_id: str, agent_id: str, user: CurrentUser, service: Service
) -> Response:
    await service.remove_agent(require_tenant_id(), user, room_id, agent_id)
    return Response(status_code=204)


class ReadRequest(CamelModel):
    seq: int


@router.put("/{room_id}/read", status_code=204)
async def mark_read(
    room_id: str, req: ReadRequest, user: CurrentUser, service: Service
) -> Response:
    """The caller has been shown the chat up to `seq`; never moves back."""
    await service.mark_read(require_tenant_id(), user, room_id, req.seq)
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


@router.post("/{room_id}/unarchive", status_code=204)
async def unarchive_chat(room_id: str, user: CurrentUser, service: Service) -> Response:
    await service.unarchive(require_tenant_id(), user, room_id)
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


def _removed(room_id: str, reason: RemovalReason) -> bytes:
    """`chat.removed`: "access" when the caller lost the room (membership,
    tenant role), "unlisted" when they are still a member but it no longer
    qualifies for the list (no agents left, archived)."""
    return _frame("chat.removed", {"roomId": room_id, "reason": reason})


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
        self.announced: set[str] = set()
        self.sent: dict[str, dict[str, Any]] = {}
        self.resummarize = False
        self.resummarize_rooms: set[str] = set()
        self.dirty: set[str] = set()
        self.wake = asyncio.Event()

    async def on_room(self, room_id: str) -> None:
        self.dirty.add(room_id)
        self.wake.set()

    def on_memberships(self, room_ids: list[str] | None) -> None:
        if room_ids is None:
            self.resummarize = True
        else:
            self.resummarize_rooms.update(room_ids)
        self.wake.set()

    def close(self) -> None:
        for room_id in self.cursors:
            self.service.listener.unsubscribe(room_id, self.on_room)
        self.cursors.clear()

    def _untrack(self, room_id: str, reason: RemovalReason) -> bytes:
        self.service.listener.unsubscribe(room_id, self.on_room)
        self.cursors.pop(room_id, None)
        self.sent.pop(room_id, None)
        return _removed(room_id, reason)

    async def refresh(
        self, read: set[str] | None, initial: bool
    ) -> tuple[list[bytes], bool]:
        """Frames for what changed, and whether the stream may continue.

        `read` names the rooms to read new messages from; None reads all,
        and first brings the caller's agent-owner memberships up to date.
        """
        frames: list[bytes] = []
        service = self.service
        resummarize, self.resummarize = self.resummarize, False
        resummarize_rooms, self.resummarize_rooms = self.resummarize_rooms, set()
        if read is None:
            await service.sync_owned_rooms(self.tenant_id, self.user.id)
        async with tenant_session(service.session_factory, self.tenant_id) as session:
            if not await service.has_tenant_role(session, self.tenant_id, self.user.id):
                frames.extend(
                    self._untrack(room_id, "access") for room_id in list(self.cursors)
                )
                frames.extend(
                    _removed(room_id, "access") for room_id in self.after if initial
                )
                return frames, False
            rooms = await service.readable_and_listed(session, self.user.id)
            readable = {room.id: room for room, _ in rooms}
            listed = {room.id: room for room, is_listed in rooms if is_listed}
            for room_id in [r for r in self.cursors if r not in readable]:
                frames.append(self._untrack(room_id, "access"))
            if initial:
                for room_id in self.after:
                    if room_id not in readable:
                        frames.append(_removed(room_id, "access"))
                    elif room_id not in listed:
                        frames.append(_removed(room_id, "unlisted"))
            for room_id in [
                r for r in self.announced if r in readable and r not in listed
            ]:
                frames.append(_removed(room_id, "unlisted"))
                self.announced.discard(room_id)
                self.sent.pop(room_id, None)
            new = [room_id for room_id in readable if room_id not in self.cursors]
            heads = (
                await service.head_seqs(
                    session, [r for r in new if r not in self.after]
                )
                if initial
                else {}
            )
            announce: list[Room] = []
            for room_id in new:
                room = readable[room_id]
                if initial and room_id in self.after:
                    self.cursors[room_id] = self.after[room_id]
                    if room_id in listed:
                        self.announced.add(room_id)
                else:
                    if room_id in listed:
                        announce.append(room)
                    # A room joined since the stream opened is followed from
                    # where the caller joined it, so whatever was said before
                    # the stream noticed it is still sent.
                    self.cursors[room_id] = (
                        heads[room_id]
                        if initial
                        else await service.read_position(session, self.user.id, room_id)
                    )
                service.listener.subscribe(room_id, self.on_room)
            for room_id, room in listed.items():
                if room not in announce and (
                    room_id not in self.announced
                    or resummarize
                    or room_id in resummarize_rooms
                ):
                    announce.append(room)
            frames.extend(await self._announce(session, announce))
            self.announced.update(room.id for room in announce)
            to_read = [
                room_id
                for room_id in (list(self.cursors) if read is None else read)
                if room_id in readable
            ]
            # One look at which rooms moved past their cursors, then reads only
            # those: a recheck of quiet rooms costs one query, and fetches none.
            moved = await service.moved_rooms(
                session, {room_id: self.cursors[room_id] for room_id in to_read}
            )
            for room_id in to_read:
                if room_id in moved:
                    frames.extend(await self._read(session, readable[room_id]))
        return frames, True

    async def _announce(self, session: AsyncSession, rooms: list[Room]) -> list[bytes]:
        """`chat` frames for the rooms whose summary differs from the last sent."""
        frames: list[bytes] = []
        for room, summary in zip(
            rooms,
            await _summaries(self.service, session, self.tenant_id, self.user, rooms),
            strict=True,
        ):
            dump = summary.model_dump(by_alias=True)
            if self.sent.get(room.id) == dump:
                continue
            self.sent[room.id] = dump
            frames.append(_frame("chat", dump))
        return frames

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
    `chat` and followed from its head; one that leaves the list is `chat.removed`.
    A change to the caller's chats wakes the stream at once, whichever process
    made it (`chats/signals.py`). A re-read every `recheck_seconds` recovers
    anything a missed notification or a missed signal left behind.
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


async def chat_activity_events(
    service: ChatService,
    tenant_id: str,
    user: User,
    *,
    ping_seconds: float,
    recheck_seconds: float,
    queue_max: int,
) -> AsyncIterator[bytes]:
    """Turn steps and approval requests of the rooms the caller may read, as SSE.

    Says `ready` once subscribed, so a snapshot fetched after it misses
    nothing. Only changes in the caller's rooms wake the stream; the rooms are
    re-read when the caller's chats change, on a resync and every
    `recheck_seconds`. Readability is still checked on every change, so
    leaving a room stops its frames at once. `resync` means changes may have
    been missed (the listener reconnected, this connection fell behind, or the
    caller joined a room): reload snapshots.
    """
    queue: asyncio.Queue[object] = asyncio.Queue(maxsize=queue_max)

    def resync() -> None:
        while not queue.empty():
            queue.get_nowait()
        queue.put_nowait(_RESYNC)

    def put(item: object) -> None:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            resync()

    async def on_change(change: Change) -> None:
        put(change)

    async def on_resync() -> None:
        resync()

    def on_memberships(_room_ids: list[str] | None) -> None:
        # Whichever rooms changed, the readable set is read again.
        put(_MEMBERSHIPS)

    service.watch_memberships(tenant_id, user.id, on_memberships)
    subscription: RoomSubscription | None = None
    # Per-connection, so a turn reread on every change resends only moved steps.
    sent: dict[tuple[str, str, str, str], int] = {}
    try:
        await service.sync_owned_rooms(tenant_id, user.id)
        rooms = await _readable_room_ids(service, tenant_id, user)
        if rooms is None:
            return
        subscription = service.activity_listener.subscribe_rooms(
            tenant_id, rooms, on_change, on_resync
        )
        yield _frame("ready", {})
        now = time.monotonic()
        next_ping = now + ping_seconds
        next_recheck = now + recheck_seconds
        while True:
            timeout = max(0.0, min(next_ping, next_recheck) - time.monotonic())
            item: object = None
            with contextlib.suppress(TimeoutError):
                item = await asyncio.wait_for(queue.get(), timeout=timeout)
            now = time.monotonic()
            if now >= next_ping:
                next_ping = now + ping_seconds
                yield b": ping\n\n"
            recheck = now >= next_recheck
            if recheck:
                next_recheck = now + recheck_seconds
            if recheck or item is _RESYNC or item is _MEMBERSHIPS:
                current = await _readable_room_ids(service, tenant_id, user)
                if current is None:
                    return
                subscription.set_rooms(current)
                added = current - rooms
                rooms = current
                if item is _RESYNC or added:
                    sent.clear()
                    yield _frame("resync", {})
            if isinstance(item, Change):
                if len(sent) > _ACTIVITY_SENT_MAX:
                    # Forgetting only resends steps the client already holds.
                    sent.clear()
                frames = await _activity_frames(service, tenant_id, user, item, sent)
                if frames is None:
                    return
                for frame in frames:
                    yield frame
    finally:
        if subscription is not None:
            subscription.close()
        service.unwatch_memberships(tenant_id, user.id, on_memberships)


async def _readable_room_ids(
    service: ChatService, tenant_id: str, user: User
) -> set[str] | None:
    """The rooms the caller may read now; None once the caller has no tenant
    role, which ends the stream."""
    async with tenant_session(service.session_factory, tenant_id) as session:
        if not await service.has_tenant_role(session, tenant_id, user.id):
            return None
        return {room.id for room in await service.readable_rooms(session, user.id)}


async def _activity_frames(
    service: ChatService,
    tenant_id: str,
    user: User,
    change: Change,
    sent: dict[tuple[str, str, str, str], int],
) -> list[bytes] | None:
    """Frames for one change, if the caller may read its room now; None once
    the caller has no tenant role, which ends the stream.

    Reads only what moved: an announcement naming its step reads that one
    row, and none at all when a revision at least as new was already sent, so
    a burst of updates to a step is coalesced into the first read of it. An
    announcement from before steps were named rereads the turn."""
    if change.kind == "activity" and change.item_id is not None:
        key = (change.agent_id, change.session_id, change.key, change.item_id)
        if change.revision is not None and sent.get(key, -1) >= change.revision:
            return []
    async with tenant_session(service.session_factory, tenant_id) as session:
        member, reads = await service.reads_room(
            session, tenant_id, user.id, change.room_id
        )
        if not member:
            return None
        if not reads:
            return []
        if change.kind == "activity":
            if change.item_id is not None:
                item = await service.turn_item(
                    session,
                    change.agent_id,
                    change.session_id,
                    change.key,
                    change.item_id,
                )
                rows = [item] if item is not None else []
            else:
                rows = await service.turn_items(
                    session, change.agent_id, change.session_id, change.key
                )
            frames = []
            for row in rows:
                key = (row.agent_id, row.session_id, row.turn_id, row.item_id)
                if row.room_id == change.room_id and sent.get(key, -1) < row.revision:
                    sent[key] = row.revision
                    view = ActivityItemView.of(row)
                    frames.append(
                        _frame("activity", view.model_dump(mode="json", by_alias=True))
                    )
            return frames
        request = await service.approval(
            session, change.agent_id, change.session_id, change.key
        )
        if request is None or request.room_id != change.room_id:
            return []
        approval = ApprovalRequestView.of(request)
        return [_frame("approval", approval.model_dump(mode="json", by_alias=True))]
