"""A gateway user in Switch rooms as themselves: membership, chats and sends.

Membership is the only read authority. A person sees a room when their
`member` client has a `client_rooms` row for it and they still hold a role in
the tenant; a room's visibility and any claimed platform account do not count.
Membership is granted by creating a chat, by a room manager (the room's owner
or a tenant admin) adding a tenant member, or by a manager adding themselves.
With the `agent_chats` feature flag on, it is also granted to a person in each
chat they started that holds an agent they own, for as long as it does:
`sync_owned_rooms` puts them in and takes back what was held only for that.
Other people's chats and rooms set up elsewhere never gain an agent's owner.

Requests a person may retry carry a request id, recorded in `chat_operations`
per user. The same id with the same payload answers what the first attempt
did; with a different payload it is refused.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid
import weakref
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

import markdown
from sqlalchemy import (
    ColumnElement,
    and_,
    delete,
    exists,
    false,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import allows_on_behalf_of, parse_policy
from switch_core.authz import administers_tenant
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.registration_bootstrap import is_bootstrap_owner
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.chats.views import (
    COMMAND_EVENT_TYPE,
    MESSAGE_EVENT_TYPE,
    SHOWN_EVENT_TYPES,
    ChatMention,
)
from switch_core.clients.mentions import mention_regex, strip_emphasis
from switch_core.db.models import (
    Agent,
    AgentSessionActivityItem,
    ApprovalRequest,
    ChatHidden,
    ChatOperation,
    ChatOwnerGrant,
    ChatRead,
    Client,
    ClientRoom,
    MediaBlob,
    Message,
    MessageAttachment,
    Room,
    TenantMember,
    UsageMetric,
    User,
    require_tenant_id,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_activity_store import (
    RETRYABLE_TURN_STATUSES,
    AgentSessionActivityStore,
    ApprovalRequestStore,
)
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.delivery.addressing import MENTIONS_KEY, AddressingResolver
from switch_core.messages.notify import MessageListener
from switch_core.messages.row import attachments_in, message_row, new_event_id
from switch_core.observability.catalogue import MESSAGES_SENT
from switch_core.observability.metrics import metrics
from switch_core.provisioning import Provisioning
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.session_activity.listener import AgentSessionActivityListener
from switch_core.session_activity.maintenance import ACTIVITY_RETENTION
from switch_core.sessions.attachments import normalise_mime_type
from switch_core.tenant_context import tenant_scope
from switch_core.transport.content import media_content, message_content
from switch_core.transport.types import MessageFormat

if TYPE_CHECKING:
    from switch_core.chats.signals import ChatSignals
    from switch_core.delivery.router import MessageRouter, Routed

logger = logging.getLogger(__name__)

# Told the rooms whose part in a person's chats changed, or None for any.
MembershipWatcher = Callable[[list[str] | None], None]

# Fixed so the ids derived from it are stable across processes and releases.
_CHATS_NAMESPACE = uuid.UUID("6f1d3c2e-8a4b-4f5e-9c7d-2b1a0e9f8d7c")


class ChatError(Exception):
    """A refusal the gateway reports as `{"detail": {"code", "message"}}`."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class StagedUpload:
    upload_id: str
    uri: str
    filename: str
    mimetype: str
    size: int


RemovalReason = Literal["access", "unlisted"]

# Long enough for a welcome with tips; a greeting is not a document.
GREETING_MAX_CHARS = 4000
RoomControl = Literal["interrupt", "reset", "compact", "retry"]


