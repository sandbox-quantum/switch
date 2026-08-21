from __future__ import annotations

import asyncio
import io
import logging
import time
from typing import Literal

import markdown
from nio import (
    AsyncClient,
    InviteMemberEvent,
    JoinedRoomsError,
    LoginError,
    MatrixRoom,
    ProfileSetDisplayNameError,
    ReactionEvent,
    RoomMemberEvent,
    RoomMessageMedia,
    RoomMessageText,
    RoomSendError,
    RoomTypingError,
    SyncError,
    SyncResponse,
    UnknownEvent,
    UploadError,
)
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.resource.events import (
    ResourceLoadRequest,
    ResourceLoadResponse,
    RoomDocumentCreateRequest,
    RoomDocumentCreateResponse,
    RoomDocumentDeleteRequest,
    RoomDocumentDeleteResponse,
    RoomDocumentUpdateRequest,
    RoomDocumentUpdateResponse,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.events import (
    AgentRuntimeStateEvent,
    CommandEvent,
    LlmCallReport,
    MediationLlmRequest,
    MediationLlmResponse,
    MediationToolRequest,
    MediationToolResult,
    PermissionRequest,
    PermissionResponse,
    SwitchEvent,
    TaskAccept,
    TaskCancel,
    TaskDelegate,
    TaskFinalise,
    TaskUpdate,
    ToolCallReport,
)

logger = logging.getLogger(__name__)

SYNC_STATE_INTERVAL = 30
SYNC_MAX_RETRIES = 5
SYNC_BACKOFF_BASE = 1.0
SYNC_BACKOFF_CAP = 60.0


class ClientConfig(BaseModel):
    pass


class ClientBase[ConfigT: ClientConfig]:
    config_class: type[ConfigT] = ClientConfig  # type: ignore[assignment]

    def __init__(
        self,
        *,
        client_id: str,
        matrix_user_id: str,
        display_name: str,
        password: str,
        server_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        client_store: ClientStore,
        config: ConfigT,
        device_id: str | None = None,
        access_token: str | None = None,
        next_batch_token: str | None = None,
    ) -> None:
        self.client_id = client_id
        self.matrix_user_id = matrix_user_id
        self.display_name = display_name
        self.password = password
        self.server_url = server_url
        self.session_factory = session_factory
        self.client_store = client_store
        self.config = config

        self.device_id = device_id
        self.access_token = access_token
        self.next_batch_token = next_batch_token

        self.nio_client: AsyncClient | None = None
        self.room_join_times: dict[str, int] = {}
        self._room_joined_events: dict[str, asyncio.Event] = {}
        # Rooms this client has already announced its arrival in. Distinct from
        # `room_join_times`, which is membership bookkeeping recorded as early as
        # possible (an explicit join, a membership lookup) so `wait_joined` and
        # the `_should_ignore` cutoff are accurate. Membership being known is not
        # evidence the arrival was announced.
        self._self_join_dispatched: set[str] = set()
        self._ready = asyncio.Event()
        self._startup_ts: int = 0
        self._last_sync_persist: float = 0.0
        self._sync_state_dirty: bool = False
        self._running: bool = False

    async def wait_ready(self) -> None:
        await self._ready.wait()

    async def set_display_name(self, display_name: str) -> None:
        """Change the name this client shows under in Matrix.

        The user id is an address and stays put; this is the label rooms
        render. Used to correct a puppet filed under a platform id before the
        platform would say who the person was.
        """
        resp = await self.client.set_displayname(display_name)
        if isinstance(resp, ProfileSetDisplayNameError):
            raise RuntimeError(
                f"Could not set the display name of {self.matrix_user_id}: {resp}"
            )
        self.display_name = display_name

    def _joined_event(self, room_id: str) -> asyncio.Event:
        event = self._room_joined_events.get(room_id)
        if event is None:
            event = asyncio.Event()
            self._room_joined_events[room_id] = event
        return event

    def _mark_joined(self, room_id: str, joined_at_ms: int) -> None:
        self.room_join_times[room_id] = joined_at_ms
        self._joined_event(room_id).set()

    async def _is_joined_on_server(self, room_id: str) -> bool:
        resp = await self.client.joined_rooms()
        if isinstance(resp, JoinedRoomsError):
            logger.error(
                "Failed to list joined rooms for %s: %s",
                self.matrix_user_id,
                resp.message,
            )
            return False
        return room_id in resp.rooms

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        """Block until this client is a member of `room_id`, up to `timeout`
        seconds. Returns True if joined, False on timeout. Callers that need to
        *send* into a room they have only just been invited to must await this
        first — a send issued before the join lands is rejected by the
        homeserver, and any event that does land before a member's join is
        filtered out by `_should_ignore`.

        A join observed through sync sets the event, but a join that predates
        this process never replays: the client resumes from a stored
        `next_batch` token, so an incremental sync carries no member event for a
        room it joined in an earlier run, and re-inviting an existing member is
        a no-op. The homeserver is therefore asked directly before waiting."""
        event = self._joined_event(room_id)
        if event.is_set():
            return True
        if await self._is_joined_on_server(room_id):
            self._mark_joined(room_id, self._startup_ts)
            return True
        try:
            await asyncio.wait_for(event.wait(), timeout)
        except TimeoutError:
            return False
        return True

    @property
    def client(self) -> AsyncClient:
        if self.nio_client is None:
            raise RuntimeError(
                f"Client {self.matrix_user_id} is not connected — call start() first"
            )
        return self.nio_client

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._startup_ts = int(time.time() * 1000)
        self._running = True

        await self._create_client()
        self.setup()

        logger.info("Client %s starting sync loop", self.matrix_user_id)
        retries = 0
        while self._running:
            try:
                await self.client.sync_forever(
                    timeout=30000, since=self.next_batch_token
                )
                retries = 0
            except Exception:
                if not self._running:
                    break
                retries += 1
                if retries > SYNC_MAX_RETRIES:
                    logger.error(
                        "Client %s exceeded %d sync retries, giving up",
                        self.matrix_user_id,
                        SYNC_MAX_RETRIES,
                    )
                    raise
                delay = min(SYNC_BACKOFF_BASE * (2 ** (retries - 1)), SYNC_BACKOFF_CAP)
                logger.exception(
                    "Sync loop error for %s (attempt %d/%d), retrying in %.1fs",
                    self.matrix_user_id,
                    retries,
                    SYNC_MAX_RETRIES,
                    delay,
                )
                await asyncio.sleep(delay)

    async def stop(self) -> None:
        logger.info("Stopping client %s", self.matrix_user_id)
        self._running = False
        await self._persist_state(force=True)
        await self.teardown()
        if self.nio_client:
            await self.nio_client.close()

    def setup(self) -> None:
        self.client.add_event_callback(self._handle_message, RoomMessageText)
        # RoomMessageMedia is the base of RoomMessageImage / RoomMessageFile, so
        # one callback covers every media msgtype.
        self.client.add_event_callback(self._handle_media, RoomMessageMedia)
        self.client.add_event_callback(self._handle_reaction, ReactionEvent)
        self.client.add_event_callback(self._handle_member_event, RoomMemberEvent)
        self.client.add_event_callback(self._handle_custom_event, UnknownEvent)
        self.client.add_event_callback(self._handle_invite, InviteMemberEvent)  # type: ignore[arg-type]
        self.client.add_response_callback(self._handle_sync, SyncResponse)
        self.client.add_response_callback(self._handle_sync_error, SyncError)

    async def teardown(self) -> None:
        pass

    # ── Authentication ─────────────────────────────────────────────────────────

    async def _create_client(self) -> None:
        self.nio_client = AsyncClient(self.server_url, self.matrix_user_id)

        if self.access_token and self.device_id:
            self.client.access_token = self.access_token
            self.client.device_id = self.device_id
            logger.info(
                "Client %s restored session from stored token", self.matrix_user_id
            )
        elif self.password:
            resp = await self.client.login(self.password)
            if isinstance(resp, LoginError):
                raise RuntimeError(
                    f"Login failed for {self.matrix_user_id}: {resp.message}"
                )
            self.device_id = resp.device_id
            self.access_token = self.client.access_token
            await self._persist_state(force=True)
            logger.info("Client %s authenticated via password", self.matrix_user_id)
        else:
            raise RuntimeError(f"No credentials available for {self.matrix_user_id}")

        self._ready.set()

    # ── Internal event handlers (filtering + dispatch to hooks) ────────────────

    async def _handle_message(self, room: MatrixRoom, event: RoomMessageText) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_message(room, event)
        except Exception:
            logger.exception(
                "Error in on_message for %s in %s", self.matrix_user_id, room.room_id
            )

    async def _handle_media(self, room: MatrixRoom, event: RoomMessageMedia) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_media(room, event)
        except Exception:
            logger.exception(
                "Error in on_media for %s in %s", self.matrix_user_id, room.room_id
            )

    async def _handle_reaction(self, room: MatrixRoom, event: ReactionEvent) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_reaction(room, event)
        except Exception:
            logger.exception(
                "Error in on_reaction for %s in %s", self.matrix_user_id, room.room_id
            )

    async def _handle_member_event(
        self, room: MatrixRoom, event: RoomMemberEvent
    ) -> None:
        if event.state_key == self.matrix_user_id:
            if event.membership == "join":
                self._mark_joined(room.room_id, event.server_timestamp)
                # A membership-preserving update (display name, avatar) re-fires
                # m.room.member with membership == "join"; only a transition into
                # membership is an arrival. Joins predating this process are not
                # ours to announce, and the room is recorded so a redelivery of
                # the same join does not announce it twice.
                if (
                    event.prev_membership != "join"
                    and event.server_timestamp >= self._startup_ts
                    and room.room_id not in self._self_join_dispatched
                ):
                    self._self_join_dispatched.add(room.room_id)
                    try:
                        await self.on_self_join(room, event)
                    except Exception:
                        logger.exception(
                            "Error in on_self_join for %s in %s",
                            self.matrix_user_id,
                            room.room_id,
                        )
                return
            if event.membership in ("leave", "ban"):
                # Departing ends the visit: being added back is a fresh arrival.
                self._self_join_dispatched.discard(room.room_id)
        if self._should_ignore(room, event):
            return
        try:
            await self.on_member_event(room, event)
        except Exception:
            logger.exception(
                "Error in on_member_event for %s in %s",
                self.matrix_user_id,
                room.room_id,
            )

    async def _handle_invite(self, room: MatrixRoom, event: InviteMemberEvent) -> None:
        try:
            await self.on_invite(room, event)
        except Exception:
            logger.exception(
                "Error in on_invite for %s in %s", self.matrix_user_id, room.room_id
            )

    _EVENT_DISPATCH: dict[str, tuple[type[SwitchEvent], str]] = {
        "com.switch.command": (CommandEvent, "on_command"),
        "com.switch.mediation.tool_request": (
            MediationToolRequest,
            "on_mediation_tool_request",
        ),
        "com.switch.mediation.llm_request": (
            MediationLlmRequest,
            "on_mediation_llm_request",
        ),
        "com.switch.mediation.tool_result": (
            MediationToolResult,
            "on_mediation_tool_result",
        ),
        "com.switch.mediation.llm_response": (
            MediationLlmResponse,
            "on_mediation_llm_response",
        ),
        "com.switch.report.tool_call": (ToolCallReport, "on_tool_call_report"),
        "com.switch.report.llm_call": (LlmCallReport, "on_llm_call_report"),
        "com.switch.task.delegate": (TaskDelegate, "on_task_delegate"),
        "com.switch.task.accept": (TaskAccept, "on_task_accept"),
        "com.switch.task.update": (TaskUpdate, "on_task_update"),
        "com.switch.task.finalise": (TaskFinalise, "on_task_finalise"),
        "com.switch.task.cancel": (TaskCancel, "on_task_cancel"),
        "com.switch.agent.runtime_state": (
            AgentRuntimeStateEvent,
            "on_agent_runtime_state",
        ),
        "com.switch.permission.request": (PermissionRequest, "on_permission_request"),
        "com.switch.permission.response": (
            PermissionResponse,
            "on_permission_response",
        ),
        "com.switch.resource.load_request": (
            ResourceLoadRequest,
            "on_resource_load_request",
        ),
        "com.switch.resource.load_response": (
            ResourceLoadResponse,
            "on_resource_load_response",
        ),
        "com.switch.resource.room_document_create_request": (
            RoomDocumentCreateRequest,
            "on_room_document_create_request",
        ),
        "com.switch.resource.room_document_create_response": (
            RoomDocumentCreateResponse,
            "on_room_document_create_response",
        ),
        "com.switch.resource.room_document_update_request": (
            RoomDocumentUpdateRequest,
            "on_room_document_update_request",
        ),
        "com.switch.resource.room_document_update_response": (
            RoomDocumentUpdateResponse,
            "on_room_document_update_response",
        ),
        "com.switch.resource.room_document_delete_request": (
            RoomDocumentDeleteRequest,
            "on_room_document_delete_request",
        ),
        "com.switch.resource.room_document_delete_response": (
            RoomDocumentDeleteResponse,
            "on_room_document_delete_response",
        ),
    }

    async def _handle_custom_event(self, room: MatrixRoom, event: UnknownEvent) -> None:
        if self._should_ignore(room, event):
            return

        entry = self._EVENT_DISPATCH.get(event.type)
        if entry is None:
            if event.type.startswith("com.switch.observe."):
                logger.warning(
                    "Observe event %s not yet supported in %s",
                    event.type,
                    room.room_id,
                )
            else:
                logger.error(
                    "Unhandled custom event type %s in %s",
                    event.type,
                    room.room_id,
                )
            return

        event_class, method_name = entry
        try:
            typed_event = event_class(
                **event.source.get("content", {}),
            )
        except Exception:
            logger.exception("Failed to parse %s event in %s", event.type, room.room_id)
            return

        # Command results reply into the command's thread. When the command was
        # typed inside an existing thread the bridge relates it to that thread's
        # root (m.thread); use that root so the result stays in that thread.
        # Otherwise the command itself roots the thread — use its own event id.
        # The id is not part of the event content, so inject it here.
        if isinstance(typed_event, CommandEvent):
            relates = event.source.get("content", {}).get("m.relates_to") or {}
            if relates.get("rel_type") == "m.thread":
                typed_event.thread_id = relates.get("event_id")
            else:
                typed_event.thread_id = event.event_id

        try:
            await getattr(self, method_name)(room, typed_event)
        except Exception:
            logger.exception("Error in handler for %s in %s", event.type, room.room_id)

    async def _handle_sync(self, response: SyncResponse) -> None:
        if response.next_batch and response.next_batch != self.next_batch_token:
            self.next_batch_token = response.next_batch
            await self._persist_state()

    async def _handle_sync_error(self, response: SyncError) -> None:
        logger.error("Sync error for %s: %s", self.matrix_user_id, response.message)
        if self.password:
            logger.info("Attempting re-login for %s", self.matrix_user_id)
            resp = await self.client.login(self.password)
            if isinstance(resp, LoginError):
                logger.error(
                    "Re-login failed for %s: %s", self.matrix_user_id, resp.message
                )

    # ── Filtering ──────────────────────────────────────────────────────────────

    def _should_ignore(self, room: MatrixRoom, event: object) -> bool:
        sender = getattr(event, "sender", None)
        if sender == self.matrix_user_id:
            return True

        server_ts = getattr(event, "server_timestamp", None)
        if server_ts is not None:
            join_time = self.room_join_times.get(room.room_id, self._startup_ts)
            if server_ts < join_time:
                return True

        return False

    # ── Event hooks (subclasses override) ──────────────────────────────────────

    async def on_message(self, room: MatrixRoom, event: RoomMessageText) -> None:
        pass

    async def on_media(self, room: MatrixRoom, event: RoomMessageMedia) -> None:
        pass

    async def on_reaction(self, room: MatrixRoom, event: ReactionEvent) -> None:
        pass

    async def on_self_join(self, room: MatrixRoom, event: RoomMemberEvent) -> None:
        pass

    async def on_member_event(self, room: MatrixRoom, event: RoomMemberEvent) -> None:
        pass

    async def on_invite(self, room: MatrixRoom, event: InviteMemberEvent) -> None:
        logger.info(
            "Client %s auto-accepting invite to %s", self.matrix_user_id, room.room_id
        )
        await self.join_room(room.room_id)

    async def on_command(self, room: MatrixRoom, event: CommandEvent) -> None:
        pass

    async def on_mediation_tool_request(
        self, room: MatrixRoom, event: MediationToolRequest
    ) -> None:
        pass

    async def on_mediation_llm_request(
        self, room: MatrixRoom, event: MediationLlmRequest
    ) -> None:
        pass

    async def on_mediation_tool_result(
        self, room: MatrixRoom, event: MediationToolResult
    ) -> None:
        pass

    async def on_mediation_llm_response(
        self, room: MatrixRoom, event: MediationLlmResponse
    ) -> None:
        pass

    async def on_tool_call_report(
        self, room: MatrixRoom, event: ToolCallReport
    ) -> None:
        pass

    async def on_llm_call_report(self, room: MatrixRoom, event: LlmCallReport) -> None:
        pass

    async def on_task_delegate(self, room: MatrixRoom, event: TaskDelegate) -> None:
        pass

    async def on_task_accept(self, room: MatrixRoom, event: TaskAccept) -> None:
        pass

    async def on_task_update(self, room: MatrixRoom, event: TaskUpdate) -> None:
        pass

    async def on_task_finalise(self, room: MatrixRoom, event: TaskFinalise) -> None:
        pass

    async def on_task_cancel(self, room: MatrixRoom, event: TaskCancel) -> None:
        pass

    async def on_agent_runtime_state(
        self, room: MatrixRoom, event: AgentRuntimeStateEvent
    ) -> None:
        pass

    async def on_permission_request(
        self, room: MatrixRoom, event: PermissionRequest
    ) -> None:
        pass

    async def on_permission_response(
        self, room: MatrixRoom, event: PermissionResponse
    ) -> None:
        pass

    async def on_resource_load_request(
        self, room: MatrixRoom, event: ResourceLoadRequest
    ) -> None:
        pass

    async def on_room_document_create_request(
        self, room: MatrixRoom, event: RoomDocumentCreateRequest
    ) -> None:
        pass

    async def on_room_document_create_response(
        self, room: MatrixRoom, event: RoomDocumentCreateResponse
    ) -> None:
        pass

    async def on_room_document_update_request(
        self, room: MatrixRoom, event: RoomDocumentUpdateRequest
    ) -> None:
        pass

    async def on_room_document_update_response(
        self, room: MatrixRoom, event: RoomDocumentUpdateResponse
    ) -> None:
        pass

    async def on_room_document_delete_request(
        self, room: MatrixRoom, event: RoomDocumentDeleteRequest
    ) -> None:
        pass

    async def on_room_document_delete_response(
        self, room: MatrixRoom, event: RoomDocumentDeleteResponse
    ) -> None:
        pass

    async def on_resource_load_response(
        self, room: MatrixRoom, event: ResourceLoadResponse
    ) -> None:
        pass

    # ── Message sending ────────────────────────────────────────────────────────

    async def send_message(
        self,
        room_id: str,
        body: str,
        *,
        format: Literal["text", "markdown"] = "text",
        mentions: list[str] | None = None,
        thread_root_id: str | None = None,
        extra_content: dict[str, object] | None = None,
    ) -> str | None:
        content: dict[str, object] = {
            "msgtype": "m.text",
            "body": body,
            "sender_name": self.display_name,
        }
        # Caller-supplied content fields (e.g. a `com.switch.*` marker) are
        # merged in. They ride on the plain m.room.message — the body still
        # renders normally; the extra keys are metadata other clients can read.
        if extra_content:
            content.update(extra_content)

        if format == "markdown":
            html = markdown.markdown(body)
            if mentions:
                for user_id in mentions:
                    local = user_id.split(":")[0].lstrip("@")
                    pill = f'<a href="https://matrix.to/#/{user_id}">{local}</a>'
                    html = html.replace(f"@{local}", pill)
            content["format"] = "org.matrix.custom.html"
            content["formatted_body"] = html

        # Threaded reply: relate this message to the thread root via a pure
        # m.thread relation (no m.in_reply_to fallback). The root id must be an
        # actual thread root — callers normalise mid-thread ids upstream.
        if thread_root_id is not None:
            content["m.relates_to"] = {
                "rel_type": "m.thread",
                "event_id": thread_root_id,
            }

        resp = await self.client.room_send(room_id, "m.room.message", content)

        if isinstance(resp, RoomSendError):
            logger.error("Failed to send message to %s: %s", room_id, resp.message)
            return None

        return resp.event_id  # type: ignore[no-any-return]

    async def upload_media(self, data: bytes, content_type: str, filename: str) -> str:
        """Upload bytes to the Matrix media repository and return the mxc URI.

        Raises on failure — a media upload that silently returns None would
        produce a broken event referencing nothing.
        """
        resp, _ = await self.client.upload(
            data_provider=io.BytesIO(data),
            content_type=content_type,
            filename=filename,
            filesize=len(data),
        )
        if isinstance(resp, UploadError):
            raise RuntimeError(
                f"Failed to upload media '{filename}' to Matrix: {resp.message}"
            )
        return resp.content_uri  # type: ignore[no-any-return]

    async def send_media(
        self,
        room_id: str,
        mxc: str,
        filename: str,
        mimetype: str,
        size: int,
        *,
        msgtype: str,
        caption: str | None = None,
        thread_root_id: str | None = None,
        group: dict[str, object] | None = None,
    ) -> str | None:
        """Send an m.image / m.file event pointing at an uploaded mxc URI.

        When `caption` is provided it becomes the event `body` (with the real
        filename carried separately in `filename`, per the rich-media-caption
        convention); otherwise `body` is the filename. When `thread_root_id` is
        set the event is related into that thread (mirrors send_message).

        `group` marks this event as one part of a multi-attachment message —
        `{"id": ..., "index": i, "total": n}`. Matrix has no native
        multi-attachment event (MSC4274 / MSC2881 are unmerged), so a message
        carrying several files is sent as n events sharing a group id, which
        receivers coalesce back into one logical message. Absent the field, an
        event is simply a group of one.
        """
        content: dict[str, object] = {
            "msgtype": msgtype,
            "body": caption if caption else filename,
            "url": mxc,
            "info": {"mimetype": mimetype, "size": size},
            "sender_name": self.display_name,
        }
        if caption:
            content["filename"] = filename
        if group is not None:
            content[ATTACHMENT_GROUP_KEY] = group
        if thread_root_id is not None:
            content["m.relates_to"] = {
                "rel_type": "m.thread",
                "event_id": thread_root_id,
            }

        resp = await self.client.room_send(room_id, "m.room.message", content)

        if isinstance(resp, RoomSendError):
            logger.error("Failed to send media to %s: %s", room_id, resp.message)
            return None

        return resp.event_id  # type: ignore[no-any-return]

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        logger.debug(
            "Setting typing %s in room %s for matrix user %s",
            is_typing,
            room_id,
            self.matrix_user_id,
        )
        resp = await self.client.room_typing(room_id, is_typing)
        if isinstance(resp, RoomTypingError):
            logger.error("Failed to set typing in %s: %s", room_id, resp.message)

    # ── Room operations ────────────────────────────────────────────────────────

    async def join_room(self, room_id: str) -> None:
        resp = await self.client.join(room_id)
        if hasattr(resp, "room_id"):
            self._mark_joined(room_id, int(time.time() * 1000))
            logger.info("Client %s joined %s", self.matrix_user_id, room_id)
        else:
            logger.error(
                "Client %s failed to join %s: %s", self.matrix_user_id, room_id, resp
            )

    # ── State persistence ──────────────────────────────────────────────────────

    async def _persist_state(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_sync_persist) < SYNC_STATE_INTERVAL:
            self._sync_state_dirty = True
            return

        try:
            async with self.session_factory() as session:
                await self.client_store.update_state(
                    session,
                    self.client_id,
                    access_token=self.access_token,
                    device_id=self.device_id,
                    next_batch_token=self.next_batch_token,
                )
                await session.commit()
            self._last_sync_persist = now
            self._sync_state_dirty = False
        except Exception:
            logger.exception("Failed to persist state for %s", self.matrix_user_id)
