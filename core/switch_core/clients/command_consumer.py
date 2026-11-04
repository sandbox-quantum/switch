from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Literal

from switch_core.bridges.agent.commands import dispatch_admin_command
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import (
    AdminMessageType,
    admin_extra_content,
)
from switch_core.clients.agent_admin import AgentAdministration, AgentDeletionRequests
from switch_core.clients.consumer import Consumer
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.events import COMMAND_EVENT_TYPE, CommandEvent
from switch_core.transport import RoomRef

if TYPE_CHECKING:
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

# How long a `!delete-agent` waits for its confirmation.
DELETE_CONFIRM_SECONDS = 120.0


class CommandConsumer(Consumer[SystemActor]):
    """Reads every room's commands for Switch itself, and answers through its
    SystemActor.

    Handles the room/info/alias `!` commands (the admin-owned set) and
    renders their results as admin messages. The heads-up for a message that
    tags an agent not in the room, or a role nobody live-holds, is posted by
    the router once the message commits (`clients/mention_warnings.py`), so
    the command rows are all this reads, and it is woken for nothing else.

    Every admin message carries the admin marker so it renders natively per
    bridge and never triggers another member (loop-safe). The system is not an
    agent — it holds no Agent row — so it reasons purely from the stores.
    """

    ROW_TYPES = frozenset({COMMAND_EVENT_TYPE})

    def __init__(
        self,
        *,
        actor: SystemActor,
        agent_store: AgentStore,
        room_store: RoomStore,
        room_role_store: RoomRoleStore,
        external_user_store: ExternalUserStore,
        connections: AgentConnectionRegistry,
        document_store: DocumentStore,
        reference_store: ReferenceStore,
        agent_session_store: AgentSessionStore,
        room_service: RoomService,
        user_store: UserStore,
        agent_admin: AgentAdministration,
        deletion_requests: AgentDeletionRequests,
        frontend_base_url: str | None,
        follow_the_conversation_enabled: bool,
    ) -> None:
        super().__init__(actor=actor)
        self._agent_store = agent_store
        self._room_store = room_store
        self._room_role_store = room_role_store
        self._external_user_store = external_user_store
        self._connections = connections
        self._document_store = document_store
        self._reference_store = reference_store
        self._agent_session_store = agent_session_store
        self._room_service = room_service
        self._user_store = user_store
        self._agent_admin = agent_admin
        self._deletion_requests = deletion_requests
        # (room id, sender, agent id) -> when an unconfirmed `!delete-agent`
        # lapses. In memory: a restart drops a pending deletion, which errs on
        # the side of not deleting.
        self._pending_deletes: dict[tuple[str, str, str], float] = {}
        # Whether `!follow-ups` and `!assign-agent` mean anything here: with
        # the feature flag off they say so rather than claim a change.
        self._follow_the_conversation_enabled = follow_the_conversation_enabled
        self._frontend_base_url = (
            frontend_base_url.rstrip("/") if frontend_base_url else None
        )
        # transport_room_id -> RoomMeta (None when no Switch room maps).
        self._room_meta_cache: dict[str, RoomMeta | None] = {}

    # ── Event hooks ───────────────────────────────────────────────────────────

    async def on_command(self, room: RoomRef, event: CommandEvent) -> None:
        await dispatch_admin_command(self, room, event)

    def request_delete(self, room_id: str, sender: str, agent_id: str) -> None:
        self._prune_pending_deletes()
        self._pending_deletes[(room_id, sender, agent_id)] = (
            time.monotonic() + DELETE_CONFIRM_SECONDS
        )

    def take_delete_request(self, room_id: str, sender: str, agent_id: str) -> bool:
        """Whether this sender asked to delete this agent here, recently
        enough; the request is used up either way."""
        self._prune_pending_deletes()
        return self._pending_deletes.pop((room_id, sender, agent_id), None) is not None

    def _prune_pending_deletes(self) -> None:
        now = time.monotonic()
        for key, expires in list(self._pending_deletes.items()):
            if expires <= now:
                del self._pending_deletes[key]

    async def reply_command(
        self,
        room_id: str,
        body: str,
        *,
        format: Literal["text", "markdown"] = "markdown",
        thread_root_id: str | None = None,
    ) -> None:
        """Post a command result as an admin/system message (renders natively
        per bridge via the admin rail)."""
        await self.actor.send_message(
            room_id,
            body,
            format=format,
            thread_root_id=thread_root_id,
            extra_content=admin_extra_content(AdminMessageType.COMMAND_RESULT),
            metered=False,
        )

    # ── Helpers ────────────────────────────────────────────────────────────────

    async def _resolve_room_meta(self, transport_room_id: str) -> RoomMeta | None:
        if transport_room_id in self._room_meta_cache:
            return self._room_meta_cache[transport_room_id]
        async with tenant_session(self.session_factory, self.tenant_id) as session:
            room = await self._room_store.get_by_transport_room_id(
                session, transport_room_id
            )
        if room is None:
            logger.error("Room not found for transport room id: %s", transport_room_id)
            self._room_meta_cache[transport_room_id] = None
            return None
        meta = RoomMeta(
            room_id=room.id,
            name=room.name,
            bridge_id=room.bridge_id,
            channel_type=room.channel_type,
        )
        self._room_meta_cache[transport_room_id] = meta
        return meta

    async def _is_direct_room(self, transport_room_id: str) -> bool:
        meta = await self._resolve_room_meta(transport_room_id)
        return meta is not None and meta.channel_type == "direct"