def _hash(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _upload_key(upload_id: str) -> str:
    # Uploads share the per-user key space with requests; the prefix keeps a
    # client's upload id from ever colliding with one of its request ids.
    return f"upload:{upload_id}"


class ChatService:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        room_service: RoomService,
        provisioning: Provisioning,
        listener: MessageListener,
        activity_listener: AgentSessionActivityListener,
        room_store: RoomStore,
        agent_store: AgentStore,
        user_store: UserStore,
        message_store: MessageStore,
        router: MessageRouter,
        media_store: MediaStore,
        usage_store: UsageStore,
        id_server_name: str,
        media_max_bytes: int,
        agent_chats_enabled: bool,
        group_chats_enabled: bool,
        connections: AgentConnectionRegistry,
    ) -> None:
        self.session_factory = session_factory
        self._connections = connections
        self.agent_chats_enabled = agent_chats_enabled
        self.group_chats_enabled = group_chats_enabled
        self.listener = listener
        self.activity_listener = activity_listener
        self._activity_store = AgentSessionActivityStore()
        self._approval_store = ApprovalRequestStore()
        self._room_service = room_service
        self._provisioning = provisioning
        self._room_store = room_store
        self._agent_store = agent_store
        self._user_store = user_store
        self._message_store = message_store
        self._router = router
        self._media_store = media_store
        self._usage_store = usage_store
        self._id_server_name = id_server_name
        self._media_max_bytes = media_max_bytes
        self._locks: weakref.WeakValueDictionary[tuple[str, ...], asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._membership_watchers: dict[tuple[str, str], set[MembershipWatcher]] = {}
        self._agent_room_listeners: tuple[Callable[[str, list[str]], None], ...] = ()
        self._tasks: set[asyncio.Task[None]] = set()
        # Where a change to people's chats made here is announced to the
        # other processes, once wired (`use_signals`).
        self._signals: ChatSignals | None = None
        self._addressing = AddressingResolver(
            room_store=room_store,
            room_role_store=RoomRoleStore(),
            client_store=ClientStore(),
            agent_store=agent_store,
            external_user_store=ExternalUserStore(),
            # Only role mentions consult liveness; a permission check never does.
            live_connection_ids=set,
        )

    # ── Membership signals ───────────────────────────────────────────────────

    def use_signals(self, signals: ChatSignals) -> None:
        """Where a change to people's chats made here is announced, so every
        other process wakes the streams it holds for them (`signals.py`)."""
        self._signals = signals

    def watch_memberships(
        self, tenant_id: str, user_id: str, callback: MembershipWatcher
    ) -> None:
        """Call `callback` whenever the user's chats change: at once when this
        process changed them, and once told when another process did. It is
        given the rooms that changed, or None when any may have."""
        self._membership_watchers.setdefault((tenant_id, user_id), set()).add(callback)

    def unwatch_memberships(
        self, tenant_id: str, user_id: str, callback: MembershipWatcher
    ) -> None:
        watchers = self._membership_watchers.get((tenant_id, user_id))
        if watchers is None:
            return
        watchers.discard(callback)
        if not watchers:
            del self._membership_watchers[(tenant_id, user_id)]

    def wake_membership_watchers(
        self, tenant_id: str, user_ids: list[str], room_ids: list[str] | None
    ) -> None:
        """Call every callback watching these users' chats in this process,
        with the rooms that changed (None: any)."""
        for user_id in user_ids:
            for callback in list(
                self._membership_watchers.get((tenant_id, user_id), ())
            ):
                callback(room_ids)

    def wake_all_membership_watchers(self) -> None:
        """Call every callback watching anyone's chats in this process, once,
        with any room in question."""
        for watchers in list(self._membership_watchers.values()):
            for callback in list(watchers):
                callback(None)

    def _memberships_changed(
        self, tenant_id: str, user_ids: list[str], room_ids: list[str]
    ) -> None:
        """The users' part in chats `room_ids` changed through this process
        (joined, left, or what their summaries show), and the change has
        committed: the streams here are woken at once, and the other
        processes are told to wake theirs. A stream re-reads which chats its
        person has on every wake, and re-summarises only these."""
        self.wake_membership_watchers(tenant_id, user_ids, room_ids)
        if self._signals is not None:
            self._signals.memberships_changed(tenant_id, user_ids, room_ids)

    def _require_group_chats(self) -> None:
        """Refuse a group-only request while `group_chats` is off, so a fleet
        that turned it off (or never on) says so rather than half-serving it."""
        if not self.group_chats_enabled:
            raise ChatError(
                409, "GROUP_CHATS_OFF", "Group chats are not turned on for this server."
            )

    def _lock(self, *key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    # ── Identity and access ──────────────────────────────────────────────────

    async def member_client(self, session: AsyncSession, user_id: str) -> Client | None:
        return (
            await session.execute(
                select(Client).where(
                    Client.tenant_id == require_tenant_id(),
                    Client.user_id == user_id,
                    Client.type == MEMBER_CLIENT_TYPE,
                )
            )
        ).scalar_one_or_none()

    async def member_actor(self, tenant_id: str, user: User) -> Client:
        """The user's member client in the tenant, created on first use."""
        async with self._lock("member", tenant_id, user.id):
            async with tenant_session(self.session_factory, tenant_id) as session:
                client = await self.member_client(session, user.id)
                if client is not None:
                    return client
                # Another process may be creating the same one: the first
                # insert wins, and this one reads what it wrote.
                created = await session.scalar(
                    pg_insert(Client)
                    .values(
                        id=str(uuid.uuid4()),
                        tenant_id=tenant_id,
                        transport_user_id=f"@switch-member-{user.id}:{self._id_server_name}",
                        display_name=user.name,
                        type=MEMBER_CLIENT_TYPE,
                        user_id=user.id,
                    )
                    .on_conflict_do_nothing()
                    .returning(Client.id)
                )
                await session.commit()
                if created is not None:
                    logger.info(
                        "Created member client %s for user %s", created, user.id
                    )
                client = await self.member_client(session, user.id)
                if client is None:
                    raise RuntimeError(
                        f"No member client for user {user.id} after creating one"
                    )
                return client

    async def has_tenant_role(
        self, session: AsyncSession, tenant_id: str, user_id: str
    ) -> bool:
        return (
            await self._user_store.tenant_role(session, tenant_id, user_id) is not None
        )

    async def _room(self, session: AsyncSession, tenant_id: str, room_id: str) -> Room:
        room = await self._room_store.get(session, room_id)
        if room is None or room.tenant_id != tenant_id:
            raise ChatError(404, "ROOM_NOT_FOUND", "Room not found.")
        return room

    async def _is_in_room(
        self, session: AsyncSession, client_id: str, room_id: str
    ) -> bool:
        return bool(
            await session.scalar(
                select(
                    exists().where(
                        ClientRoom.client_id == client_id, ClientRoom.room_id == room_id
                    )
                )
            )
        )

    async def require_member(
        self, session: AsyncSession, tenant_id: str, user: User, room_id: str
    ) -> tuple[Room, Client]:
        """The room and the caller's member client, or a refusal.

        Checked on every read and write, and again when a retried request
        resumes, so removal from the room or the tenant takes effect at once.
        """
        room = await self._room(session, tenant_id, room_id)
        refusal = ChatError(403, "NOT_A_MEMBER", "You are not a member of this chat.")
        if not await self.has_tenant_role(session, tenant_id, user.id):
            raise refusal
        client = await self.member_client(session, user.id)
        if client is not None and await self._is_in_room(session, client.id, room.id):
            return room, client
        if room.archived_at is None and await self.joins_as_owner(
            session, user.id, room.id
        ):
            await self.sync_owned_rooms(tenant_id, user.id)
            client = await self.member_client(session, user.id)
            if client is not None and await self._is_in_room(
                session, client.id, room.id
            ):
                return room, client
        raise refusal

    async def can_manage(
        self, session: AsyncSession, tenant_id: str, user: User, room: Room
    ) -> bool:
        if room.owner_id is not None and room.owner_id == user.id:
            return True
        return await self.administers(session, tenant_id, user)

    async def administers(
        self, session: AsyncSession, tenant_id: str, user: User
    ) -> bool:
        """Whether the user manages every room in the tenant (`can_manage`)."""
        role = await self._user_store.tenant_role(session, tenant_id, user.id)
        return administers_tenant(is_operator=user.role == "admin", tenant_role=role)

    async def head_seqs(
        self, session: AsyncSession, room_ids: list[str]
    ) -> dict[str, int]:
        return await self._message_store.head_seqs(session, room_ids)

    async def _require_manager(
        self, session: AsyncSession, tenant_id: str, user: User, room: Room
    ) -> None:
        if not await self.can_manage(session, tenant_id, user, room):
            raise ChatError(
                403,
                "NOT_A_MANAGER",
                "Only the room's owner or a workspace admin can do that.",
            )

    # ── Agent owners ─────────────────────────────────────────────────────────

    async def joins_as_owner(
        self, session: AsyncSession, user_id: str, room_id: str
    ) -> bool:
        """True when `sync_owned_rooms` keeps the user in this room."""
        if not self.agent_chats_enabled:
            return False
        return bool(
            await session.scalar(
                select(exists().where(Room.id == room_id, _owner_joins(user_id)))
            )
        )

    async def sync_owned_rooms(self, tenant_id: str, user_id: str) -> None:
        """Put the user in every live chat they started that holds an agent
        they own, and take back each membership held only for that once it no
        longer satisfies that rule. With `agent_chats` off nothing satisfies
        it: no one joins, and every such membership is taken back.

        Such a membership is marked by a `ChatOwnerGrant`; being invited,
        creating the chat or joining as a manager removes the mark, and the
        membership then stays when the agent goes. Cheap when nothing changed:
        two queries.
        """
        kept = _owner_joins(user_id) if self.agent_chats_enabled else false()
        async with self._lock("owned", tenant_id, user_id):
            async with tenant_session(self.session_factory, tenant_id) as session:
                if not await self.has_tenant_role(session, tenant_id, user_id):
                    return
                client = await self.member_client(session, user_id)
                joined: ColumnElement[bool] = (
                    exists().where(
                        ClientRoom.client_id == client.id,
                        ClientRoom.room_id == Room.id,
                    )
                    if client is not None
                    else false()
                )
                to_join = list(
                    (
                        await session.execute(
                            select(Room)
                            .where(
                                Room.tenant_id == tenant_id,
                                Room.archived_at.is_(None),
                                kept,
                                ~joined,
                            )
                            .order_by(Room.created_at)
                        )
                    )
                    .scalars()
                    .all()
                )
                to_drop = list(
                    (
                        await session.execute(
                            select(Room)
                            .join(ChatOwnerGrant, ChatOwnerGrant.room_id == Room.id)
                            .where(
                                ChatOwnerGrant.user_id == user_id,
                                # A room with no creator makes `kept` NULL, not false.
                                ~func.coalesce(kept, false()),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if not to_join and not to_drop:
                    return
                user = await self._user_store.get(session, user_id)
                assert user is not None
                if to_join:
                    # Marked before joining: a join cut short leaves a mark
                    # the next pass completes or clears, never a membership
                    # that would outlive the agent unmarked.
                    await session.execute(
                        pg_insert(ChatOwnerGrant)
                        .values(
                            [
                                {
                                    "tenant_id": tenant_id,
                                    "user_id": user_id,
                                    "room_id": room.id,
                                }
                                for room in to_join
                            ]
                        )
                        .on_conflict_do_nothing(
                            index_elements=["tenant_id", "user_id", "room_id"]
                        )
                    )
                    await session.commit()
            if client is None:
                client = await self.member_actor(tenant_id, user)
            for room in to_join:
                await self._join(tenant_id, room, client)
            for room in to_drop:
                with tenant_scope(tenant_id):
                    await self._provisioning.kick_user(
                        room.transport_room_id, client.transport_user_id
                    )
            if to_drop:
                async with tenant_session(self.session_factory, tenant_id) as session:
                    await session.execute(
                        delete(ChatOwnerGrant).where(
                            ChatOwnerGrant.user_id == user_id,
                            ChatOwnerGrant.room_id.in_([room.id for room in to_drop]),
                        )
                    )
                    await session.commit()
            logger.info(
                "Agent owner %s: joined %d room(s), left %d",
                user_id,
                len(to_join),
                len(to_drop),
            )
        self._memberships_changed(
            tenant_id, [user_id], [room.id for room in [*to_join, *to_drop]]
        )

    async def sync_room(self, tenant_id: str, room_id: str) -> None:
        """`sync_owned_rooms` for everyone a change to this room's agents may
        concern: the owners of its agents and the holders of owner grants.
        The room's other members are told too, as gaining or losing its
        agents can move it into or out of their list. Does nothing with
        `agent_chats` off."""
        if not self.agent_chats_enabled:
            return
        async with tenant_session(self.session_factory, tenant_id) as session:
            owners = set(
                (
                    await session.execute(
                        select(Agent.owner_id)
                        .join(room_agents, room_agents.c.agent_id == Agent.id)
                        .where(
                            room_agents.c.room_id == room_id,
                            Agent.owner_id.is_not(None),
                        )
                    )
                ).scalars()
            )
            holders = set(
                (
                    await session.execute(
                        select(ChatOwnerGrant.user_id).where(
                            ChatOwnerGrant.room_id == room_id
                        )
                    )
                ).scalars()
            )
            members = set(
                (
                    await session.execute(
                        select(Client.user_id)
                        .join(ClientRoom, ClientRoom.client_id == Client.id)
                        .where(
                            ClientRoom.room_id == room_id,
                            Client.type == MEMBER_CLIENT_TYPE,
                            Client.user_id.is_not(None),
                        )
                    )
                ).scalars()
            )
        for user_id in sorted(
            user_id for user_id in owners | holders if user_id is not None
        ):
            await self.sync_owned_rooms(tenant_id, user_id)
        self._memberships_changed(
            tenant_id,
            sorted(user_id for user_id in members if user_id is not None),
            [room_id],
        )

    def on_agent_room_changed(self, listener: Callable[[str, list[str]], None]) -> None:
        """Call `listener(tenant_id, room_ids)` with every room an agent is in
        when its name, display name or icon changes (`room_changes`), so
        whoever shows those rooms reads them again. It must not block."""
        self._agent_room_listeners = (*self._agent_room_listeners, listener)

    def room_changed(self, tenant_id: str, room_id: str, client_ids: list[str]) -> None:
        """A room's own details changed (its name, say): wake the streams of
        the people in it, from a task of its own, so they re-send its summary."""
        task = asyncio.create_task(self._room_details_changed(tenant_id, room_id))
        self._tasks.add(task)
        task.add_done_callback(self._task_done)

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "Could not wake the streams of a changed room's people; they "
                "re-read it on their next recheck",
                exc_info=task.exception(),
            )

    async def _room_details_changed(self, tenant_id: str, room_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            user_ids = (
                await session.execute(
                    select(Client.user_id)
                    .join(ClientRoom, ClientRoom.client_id == Client.id)
                    .where(
                        ClientRoom.room_id == room_id,
                        Client.type == MEMBER_CLIENT_TYPE,
                        Client.user_id.is_not(None),
                    )
                )
            ).scalars()
            members = sorted(user_id for user_id in user_ids if user_id is not None)
        self._memberships_changed(tenant_id, members, [room_id])

    async def agent_changed(self, tenant_id: str, agent_id: str) -> None:
        """Tell everyone who sees a room with this agent that it changed, and
        with `agent_chats` on, wake the streams of everyone in a chat with it
        so they re-send its summaries."""
        async with tenant_session(self.session_factory, tenant_id) as session:
            room_ids = list(
                (
                    await session.execute(
                        select(room_agents.c.room_id).where(
                            room_agents.c.agent_id == agent_id
                        )
                    )
                ).scalars()
            )
        for listener in self._agent_room_listeners:
            try:
                listener(tenant_id, room_ids)
            except Exception:
                logger.exception("Agent room listener failed for agent %s", agent_id)
        if not self.agent_chats_enabled:
            return
        async with tenant_session(self.session_factory, tenant_id) as session:
            members = (
                await session.execute(
                    select(Client.user_id)
                    .distinct()
                    .join(ClientRoom, ClientRoom.client_id == Client.id)
                    .join(room_agents, room_agents.c.room_id == ClientRoom.room_id)
                    .where(
                        room_agents.c.agent_id == agent_id,
                        Client.type == MEMBER_CLIENT_TYPE,
                        Client.user_id.is_not(None),
                    )
                )
            ).scalars()
            user_ids = sorted(user_id for user_id in members if user_id is not None)
        self._memberships_changed(tenant_id, user_ids, room_ids)

    async def _make_lasting(self, tenant_id: str, user_id: str, room_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            await session.execute(
                delete(ChatOwnerGrant).where(
                    ChatOwnerGrant.user_id == user_id, ChatOwnerGrant.room_id == room_id
                )
            )
            await session.commit()

    # ── Listing ──────────────────────────────────────────────────────────────

    async def readable_rooms(self, session: AsyncSession, user_id: str) -> list[Room]:
        """All rooms the caller can read: member of, unarchived, tenant role."""
        client = await self.member_client(session, user_id)
        if client is None:
            return []
        result = await session.execute(
            select(Room)
            .join(ClientRoom, ClientRoom.room_id == Room.id)
            .where(
                ClientRoom.client_id == client.id,
                Room.archived_at.is_(None),
            )
            .order_by(Room.created_at)
        )
        return list(result.scalars().all())

    async def stream_rooms(self, session: AsyncSession, user_id: str) -> list[Room]:
        """The caller's member rooms that are chats: unarchived, and either
        holding an agent or started in Switch Console (which may have none)."""
        return [
            room
            for room, listed in await self.readable_and_listed(session, user_id)
            if listed
        ]

    async def readable_and_listed(
        self, session: AsyncSession, user_id: str
    ) -> list[tuple[Room, bool]]:
        """The caller's member rooms, archived ones included, each with whether
        it is one of `stream_rooms`, in one query."""
        return [
            (room, is_chat and room.archived_at is None)
            for room, is_chat in await self._member_rooms(session, user_id)
        ]

    async def archived_chats(self, session: AsyncSession, user_id: str) -> list[Room]:
        """The caller's member rooms that would be in `stream_rooms` but for
        being archived."""
        return [
            room
            for room, is_chat in await self._member_rooms(session, user_id)
            if is_chat and room.archived_at is not None
        ]

    async def _member_rooms(
        self, session: AsyncSession, user_id: str
    ) -> list[tuple[Room, bool]]:
        """Every room the caller's member client is in, each with whether it
        is a chat: holding an agent or started in Switch Console."""
        client = await self.member_client(session, user_id)
        if client is None:
            return []
        is_chat = or_(
            exists().where(room_agents.c.room_id == Room.id),
            Room.metadata_.has_key("chat_operation_id"),
        )
        result = await session.execute(
            select(Room, is_chat)
            .join(ClientRoom, ClientRoom.room_id == Room.id)
            .where(ClientRoom.client_id == client.id)
            .order_by(Room.created_at)
        )
        return [(room, bool(chat)) for room, chat in result.all()]

    async def moved_rooms(
        self, session: AsyncSession, cursors: dict[str, int]
    ) -> set[str]:
        """Of the rooms in `cursors`, those with a row past their cursor."""
        return await self._message_store.rooms_past(session, cursors)

    async def room_activity(
        self, session: AsyncSession, room_id: str
    ) -> tuple[list[AgentSessionActivityItem], list[ApprovalRequest]]:
        """The room's turn steps and approval requests (every state) within retention."""
        since = datetime.now(UTC) - ACTIVITY_RETENTION
        return (
            await self._activity_store.for_room(session, room_id, since),
            await self._approval_store.for_room(session, room_id, since),
        )

    async def turn_items(
        self, session: AsyncSession, agent_id: str, session_id: str, turn_id: str
    ) -> list[AgentSessionActivityItem]:
        return await self._activity_store.turn(session, agent_id, session_id, turn_id)

    async def turn_item(
        self,
        session: AsyncSession,
        agent_id: str,
        session_id: str,
        turn_id: str,
        item_id: str,
    ) -> AgentSessionActivityItem | None:
        return await session.get(
            AgentSessionActivityItem,
            (require_tenant_id(), agent_id, session_id, turn_id, item_id),
        )

    async def reads_room(
        self, session: AsyncSession, tenant_id: str, user_id: str, room_id: str | None
    ) -> tuple[bool, bool]:
        """Whether the user still holds a role in the tenant, and whether they
        may read `room_id` now (`readable_rooms`, for that one room), in one
        query. A step outside any room is read by nobody here."""
        member = exists().where(
            TenantMember.tenant_id == tenant_id, TenantMember.user_id == user_id
        )
        reads = (
            exists().where(
                ClientRoom.room_id == room_id,
                ClientRoom.client_id == Client.id,
                Client.user_id == user_id,
                Client.type == MEMBER_CLIENT_TYPE,
                Room.id == room_id,
                Room.archived_at.is_(None),
            )
            if room_id is not None
            else false()
        )
        row = (await session.execute(select(member, reads))).one()
        return bool(row[0]), bool(row[0] and row[1])

    async def approval(
        self, session: AsyncSession, agent_id: str, session_id: str, request_id: str
    ) -> ApprovalRequest | None:
        return await self._approval_store.get(
            session, agent_id, session_id, request_id, for_update=False
        )

    async def removal_reason(
        self, session: AsyncSession, user_id: str, room_id: str
    ) -> RemovalReason:
        """Why a room left `stream_rooms`: the caller lost it ("access") or is
        still a member of a live room that no longer qualifies ("unlisted")."""
        room = await self._room_store.get(session, room_id)
        if room is None or room.archived_at is not None:
            return "access"
        client = await self.member_client(session, user_id)
        if client is None or not await self._is_in_room(session, client.id, room_id):
            return "access"
        return "unlisted"

    async def list_chats(self, session: AsyncSession, user_id: str) -> list[Room]:
        """`stream_rooms` less the ones the caller hid with nothing said since."""
        rooms = await self.stream_rooms(session, user_id)
        hidden = {
            row.room_id: row.hidden_through_seq
            for row in (
                await session.execute(
                    select(ChatHidden).where(ChatHidden.user_id == user_id)
                )
            ).scalars()
        }
        shown: list[Room] = []
        for room in rooms:
            through = hidden.get(room.id)
            if (
                through is not None
                and await self._last_message_seq(session, room.id) <= through
            ):
                continue
            shown.append(room)
        return shown

    async def _last_message_seq(self, session: AsyncSession, room_id: str) -> int:
        seq = await session.scalar(
            select(Message.seq)
            .where(
                Message.room_id == room_id, Message.event_type.in_(SHOWN_EVENT_TYPES)
            )
            .order_by(Message.seq.desc())
            .limit(1)
        )
        return seq if seq is not None else 0

    async def page(
        self, session: AsyncSession, room_id: str, before_seq: int | None, limit: int
    ) -> tuple[list[Message], int, bool]:
        """Messages before `before_seq` (newest first, returned oldest first),
        the room's head position, and whether older messages remain."""
        return await self._paged(
            session, room_id, Message.room_id == room_id, before_seq, limit
        )

    async def _paged(
        self,
        session: AsyncSession,
        room_id: str,
        where: ColumnElement[bool],
        before_seq: int | None,
        limit: int,
    ) -> tuple[list[Message], int, bool]:
        query = select(Message).where(where, Message.event_type.in_(SHOWN_EVENT_TYPES))
        if before_seq is not None:
            query = query.where(Message.seq < before_seq)
        rows = list(
            (await session.execute(query.order_by(Message.seq.desc()).limit(limit + 1)))
            .scalars()
            .all()
        )
        has_more = len(rows) > limit
        rows = rows[:limit]
        rows.reverse()
        return rows, await self._message_store.head_seq(session, room_id), has_more

    async def thread_page(
        self,
        session: AsyncSession,
        room: Room,
        root_id: str,
        before_seq: int | None,
        limit: int,
    ) -> tuple[list[Message], int, bool]:
        """`page` for the replies in one thread of this room, the root not
        among them. A reply's id names its thread's root."""
        found = await self._message_store.list_by_transport_event_ids(
            session, room.id, [root_id]
        )
        if not found:
            raise ChatError(
                404, "THREAD_NOT_FOUND", "That message is not in this chat."
            )
        root = found[0].thread_root_event_id or found[0].transport_event_id
        return await self._paged(
            session,
            room.id,
            and_(Message.room_id == room.id, Message.thread_root_event_id == root),
            before_seq,
            limit,
        )

    async def read_position(
        self, session: AsyncSession, user_id: str, room_id: str
    ) -> int:
        """How far the user has read the room (set to its head as they joined),
        or its head when nothing is recorded."""
        seq = await session.scalar(
            select(ChatRead.read_through_seq).where(
                ChatRead.user_id == user_id, ChatRead.room_id == room_id
            )
        )
        return seq if seq is not None else await self.head_seq(session, room_id)

    async def head_seq(self, session: AsyncSession, room_id: str) -> int:
        return await self._message_store.head_seq(session, room_id)

    async def messages_after(
        self, session: AsyncSession, room_id: str, after_seq: int, limit: int
    ) -> list[Message]:
        """Every row after `after_seq`, conversation or not, oldest first."""
        return await self._message_store.list_for_room(
            session, room_id, after_seq=after_seq, limit=limit
        )

    async def members(
        self, session: AsyncSession, room: Room
    ) -> list[tuple[User, bool]]:
        result = await session.execute(
            select(User)
            .join(Client, Client.user_id == User.id)
            .join(ClientRoom, ClientRoom.client_id == Client.id)
            .where(
                ClientRoom.room_id == room.id,
                Client.type == MEMBER_CLIENT_TYPE,
                Client.tenant_id == room.tenant_id,
            )
            .order_by(User.name)
        )
        return [(user, user.id == room.owner_id) for user in result.scalars().all()]

    async def media(self, session: AsyncSession, room: Room, uri: str) -> MediaBlob:
        """The bytes behind `uri`, only when a message in this room carries it."""
        carried = await session.scalar(
            select(
                exists().where(
                    MessageAttachment.uri == uri,
                    MessageAttachment.message_id == Message.id,
                    Message.room_id == room.id,
                )
            )
        )
        blob = await self._media_store.get(session, uri) if carried else None
        if blob is None:
            raise ChatError(404, "MEDIA_NOT_FOUND", "No such file in this chat.")
        return blob

    # ── Joining and leaving ──────────────────────────────────────────────────

    async def _join(self, tenant_id: str, room: Room, client: Client) -> None:
        """Put the member client in the room; already in is success."""
        with tenant_scope(tenant_id):
            await self._provisioning.invite_to_room(
                room.transport_room_id, client.transport_user_id
            )

    async def _require_tenant_member(
        self, session: AsyncSession, tenant_id: str, user_id: str
    ) -> User:
        user = await self._user_store.get(session, user_id)
        if user is None or not await self.has_tenant_role(session, tenant_id, user_id):
            raise ChatError(
                422,
                "NOT_A_TENANT_MEMBER",
                "That person is not a member of this workspace.",
            )
        if is_bootstrap_owner(user):
            raise ChatError(422, "NOT_A_PERSON", "That account can't join chats.")
        return user

    async def _make_group(self, session: AsyncSession, room: Room) -> None:
        """Turn a Switch Console direct chat into a group, for good.

        Written in the transaction that adds the person or agent, with the
        room row locked, so no message routes as direct once the room has
        them and a failed add leaves the chat as it was. A bridged room's
        type is its platform's and is never touched.
        """
        if room.channel_type != "direct" or "chat_operation_id" not in (
            room.metadata_ or {}
        ):
            return
        await session.execute(
            update(Room)
            .where(Room.id == room.id, Room.channel_type == "direct")
            .values(channel_type="channel_private")
        )
        room.channel_type = "channel_private"

    async def add_member(
        self, tenant_id: str, actor: User, room_id: str, target_user_id: str
    ) -> Room:
        async with tenant_session(self.session_factory, tenant_id) as session:
            room = await self._room(session, tenant_id, room_id)
            await self._require_manager(session, tenant_id, actor, room)
            target = await self._require_tenant_member(
                session, tenant_id, target_user_id
            )
        client = await self.member_actor(tenant_id, target)
        async with tenant_session(self.session_factory, tenant_id) as session:
            room = await self._locked_room(session, room.id)
            # The creator is the direct chat's own person; anyone else makes a group.
            if target_user_id not in (room.created_by, room.owner_id):
                await self._make_group(session, room)
            with tenant_scope(tenant_id):
                joined = await self._provisioning.record_join(
                    session, room.transport_room_id, client.transport_user_id
                )
            await self._start_reading(session, room.id, [target_user_id])
            await session.commit()
        joined()
        await self._make_lasting(tenant_id, target_user_id, room.id)
        async with tenant_session(self.session_factory, tenant_id) as session:
            member_ids = [member.id for member, _ in await self.members(session, room)]
        self._memberships_changed(tenant_id, member_ids, [room.id])
        return room

    async def remove_member(
        self, tenant_id: str, actor: User, room_id: str, target_user_id: str
    ) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            if actor.id == target_user_id:
                room, client = await self.require_member(
                    session, tenant_id, actor, room_id
                )
            else:
                room = await self._room(session, tenant_id, room_id)
                await self._require_manager(session, tenant_id, actor, room)
                found = await self.member_client(session, target_user_id)
                if found is None or not await self._is_in_room(
                    session, found.id, room.id
                ):
                    return
                client = found
            if await self.joins_as_owner(session, target_user_id, room.id):
                raise ChatError(
                    409,
                    "AGENT_OWNER",
                    (
                        "You own an agent in this chat, so you stay in it while "
                        "the agent does. You can remove it from your list instead."
                    )
                    if actor.id == target_user_id
                    else (
                        "They own an agent in this chat, so they stay in it "
                        "while the agent does."
                    ),
                )
        with tenant_scope(tenant_id):
            await self._provisioning.kick_user(
                room.transport_room_id, client.transport_user_id
            )
        await self._make_lasting(tenant_id, target_user_id, room.id)
        async with tenant_session(self.session_factory, tenant_id) as session:
            member_ids = [member.id for member, _ in await self.members(session, room)]
        self._memberships_changed(tenant_id, [target_user_id, *member_ids], [room.id])

    async def add_agent(
        self, tenant_id: str, actor: User, room_id: str, agent_id: str
    ) -> Room:
        """Manager only, and only an agent the manager may use in this room.
        Already in is success. A second agent makes a direct chat a group."""
        self._require_group_chats()
        async with tenant_session(self.session_factory, tenant_id) as session:
            room = await self._room(session, tenant_id, room_id)
            await self._require_manager(session, tenant_id, actor, room)
            await self._require_may_use_agent(
                session,
                tenant_id,
                actor,
                agent_id,
                room_id=room.id,
                group_id=room.group_id,
            )
            if agent_id in await self._room_store.get_agent_ids(session, room.id):
                return room
        await self._room_service.add_agents_to_room(
            room.id,
            agent_ids=[agent_id],
            with_agents=lambda session: self._group_if_several_agents(session, room),
        )
        async with tenant_session(self.session_factory, tenant_id) as session:
            return await self._room(session, tenant_id, room_id)

    async def _locked_room(self, session: AsyncSession, room_id: str) -> Room:
        """The room row, locked against another membership change until this
        transaction ends. `FOR NO KEY UPDATE`, which the key-share lock an
        insert referencing the room takes does not conflict with."""
        locked = await session.scalar(
            select(Room)
            .where(Room.id == room_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
        assert locked is not None
        return locked

    async def _group_if_several_agents(self, session: AsyncSession, room: Room) -> None:
        """`_make_group` once the room holds more than one agent, in the
        transaction that added the agent. The room row is locked before counting, so a
        concurrent add counts this one's agent once this one commits."""
        locked = await self._locked_room(session, room.id)
        if len(await self._room_store.get_agent_ids(session, room.id)) > 1:
            await self._make_group(session, locked)

    async def remove_agent(
        self, tenant_id: str, actor: User, room_id: str, agent_id: str
    ) -> None:
        """Manager only, with no check on using the agent, so an unwanted
        agent can always be taken out. Already gone is success."""
        self._require_group_chats()
        async with tenant_session(self.session_factory, tenant_id) as session:
            room = await self._room(session, tenant_id, room_id)
            await self._require_manager(session, tenant_id, actor, room)
            if agent_id not in await self._room_store.get_agent_ids(session, room.id):
                return
        await self._room_service.remove_agents_from_room(room.id, [agent_id])

    async def archive(self, tenant_id: str, user: User, room_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, _ = await self.require_member(session, tenant_id, user, room_id)
            await self._require_manager(session, tenant_id, user, room)
            member_ids = [member.id for member, _ in await self.members(session, room)]
        await self._room_service.set_room_archived(room.id, True)
        self._memberships_changed(tenant_id, member_ids, [room.id])

    async def unarchive(self, tenant_id: str, user: User, room_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, _ = await self.require_member(session, tenant_id, user, room_id)
            await self._require_manager(session, tenant_id, user, room)
            member_ids = [member.id for member, _ in await self.members(session, room)]
        await self._room_service.set_room_archived(room.id, False)
        self._memberships_changed(tenant_id, member_ids, [room.id])

    async def _start_reading(
        self, session: AsyncSession, room_id: str, user_ids: list[str]
    ) -> None:
        """Mark the room read up to its head for people joining it, so what
        was said before they arrived is not unread to them."""
        await self._read_through(
            session,
            room_id,
            user_ids,
            await self._message_store.head_seq(session, room_id),
        )

    async def _read_through(
        self, session: AsyncSession, room_id: str, user_ids: list[str], seq: int
    ) -> None:
        if not user_ids:
            return
        insert = pg_insert(ChatRead).values(
            [
                {
                    "tenant_id": require_tenant_id(),
                    "user_id": user_id,
                    "room_id": room_id,
                    "read_through_seq": seq,
                }
                for user_id in user_ids
            ]
        )
        await session.execute(
            insert.on_conflict_do_update(
                index_elements=["tenant_id", "user_id", "room_id"],
                set_={
                    "read_through_seq": func.greatest(
                        ChatRead.read_through_seq, insert.excluded.read_through_seq
                    ),
                    "updated_at": func.now(),
                },
            )
        )

    async def mark_read(
        self, tenant_id: str, user: User, room_id: str, seq: int
    ) -> None:
        """The caller has been shown the room up to `seq`. Never moves their
        place back; a position past the room's head is refused."""
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, _ = await self.require_member(session, tenant_id, user, room_id)
            if seq < 0 or seq > await self._message_store.head_seq(session, room.id):
                raise ChatError(
                    422, "SEQ_OUT_OF_RANGE", "That position is not in this chat."
                )
            await self._read_through(session, room.id, [user.id], seq)
            await session.commit()
        self._memberships_changed(tenant_id, [user.id], [room.id])

    async def set_hidden(
        self, tenant_id: str, user: User, room_id: str, hidden: bool
    ) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, _ = await self.require_member(session, tenant_id, user, room_id)
            if hidden:
                through = await self._message_store.head_seq(session, room.id)
                await session.execute(
                    pg_insert(ChatHidden)
                    .values(
                        tenant_id=tenant_id,
                        user_id=user.id,
                        room_id=room.id,
                        hidden_through_seq=through,
                    )
                    .on_conflict_do_update(
                        index_elements=["tenant_id", "user_id", "room_id"],
                        set_={"hidden_through_seq": through},
                    )
                )
            else:
                await session.execute(
                    delete(ChatHidden).where(
                        ChatHidden.user_id == user.id, ChatHidden.room_id == room.id
                    )
                )
            await session.commit()

    # ── Operations ───────────────────────────────────────────────────────────

    async def _operation(
        self, session: AsyncSession, user_id: str, request_id: str
    ) -> ChatOperation | None:
        return await session.get(
            ChatOperation, (require_tenant_id(), user_id, request_id)
        )

    @staticmethod
    def _require_same(operation: ChatOperation, kind: str, payload_hash: str) -> None:
        if operation.kind != kind or operation.payload_hash != payload_hash:
            raise ChatError(
                409,
                "REQUEST_REUSED",
                "This request id was already used for a different request.",
            )

    async def _claim(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        user_id: str,
        request_id: str,
        kind: str,
        payload_hash: str,
        state: str,
        room_id: str | None,
    ) -> bool:
        """Insert the operation row; False when one already holds the key.

        A concurrent attempt with the same key waits here for the first to
        commit or roll back, so at most one of them goes on to act.
        """
        claimed = await session.scalar(
            pg_insert(ChatOperation)
            .values(
                tenant_id=tenant_id,
                user_id=user_id,
                request_id=request_id,
                kind=kind,
                payload_hash=payload_hash,
                state=state,
                room_id=room_id,
            )
            .on_conflict_do_nothing(
                index_elements=["tenant_id", "user_id", "request_id"]
            )
            .returning(ChatOperation.request_id)
        )
        return claimed is not None

    async def _require_may_use_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        user: User,
        agent_id: str,
        *,
        room_id: str,
        group_id: str | None,
    ) -> Agent:
        """The agent, if the user may address it themselves in `room_id`.

        The rule the platform applies when it speaks for a person. Asked
        before a new room exists, `room_id` is "": a rule naming particular
        rooms admits nobody into a new one. No claimed platform account is
        consulted.
        """
        agent = await self._agent_store.get(session, agent_id)
        if agent is None or agent.tenant_id != tenant_id:
            raise ChatError(404, "AGENT_NOT_FOUND", "Agent not found.")
        if not _may_use(agent, user, room_id=room_id, group_id=group_id):
            raise ChatError(
                403, "AGENT_NOT_ALLOWED", "You may not chat with this agent here."
            )
        return agent

    async def agent_candidates(
        self, session: AsyncSession, tenant_id: str, user: User, room_id: str | None
    ) -> list[str]:
        """The ids of the agents the user could add: to a new chat when
        `room_id` is None, else to that room, which they must manage, less
        the agents already in it. The rule `_require_may_use_agent` applies."""
        self._require_group_chats()
        target_room_id, group_id, present = "", None, set[str]()
        if room_id is not None:
            room = await self._room(session, tenant_id, room_id)
            await self._require_manager(session, tenant_id, user, room)
            target_room_id, group_id = room.id, room.group_id
            present = set(await self._room_store.get_agent_ids(session, room.id))
        agents = (
            await session.execute(
                select(Agent).where(Agent.tenant_id == tenant_id).order_by(Agent.name)
            )
        ).scalars()
        return [
            agent.id
            for agent in agents
            if agent.id not in present
            and _may_use(agent, user, room_id=target_room_id, group_id=group_id)
        ]

    def _operation_id(self, tenant_id: str, user_id: str, request_id: str) -> str:
        return str(uuid.uuid5(_CHATS_NAMESPACE, f"{tenant_id}:{user_id}:{request_id}"))

    async def create_chat(
        self,
        tenant_id: str,
        user: User,
        *,
        agent_ids: list[str],
        member_user_ids: list[str],
        name: str | None,
        request_id: str,
        greeting: str | None,
        kind: Literal["group"] | None,
    ) -> Room:
        """A private room with the agents and members, owned by and joined by
        the user.

        One agent and no other member makes a direct room, which addresses
        the agent without a mention, unless `kind` asks for a group. Anything
        else is a group (a private channel), where a message names the agents
        it is for. Every agent must
        be one the user may address; every member a member of the workspace.

        Retrying with the same request id finishes whatever an earlier attempt
        left undone: the room is found by the operation id stamped on it, and
        the agents' and the user's memberships are re-applied.

        `greeting` is what the agent says as it joins, in place of its usual
        one-liner: its first words, written for it (switch-buddy's welcome).
        Only for a direct chat with one of the user's own agents.
        """
        member_user_ids = sorted(set(member_user_ids) - {user.id})
        direct = kind != "group" and len(agent_ids) == 1 and not member_user_ids
        if member_user_ids or kind == "group" or not agent_ids:
            self._require_group_chats()
        if greeting is not None:
            if len(agent_ids) != 1 or kind == "group":
                raise ChatError(
                    422,
                    "GREETING_NEEDS_ONE_AGENT",
                    "Only a direct chat with one agent opens with its greeting.",
                )
            if not greeting.strip():
                raise ChatError(422, "EMPTY_MESSAGE", "The greeting is empty.")
            if len(greeting) > GREETING_MAX_CHARS:
                raise ChatError(
                    422,
                    "GREETING_TOO_LONG",
                    f"A greeting is at most {GREETING_MAX_CHARS} characters.",
                )
        request: dict[str, object] = (
            {"agentId": agent_ids[0], "name": name}
            if len(agent_ids) == 1 and greeting is None
            else {"agentId": agent_ids[0], "name": name, "greeting": greeting}
            if len(agent_ids) == 1
            else {"agentIds": agent_ids, "name": name}
        )
        if member_user_ids:
            request["memberUserIds"] = member_user_ids
        # Only when given, so a request without it hashes as it always has.
        if kind is not None:
            request["kind"] = kind
        payload_hash = _hash(request)
        async with self._lock("create", tenant_id, user.id):
            async with tenant_session(self.session_factory, tenant_id) as session:
                operation = await self._operation(session, user.id, request_id)
                if operation is not None:
                    self._require_same(operation, "create_chat", payload_hash)
                    if operation.state == "done" and operation.room_id is not None:
                        room, _ = await self.require_member(
                            session, tenant_id, user, operation.room_id
                        )
                        return room
                agents = [
                    await self._require_may_use_agent(
                        session, tenant_id, user, agent_id, room_id="", group_id=None
                    )
                    for agent_id in agent_ids
                ]
                members = [
                    await self._require_tenant_member(session, tenant_id, member_id)
                    for member_id in member_user_ids
                ]
                if greeting is not None and agents[0].owner_id != user.id:
                    raise ChatError(
                        403,
                        "NOT_AGENT_OWNER",
                        "Only the agent's owner can give it a greeting.",
                    )
                if operation is None:
                    claimed = await self._claim(
                        session,
                        tenant_id=tenant_id,
                        user_id=user.id,
                        request_id=request_id,
                        kind="create_chat",
                        payload_hash=payload_hash,
                        state="pending",
                        room_id=None,
                    )
                    await session.commit()
                    if not claimed:
                        # The same request id, claimed first elsewhere: it has to
                        # be the same request before anything is done for it.
                        operation = await self._operation(session, user.id, request_id)
                        assert operation is not None
                        self._require_same(operation, "create_chat", payload_hash)
                        if operation.state == "done" and operation.room_id is not None:
                            room, _ = await self.require_member(
                                session, tenant_id, user, operation.room_id
                            )
                            return room
                operation_id = self._operation_id(tenant_id, user.id, request_id)
                found = await self._room_of_operation(session, operation_id)
            if found is None:
                names = ", ".join(
                    [agent.name for agent in agents]
                    + [member.name for member in members]
                )
                try:
                    created = await self._room_service.create_room(
                        RoomCreateConfig(
                            name=name or "New Chat",
                            description=(
                                f"Switch Console chat with {names}"
                                if names
                                else "Switch Console chat"
                            ),
                            agent_ids=[agent.id for agent in agents],
                            channel_type="direct" if direct else "channel_private",
                            internal_only=True,
                            created_by=user.id,
                            owner_id=user.id,
                            read_visibility="private",
                            write_visibility="private",
                            acting_user_id=user.id,
                            created_by_kind="user",
                            chat_operation_id=operation_id,
                            agent_greeting=(
                                {"agent_id": agents[0].id, "body": greeting}
                                if greeting is not None
                                else None
                            ),
                        )
                    )
                except ValueError as exc:
                    raise ChatError(422, "CHAT_NOT_CREATED", str(exc)) from exc
                except IntegrityError:
                    # The same request made the room first, on another process.
                    async with tenant_session(
                        self.session_factory, tenant_id
                    ) as session:
                        found = await self._room_of_operation(session, operation_id)
                    if found is None:
                        raise
                    room = found
                    await self._room_service.reconcile_room(room)
                else:
                    room = created.room
            else:
                room = found
                await self._room_service.reconcile_room(room)
            for joiner in [user, *members]:
                client = await self.member_actor(tenant_id, joiner)
                await self._join(tenant_id, room, client)
                await self._make_lasting(tenant_id, joiner.id, room.id)
            async with tenant_session(self.session_factory, tenant_id) as session:
                await self._start_reading(
                    session, room.id, [joiner.id for joiner in [user, *members]]
                )
                await session.execute(
                    update(ChatOperation)
                    .where(
                        ChatOperation.tenant_id == tenant_id,
                        ChatOperation.user_id == user.id,
                        ChatOperation.request_id == request_id,
                    )
                    .values(state="done", room_id=room.id, result={"roomId": room.id})
                )
                await session.commit()
        self._memberships_changed(tenant_id, [user.id, *member_user_ids], [room.id])
        if len(agents) == 1:
            self._start_session(agents[0].id, room.id)
        return room

    async def _room_of_operation(
        self, session: AsyncSession, operation_id: str
    ) -> Room | None:
        return (
            await session.execute(
                select(Room).where(
                    Room.metadata_["chat_operation_id"].astext == operation_id
                )
            )
        ).scalar_one_or_none()

    async def stage_upload(
        self,
        tenant_id: str,
        user: User,
        room_id: str,
        *,
        upload_id: str,
        data: bytes,
        filename: str,
        mimetype: str,
    ) -> StagedUpload:
        """Store a file for a later send, keyed by the caller's upload id."""
        mimetype = normalise_mime_type(mimetype) or "application/octet-stream"
        if not data:
            raise ChatError(422, "ATTACHMENT_REFUSED", f"'{filename}' is empty.")
        if len(data) > self._media_max_bytes:
            raise ChatError(
                422,
                "ATTACHMENT_REFUSED",
                f"'{filename}' is {len(data)} bytes, over the "
                f"{self._media_max_bytes}-byte limit.",
            )
        key = _upload_key(upload_id)
        payload_hash = _hash(
            {
                "roomId": room_id,
                "filename": filename,
                "mimetype": mimetype,
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, _ = await self.require_member(session, tenant_id, user, room_id)
            if await self._claim(
                session,
                tenant_id=tenant_id,
                user_id=user.id,
                request_id=key,
                kind="upload",
                payload_hash=payload_hash,
                state="done",
                room_id=room.id,
            ):
                uri = f"switch-media://{uuid.uuid4().hex}"
                await self._media_store.put(
                    session,
                    MediaBlob(
                        uri=uri,
                        content_type=mimetype,
                        filename=filename,
                        size=len(data),
                        data=data,
                    ),
                )
                staged = StagedUpload(upload_id, uri, filename, mimetype, len(data))
                await session.execute(
                    update(ChatOperation)
                    .where(
                        ChatOperation.tenant_id == tenant_id,
                        ChatOperation.user_id == user.id,
                        ChatOperation.request_id == key,
                    )
                    .values(result=_staged_result(staged))
                )
                await session.commit()
                return staged
            operation = await self._operation(session, user.id, key)
            assert operation is not None
            self._require_same(operation, "upload", payload_hash)
            return _staged(upload_id, operation)

    async def send(
        self,
        tenant_id: str,
        user: User,
        room_id: str,
        *,
        request_id: str,
        body: str,
        thread_root_id: str | None,
        upload_ids: list[str],
        mention_agent_id: str | None,
        mention_agent_ids: list[str],
        mention_user_ids: list[str],
        mention_spans: list[ChatMention],
    ) -> tuple[Room, list[Message]]:
        """Post the user's message, every part of it in one transaction.

        Files are staged first (`stage_upload`), so all that is left here is
        writing rows: each part, and the operation marked done, commit
        together or not at all. A retry after a failure before the commit
        posts it once; one after the commit answers the parts already posted.

        The agents the message is for are `mention_agent_ids` together with
        `mention_agent_id`, the one earlier clients send, as a set. The people
        it names, `mention_user_ids`, address no agent (`MENTIONS_KEY`).
        `mention_spans` say where in `body` each mention is written (UTF-16
        offsets, as the Console's strings count); an agent's span is for it as
        `mention_agent_ids` is, a person's addresses no agent.
        """
        mentions = sorted(set(mention_agent_ids))
        people = sorted(set(mention_user_ids))
        if people or mention_spans:
            self._require_group_chats()
        typed = _span_texts(body, mention_spans)
        request: dict[str, object] = {
            "roomId": room_id,
            "body": body,
            "threadRootId": thread_root_id,
            "uploadIds": upload_ids,
            "mentionAgentId": mention_agent_id,
        }
        if mentions:
            request["mentionAgentIds"] = mentions
        if people:
            request["mentionUserIds"] = people
        if mention_spans:
            request["mentionSpans"] = [span.model_dump() for span in mention_spans]
        payload_hash = _hash(request)
        if mention_agent_id is not None:
            mentions = sorted({*mentions, mention_agent_id})
        mentions = sorted(
            {*mentions, *(span.id for span in mention_spans if span.kind == "agent")}
        )
        people = sorted(
            {*people, *(span.id for span in mention_spans if span.kind == "user")}
        )
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, client = await self.require_member(session, tenant_id, user, room_id)
            operation = await self._operation(session, user.id, request_id)
            if operation is not None:
                self._require_same(operation, "send", payload_hash)
                return room, await self._posted(session, room, operation)

            unarchive = room.archived_at is not None
            if unarchive and not await self.can_manage(session, tenant_id, user, room):
                raise ChatError(
                    403,
                    "NOT_A_MANAGER",
                    "This chat is archived. Only its owner or a workspace admin "
                    "can bring it back by writing in it.",
                )
            if not body.strip() and not upload_ids:
                raise ChatError(422, "EMPTY_MESSAGE", "There is nothing to send.")
            uploads = [
                await self._staged_upload(session, user.id, room.id, upload_id)
                for upload_id in upload_ids
            ]
            root = await self._thread_root(session, room, thread_root_id)
            shift = 0
            if mentions:
                written = body
                body = await self._with_mentions(session, room, mentions, body)
                if body != written:
                    shift = _utf16_len(body) - _utf16_len(written)
            named_people = await self._named_people(
                session,
                room,
                people,
                mentions,
                [
                    text[1:]
                    for text, span in zip(typed, mention_spans, strict=True)
                    if span.kind == "user"
                ],
                [
                    {**span.model_dump(), "offset": span.offset + shift}
                    for span in mention_spans
                ],
            )

            if not await self._claim(
                session,
                tenant_id=tenant_id,
                user_id=user.id,
                request_id=request_id,
                kind="send",
                payload_hash=payload_hash,
                state="done",
                room_id=room.id,
            ):
                operation = await self._operation(session, user.id, request_id)
                assert operation is not None
                self._require_same(operation, "send", payload_hash)
                return room, await self._posted(session, room, operation)

            contents = _parts(
                body,
                uploads,
                sender_name=user.name,
                thread_root_id=root,
                group_id=str(
                    uuid.uuid5(
                        _CHATS_NAMESPACE,
                        f"{tenant_id}:{client.id}:{room.id}:{request_id}",
                    )
                ),
            )
            if named_people is not None:
                contents[0][MENTIONS_KEY] = named_people
            posted: list[Message] = []
            routed: list[Routed] = []
            for index, content in enumerate(contents):
                message = message_row(
                    room_id=room.id,
                    event_id=new_event_id(),
                    sender_id=client.transport_user_id,
                    sender_client_id=client.id,
                    sender_name=user.name,
                    event_type=MESSAGE_EVENT_TYPE,
                    content=content,
                    client_txn_id=f"{request_id}:{index}",
                )
                routed.append(
                    await self._router.store(
                        session,
                        tenant_id=tenant_id,
                        room_id=room.id,
                        transport_room_id=room.transport_room_id,
                        message=message,
                        attachments=attachments_in(content),
                    )
                )
                posted.append(message)
            await self._usage_store.record(
                session,
                tenant_id=tenant_id,
                metric=UsageMetric.MESSAGES,
                client_id=client.id,
                model="",
                amount=len(posted),
            )
            await session.execute(
                update(ChatOperation)
                .where(
                    ChatOperation.tenant_id == tenant_id,
                    ChatOperation.user_id == user.id,
                    ChatOperation.request_id == request_id,
                )
                .values(result={"messageIds": [m.transport_event_id for m in posted]})
            )
            if unarchive:
                await self._room_store.set_archived(session, room.id, False)
            await session.commit()
        if unarchive:
            self._room_service.room_changed(tenant_id, room.id)
        for each in routed:
            each.committed()
        for content in contents:
            metrics().increment(
                MESSAGES_SENT,
                {"kind": "media" if "url" in content else "message", "actor": "human"},
            )
        return room, posted

    async def control(
        self,
        tenant_id: str,
        user: User,
        room_id: str,
        *,
        request_id: str,
        agent_id: str,
        command: RoomControl,
        message_id: str | None,
    ) -> str:
        """Post `!<command> @agent` as the user; the command's event id.

        `retry` names the room message whose turn to run again (`message_id`):
        one the agent took a turn for, sent by the caller or in a room the
        caller manages. It is posted as `!retry @agent <message id>`.

        Written as the `com.switch.command` event a platform bridge writes for
        a typed `!interrupt`, so the agents' own command handling, addressing
        gate and in-room acknowledgement apply unchanged. The addressing check
        here only turns a refusal into an answer instead of a room message.
        """
        if (command == "retry") != (message_id is not None):
            raise ChatError(
                422,
                "INVALID_CONTROL",
                "A retry names the message to run again, and only a retry does.",
            )
        payload_hash = _hash(
            {
                "roomId": room_id,
                "agentId": agent_id,
                "command": command,
                **({"messageId": message_id} if message_id is not None else {}),
            }
        )
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, client = await self.require_member(session, tenant_id, user, room_id)
            operation = await self._operation(session, user.id, request_id)
            if operation is not None:
                self._require_same(operation, "control", payload_hash)
                return str((operation.result or {})["commandId"])

            if agent_id not in await self._room_store.get_agent_ids(session, room.id):
                raise ChatError(
                    422, "AGENT_NOT_IN_CHAT", "That agent is not in this chat."
                )
            agent = await self._agent_store.get(session, agent_id)
            assert agent is not None
            decision = await self._addressing.permitted(
                session, agent=agent, room_id=room.id, sender=client.transport_user_id
            )
            if not decision.allowed:
                raise ChatError(403, "AGENT_NOT_ALLOWED", decision.refusal)
            if command == "retry":
                assert message_id is not None
                await self._require_retryable(
                    session, tenant_id, user, room, client, agent, message_id
                )
            # `!interrupt` stops the agent's running turn wherever it runs; this check can race a turn change.
            if command == "interrupt":
                turn = await self._activity_store.newest_running_turn(session, agent.id)
                if turn is None or turn.room_id != room.id:
                    raise ChatError(
                        409,
                        "NOTHING_RUNNING_HERE",
                        f"{agent.name}'s current turn is not in this chat.",
                    )

            if not await self._claim(
                session,
                tenant_id=tenant_id,
                user_id=user.id,
                request_id=request_id,
                kind="control",
                payload_hash=payload_hash,
                state="done",
                room_id=room.id,
            ):
                operation = await self._operation(session, user.id, request_id)
                assert operation is not None
                self._require_same(operation, "control", payload_hash)
                return str((operation.result or {})["commandId"])

            command_id = new_event_id()
            routed = await self._router.store(
                session,
                tenant_id=tenant_id,
                room_id=room.id,
                transport_room_id=room.transport_room_id,
                message=message_row(
                    room_id=room.id,
                    event_id=command_id,
                    sender_id=client.transport_user_id,
                    sender_client_id=client.id,
                    sender_name=user.name,
                    event_type=COMMAND_EVENT_TYPE,
                    content={
                        "command": command,
                        "args": f"@{agent.name}"
                        + (f" {message_id}" if message_id is not None else ""),
                        "user_id": client.transport_user_id,
                        "user_name": user.name,
                    },
                    client_txn_id=request_id,
                ),
                attachments=[],
            )
            await session.execute(
                update(ChatOperation)
                .where(
                    ChatOperation.tenant_id == tenant_id,
                    ChatOperation.user_id == user.id,
                    ChatOperation.request_id == request_id,
                )
                .values(result={"commandId": command_id})
            )
            await session.commit()
        routed.committed()
        return command_id

    async def _require_retryable(
        self,
        session: AsyncSession,
        tenant_id: str,
        user: User,
        room: Room,
        client: Client,
        agent: Agent,
        message_id: str,
    ) -> None:
        """Refuse a retry of anything but a message of this room the agent took a
        turn for, asked by whoever sent it or someone who manages the room."""
        message = (
            await session.execute(
                select(Message).where(
                    Message.room_id == room.id,
                    Message.transport_event_id == message_id,
                )
            )
        ).scalar_one_or_none()
        if message is None:
            raise ChatError(
                404, "MESSAGE_NOT_FOUND", "That message is not in this chat."
            )
        if message.sender_client_id != client.id and not await self.can_manage(
            session, tenant_id, user, room
        ):
            raise ChatError(
                403,
                "NOT_YOUR_MESSAGE",
                "Only whoever sent that message, or someone who manages the chat, can retry it.",
            )
        turn = await self._activity_store.turn_for_message(
            session, agent.id, room.id, message_id
        )
        if turn is None:
            raise ChatError(
                409,
                "NOTHING_TO_RETRY",
                f"{agent.name} took no turn for that message, so there is nothing to retry.",
            )
        if turn.status not in RETRYABLE_TURN_STATUSES:
            raise ChatError(
                409,
                "NOTHING_TO_RETRY",
                f"{agent.name}'s turn for that message did not fail and was not "
                "interrupted, so there is nothing to retry.",
            )

    async def warm(
        self, tenant_id: str, user: User, room_id: str, *, agent_id: str
    ) -> None:
        """Ask the controller of the user's own agent to start its session for
        this chat before the first message. A hint: nothing waits for it, and
        an agent no controller hosts is not warmed. The controller is asked
        through whichever process holds its socket
        (`AgentConnectionRegistry.relay_warm`)."""
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, client = await self.require_member(session, tenant_id, user, room_id)
            if agent_id not in await self._room_store.get_agent_ids(session, room.id):
                raise ChatError(
                    422, "AGENT_NOT_IN_CHAT", "That agent is not in this chat."
                )
            agent = await self._agent_store.get(session, agent_id)
            assert agent is not None
            decision = await self._addressing.permitted(
                session, agent=agent, room_id=room.id, sender=client.transport_user_id
            )
            if not decision.allowed:
                raise ChatError(403, "AGENT_NOT_ALLOWED", decision.refusal)
        self._start_session(agent_id, room.id)

    def _start_session(self, agent_id: str, room_id: str) -> None:
        """A hint to a controller-hosted agent: nothing waits for it. An agent
        no controller hosts is started by the Console that runs it."""
        if not self._connections.controllers.is_bound(agent_id):
            return
        if not self._connections.relay_warm(agent_id, room_id):
            logger.warning(
                "Could not start agent %s's session for room %s: its controller is not connected or it is stopped",
                agent_id,
                room_id,
            )

    async def _posted(
        self, session: AsyncSession, room: Room, operation: ChatOperation
    ) -> list[Message]:
        ids = (operation.result or {}).get("messageIds", [])
        rows = await self._message_store.list_by_transport_event_ids(
            session, room.id, ids
        )
        return sorted(rows, key=lambda m: m.seq)

    async def _staged_upload(
        self, session: AsyncSession, user_id: str, room_id: str, upload_id: str
    ) -> StagedUpload:
        operation = await self._operation(session, user_id, _upload_key(upload_id))
        if (
            operation is None
            or operation.kind != "upload"
            or operation.room_id != room_id
        ):
            raise ChatError(
                422,
                "UPLOAD_NOT_FOUND",
                f"No file was uploaded to this chat as {upload_id}.",
            )
        return _staged(upload_id, operation)

    async def _thread_root(
        self, session: AsyncSession, room: Room, thread_root_id: str | None
    ) -> str | None:
        """The thread a reply goes in: a mid-thread message names its root."""
        if thread_root_id is None:
            return None
        found = await self._message_store.list_by_transport_event_ids(
            session, room.id, [thread_root_id]
        )
        if not found:
            raise ChatError(
                422, "THREAD_NOT_FOUND", "The message to reply to is not in this chat."
            )
        return found[0].thread_root_event_id or found[0].transport_event_id

    async def _named_people(
        self,
        session: AsyncSession,
        room: Room,
        user_ids: list[str],
        agent_ids: list[str],
        typed_names: list[str],
        spans: list[dict[str, object]],
    ) -> dict[str, object] | None:
        """What a send records of the mentions it makes (`MENTIONS_KEY`): the
        people's ids, the names whose `@` spans address no agent (the people's
        names and what their spans say), and where each mention is written.
        A name an agent named in the same send also answers to stays the
        agent's."""
        if not user_ids and not spans:
            return None
        names: dict[str, str] = {
            user_id: name
            for user_id, name in (
                await session.execute(
                    select(User.id, User.name)
                    .join(Client, Client.user_id == User.id)
                    .join(ClientRoom, ClientRoom.client_id == Client.id)
                    .where(
                        ClientRoom.room_id == room.id,
                        Client.type == MEMBER_CLIENT_TYPE,
                        User.id.in_(user_ids),
                    )
                )
            ).all()
        }
        if len(names) != len(user_ids):
            raise ChatError(422, "USER_NOT_IN_CHAT", "That person is not in this chat.")
        aliases = await self._room_store.list_aliases(session, room.id)
        spoken: set[str] = set()
        for agent_id in agent_ids:
            agent = await self._agent_store.get(session, agent_id)
            assert agent is not None
            spoken.add(agent.name.lower())
            if agent_id in aliases:
                spoken.add(aliases[agent_id].lower())
        return {
            "user_ids": user_ids,
            "person_names": sorted(
                {
                    name
                    for name in [*names.values(), *typed_names]
                    if name and name.lower() not in spoken
                }
            ),
            "spans": spans,
        }

    async def _with_mentions(
        self, session: AsyncSession, room: Room, agent_ids: list[str], body: str
    ) -> str:
        """`body` led by an `@name` for each agent it does not already name by
        name or room alias, so every agent decides it was addressed by the
        same rule a typed mention meets."""
        in_room = set(await self._room_store.get_agent_ids(session, room.id))
        if any(agent_id not in in_room for agent_id in agent_ids):
            raise ChatError(422, "AGENT_NOT_IN_CHAT", "That agent is not in this chat.")
        aliases = await self._room_store.list_aliases(session, room.id)
        text = strip_emphasis(body)
        missing: list[str] = []
        for agent_id in agent_ids:
            agent = await self._agent_store.get(session, agent_id)
            assert agent is not None
            spoken = [agent.name, *([aliases[agent_id]] if agent_id in aliases else [])]
            if all(mention_regex(name).search(text) is None for name in spoken):
                missing.append(agent.name)
        prefix = " ".join(f"@{name}" for name in sorted(missing))
        if not prefix:
            return body
        return f"{prefix} {body}" if body else prefix


def _may_use(agent: Agent, user: User, *, room_id: str, group_id: str | None) -> bool:
    """Whether `user` may address `agent` themselves in `room_id` ("" for a
    room not made yet), with no claimed platform account consulted."""
    return allows_on_behalf_of(
        parse_policy(agent.addressing_policy),
        room_id=room_id,
        group_id=group_id,
        user_id=user.id,
        external_user_ids=[],
        owner_user_id=agent.owner_id,
    )


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _span_texts(body: str, spans: list[ChatMention]) -> list[str]:
    """What each span covers in `body`, in the spans' order, or a refusal for
    a span out of bounds, splitting a character, overlapping another, or not
    starting with `@`. Offsets and lengths count UTF-16 code units."""
    units = body.encode("utf-16-le")
    refusal = ChatError(422, "INVALID_MENTION", "A mention does not match the message.")
    end = 0
    for span in sorted(spans, key=lambda each: each.offset):
        if (
            span.offset < end
            or span.length < 1
            or span.offset + span.length > len(units) // 2
        ):
            raise refusal
        end = span.offset + span.length
    texts = []
    for span in spans:
        try:
            text = units[span.offset * 2 : (span.offset + span.length) * 2].decode(
                "utf-16-le"
            )
        except UnicodeDecodeError as exc:
            raise refusal from exc
        if not text.startswith("@"):
            raise refusal
        texts.append(text)
    return texts


def _owns_agent_in_room(user_id: str) -> ColumnElement[bool]:
    """True for a `Room` row holding an agent `user_id` owns."""
    return exists().where(
        room_agents.c.room_id == Room.id,
        room_agents.c.agent_id == Agent.id,
        Agent.owner_id == user_id,
    )


def _owner_joins(user_id: str) -> ColumnElement[bool]:
    """True for a `Room` row `sync_owned_rooms` puts `user_id` in: a chat they
    started through the chats API that holds an agent they own."""
    return and_(
        Room.created_by == user_id,
        Room.metadata_.has_key("chat_operation_id"),
        _owns_agent_in_room(user_id),
    )


def _staged_result(staged: StagedUpload) -> dict[str, object]:
    return {
        "uri": staged.uri,
        "filename": staged.filename,
        "mimetype": staged.mimetype,
        "size": staged.size,
    }


def _staged(upload_id: str, operation: ChatOperation) -> StagedUpload:
    result = operation.result or {}
    return StagedUpload(
        upload_id=upload_id,
        uri=str(result["uri"]),
        filename=str(result["filename"]),
        mimetype=str(result["mimetype"]),
        size=int(str(result["size"])),
    )


_PARAGRAPH_TAG = re.compile(r"</?p>")
_HTML_TAG = re.compile(r"<[A-Za-z/!]")


def _format_of(body: str) -> MessageFormat:
    """Markdown only when rendering it adds more than paragraphs.

    A plain sentence stays plain text, so receivers do not get an HTML body
    that says nothing the text does not.
    """
    rendered = _PARAGRAPH_TAG.sub("", markdown.markdown(body))
    return "markdown" if _HTML_TAG.search(rendered) else "text"


def _parts(
    body: str,
    uploads: list[StagedUpload],
    *,
    sender_name: str,
    thread_root_id: str | None,
    group_id: str,
) -> list[dict[str, object]]:
    """The events a send is made of.

    Text alone is one message. With files, the text rides as the caption on
    the first and the rest are bare media events; more than one file shares
    a group so receivers can show them as one post.
    """
    if not uploads:
        return [
            message_content(
                body,
                sender_name=sender_name,
                format=_format_of(body),
                thread_root_id=thread_root_id,
            )
        ]
    total = len(uploads)
    return [
        media_content(
            upload.uri,
            upload.filename,
            upload.mimetype,
            upload.size,
            sender_name=sender_name,
            msgtype="m.image" if upload.mimetype.startswith("image/") else "m.file",
            caption=body if index == 0 and body.strip() else None,
            thread_root_id=thread_root_id,
            group=(
                {"id": group_id, "index": index, "total": total} if total > 1 else None
            ),
        )
        for index, upload in enumerate(uploads)
    ]
