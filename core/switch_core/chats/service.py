"""A gateway user in Switch rooms as themselves: membership, chats and sends.

Membership is the only read authority. A person sees a room when their
`member` client has a `client_rooms` row for it and they still hold a role in
the tenant; a room's visibility and any claimed platform account do not count.
Membership is granted by creating a chat, by a room manager (the room's owner
or a tenant admin) adding a tenant member, or by a manager adding themselves.
It is also granted to anyone who owns an agent in a room, for as long as they
do: `sync_owned_rooms` puts them in and takes back what was held only for that.

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

import markdown
from sqlalchemy import ColumnElement, delete, exists, false, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import allows_on_behalf_of, parse_policy
from switch_core.authz import administers_tenant
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.chats.views import MESSAGE_EVENT_TYPE
from switch_core.clients.mentions import mention_regex, strip_emphasis
from switch_core.db.models import (
    Agent,
    ChatHidden,
    ChatOperation,
    ChatOwnerGrant,
    Client,
    ClientRoom,
    MediaBlob,
    Message,
    MessageAttachment,
    Room,
    UsageMetric,
    User,
    require_tenant_id,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.messages.notify import MessageListener
from switch_core.messages.row import attachments_in, message_row, new_event_id
from switch_core.observability.catalogue import MESSAGES_SENT
from switch_core.observability.metrics import metrics
from switch_core.provisioning import Provisioning
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.sessions.attachments import normalise_mime_type
from switch_core.tenant_context import tenant_scope
from switch_core.transport.content import media_content, message_content
from switch_core.transport.types import MessageFormat

logger = logging.getLogger(__name__)

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
        room_store: RoomStore,
        agent_store: AgentStore,
        user_store: UserStore,
        message_store: MessageStore,
        media_store: MediaStore,
        usage_store: UsageStore,
        id_server_name: str,
        media_max_bytes: int,
    ) -> None:
        self.session_factory = session_factory
        self.listener = listener
        self._room_service = room_service
        self._provisioning = provisioning
        self._room_store = room_store
        self._agent_store = agent_store
        self._user_store = user_store
        self._message_store = message_store
        self._media_store = media_store
        self._usage_store = usage_store
        self._id_server_name = id_server_name
        self._media_max_bytes = media_max_bytes
        self._locks: weakref.WeakValueDictionary[tuple[str, ...], asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._membership_watchers: dict[tuple[str, str], set[Callable[[], None]]] = {}

    # ── Membership signals ───────────────────────────────────────────────────

    def watch_memberships(
        self, tenant_id: str, user_id: str, callback: Callable[[], None]
    ) -> None:
        """Call `callback` whenever this process changes the user's chats."""
        self._membership_watchers.setdefault((tenant_id, user_id), set()).add(callback)

    def unwatch_memberships(
        self, tenant_id: str, user_id: str, callback: Callable[[], None]
    ) -> None:
        watchers = self._membership_watchers.get((tenant_id, user_id))
        if watchers is None:
            return
        watchers.discard(callback)
        if not watchers:
            del self._membership_watchers[(tenant_id, user_id)]

    def _memberships_changed(self, tenant_id: str, user_ids: list[str]) -> None:
        for user_id in user_ids:
            for callback in list(
                self._membership_watchers.get((tenant_id, user_id), ())
            ):
                callback()

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
                client = Client(
                    transport_user_id=f"@switch-member-{user.id}:{self._id_server_name}",
                    display_name=user.name,
                    type=MEMBER_CLIENT_TYPE,
                    user_id=user.id,
                )
                session.add(client)
                await session.commit()
                logger.info("Created member client %s for user %s", client.id, user.id)
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
        if room.archived_at is None and await self.owns_agent_in(
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
        role = await self._user_store.tenant_role(session, tenant_id, user.id)
        return administers_tenant(is_operator=user.role == "admin", tenant_role=role)

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

    async def owns_agent_in(
        self, session: AsyncSession, user_id: str, room_id: str
    ) -> bool:
        return bool(
            await session.scalar(
                select(exists().where(Room.id == room_id, _owns_agent_in_room(user_id)))
            )
        )

    async def sync_owned_rooms(self, tenant_id: str, user_id: str) -> None:
        """Put the user in every live room holding an agent they own, and take
        back each membership held only for that once they no longer do.

        Such a membership is marked by a `ChatOwnerGrant`; being invited,
        creating the chat or joining as a manager removes the mark, and the
        membership then stays when the agent goes. Cheap when nothing changed:
        two queries.
        """
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
                                _owns_agent_in_room(user_id),
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
                                ~_owns_agent_in_room(user_id),
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
        self._memberships_changed(tenant_id, [user_id])

    async def sync_room(self, tenant_id: str, room_id: str) -> None:
        """`sync_owned_rooms` for everyone a change to this room's agents may
        concern: the owners of its agents and the holders of owner grants."""
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
        for user_id in sorted(
            user_id for user_id in owners | holders if user_id is not None
        ):
            await self.sync_owned_rooms(tenant_id, user_id)

    async def _make_lasting(self, tenant_id: str, user_id: str, room_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            await session.execute(
                delete(ChatOwnerGrant).where(
                    ChatOwnerGrant.user_id == user_id, ChatOwnerGrant.room_id == room_id
                )
            )
            await session.commit()

    # ── Listing ──────────────────────────────────────────────────────────────

    async def stream_rooms(self, session: AsyncSession, user_id: str) -> list[Room]:
        """The caller's member rooms that are chats: unarchived, with an agent."""
        client = await self.member_client(session, user_id)
        if client is None:
            return []
        result = await session.execute(
            select(Room)
            .join(ClientRoom, ClientRoom.room_id == Room.id)
            .where(
                ClientRoom.client_id == client.id,
                Room.archived_at.is_(None),
                exists().where(room_agents.c.room_id == Room.id),
            )
            .order_by(Room.created_at)
        )
        return list(result.scalars().all())

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
            .where(Message.room_id == room_id, Message.event_type == MESSAGE_EVENT_TYPE)
            .order_by(Message.seq.desc())
            .limit(1)
        )
        return seq if seq is not None else 0

    async def page(
        self, session: AsyncSession, room_id: str, before_seq: int | None, limit: int
    ) -> tuple[list[Message], int, bool]:
        """Messages before `before_seq` (newest first, returned oldest first),
        the room's head position, and whether older messages remain."""
        query = select(Message).where(
            Message.room_id == room_id, Message.event_type == MESSAGE_EVENT_TYPE
        )
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

    async def add_member(
        self, tenant_id: str, actor: User, room_id: str, target_user_id: str
    ) -> Room:
        async with tenant_session(self.session_factory, tenant_id) as session:
            room = await self._room(session, tenant_id, room_id)
            await self._require_manager(session, tenant_id, actor, room)
            target = await self._user_store.get(session, target_user_id)
            if target is None or not await self.has_tenant_role(
                session, tenant_id, target_user_id
            ):
                raise ChatError(
                    422,
                    "NOT_A_TENANT_MEMBER",
                    "That person is not a member of this workspace.",
                )
        client = await self.member_actor(tenant_id, target)
        await self._join(tenant_id, room, client)
        await self._make_lasting(tenant_id, target_user_id, room.id)
        self._memberships_changed(tenant_id, [target_user_id])
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
            if await self.owns_agent_in(session, target_user_id, room.id):
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
        self._memberships_changed(tenant_id, [target_user_id])

    async def archive(self, tenant_id: str, user: User, room_id: str) -> None:
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, _ = await self.require_member(session, tenant_id, user, room_id)
            await self._require_manager(session, tenant_id, user, room)
            member_ids = [member.id for member, _ in await self.members(session, room)]
        await self._room_service.set_room_archived(room.id, True)
        self._memberships_changed(tenant_id, member_ids)

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
        self, session: AsyncSession, tenant_id: str, user: User, agent_id: str
    ) -> Agent:
        """The agent, if the user may address it themselves.

        The rule the platform applies when it speaks for a person, asked
        before the room exists: a rule naming particular rooms admits nobody
        into a new one, and no claimed platform account is consulted.
        """
        agent = await self._agent_store.get(session, agent_id)
        if agent is None or agent.tenant_id != tenant_id:
            raise ChatError(404, "AGENT_NOT_FOUND", "Agent not found.")
        if not allows_on_behalf_of(
            parse_policy(agent.addressing_policy),
            room_id="",
            group_id=None,
            user_id=user.id,
            external_user_ids=[],
            owner_user_id=agent.owner_id,
        ):
            raise ChatError(
                403, "AGENT_NOT_ALLOWED", "You may not start a chat with this agent."
            )
        return agent

    def _operation_id(self, tenant_id: str, user_id: str, request_id: str) -> str:
        return str(uuid.uuid5(_CHATS_NAMESPACE, f"{tenant_id}:{user_id}:{request_id}"))

    async def create_chat(
        self,
        tenant_id: str,
        user: User,
        *,
        agent_ids: list[str],
        name: str | None,
        request_id: str,
    ) -> Room:
        """A private room with the agents, owned by and joined by the user.

        One agent makes a direct room, which addresses it without a mention.
        Several make a private channel, where a message names the agent it is
        for. Every agent must be one the user may address.

        Retrying with the same request id finishes whatever an earlier attempt
        left undone: the room is found by the operation id stamped on it, and
        the agents' and the user's memberships are re-applied.
        """
        if not agent_ids:
            raise ChatError(422, "AGENTS_REQUIRED", "A chat needs at least one agent.")
        payload_hash = _hash(
            {"agentId": agent_ids[0], "name": name}
            if len(agent_ids) == 1
            else {"agentIds": agent_ids, "name": name}
        )
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
                        session, tenant_id, user, agent_id
                    )
                    for agent_id in agent_ids
                ]
                if operation is None:
                    await self._claim(
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
                operation_id = self._operation_id(tenant_id, user.id, request_id)
                found = (
                    await session.execute(
                        select(Room).where(
                            Room.metadata_["chat_operation_id"].astext == operation_id
                        )
                    )
                ).scalar_one_or_none()
            if found is None:
                try:
                    created = await self._room_service.create_room(
                        RoomCreateConfig(
                            name=name
                            or "Chat with "
                            + ", ".join(
                                agent.display_name or agent.name for agent in agents
                            ),
                            description="Switch Console chat with "
                            + ", ".join(agent.name for agent in agents),
                            agent_ids=[agent.id for agent in agents],
                            channel_type=(
                                "direct" if len(agents) == 1 else "channel_private"
                            ),
                            internal_only=True,
                            created_by=user.id,
                            owner_id=user.id,
                            read_visibility="private",
                            write_visibility="private",
                            acting_user_id=user.id,
                            created_by_kind="user",
                            chat_operation_id=operation_id,
                        )
                    )
                except ValueError as exc:
                    raise ChatError(422, "CHAT_NOT_CREATED", str(exc)) from exc
                room = created.room
            else:
                room = found
                await self._room_service.reconcile_room(room)
            client = await self.member_actor(tenant_id, user)
            await self._join(tenant_id, room, client)
            await self._make_lasting(tenant_id, user.id, room.id)
            async with tenant_session(self.session_factory, tenant_id) as session:
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
        self._memberships_changed(tenant_id, [user.id])
        return room

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
    ) -> tuple[Room, list[Message]]:
        """Post the user's message, every part of it in one transaction.

        Files are staged first (`stage_upload`), so all that is left here is
        writing rows: each part, and the operation marked done, commit
        together or not at all. A retry after a failure before the commit
        posts it once; one after the commit answers the parts already posted.
        """
        payload_hash = _hash(
            {
                "roomId": room_id,
                "body": body,
                "threadRootId": thread_root_id,
                "uploadIds": upload_ids,
                "mentionAgentId": mention_agent_id,
            }
        )
        async with tenant_session(self.session_factory, tenant_id) as session:
            room, client = await self.require_member(session, tenant_id, user, room_id)
            operation = await self._operation(session, user.id, request_id)
            if operation is not None:
                self._require_same(operation, "send", payload_hash)
                return room, await self._posted(session, room, operation)

            if not body.strip() and not upload_ids:
                raise ChatError(422, "EMPTY_MESSAGE", "There is nothing to send.")
            uploads = [
                await self._staged_upload(session, user.id, room.id, upload_id)
                for upload_id in upload_ids
            ]
            root = await self._thread_root(session, room, thread_root_id)
            if mention_agent_id is not None:
                body = await self._with_mention(session, room, mention_agent_id, body)

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
            posted: list[Message] = []
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
                posted.append(
                    await self._message_store.create(
                        session, message, attachments_in(content)
                    )
                )
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
            await session.commit()
        for content in contents:
            metrics().increment(
                MESSAGES_SENT,
                {"kind": "media" if "url" in content else "message", "actor": "human"},
            )
        return room, posted

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

    async def _with_mention(
        self, session: AsyncSession, room: Room, agent_id: str, body: str
    ) -> str:
        if agent_id not in await self._room_store.get_agent_ids(session, room.id):
            raise ChatError(422, "AGENT_NOT_IN_CHAT", "That agent is not in this chat.")
        agent = await self._agent_store.get(session, agent_id)
        assert agent is not None
        if mention_regex(agent.name).search(strip_emphasis(body)) is not None:
            return body
        return f"@{agent.name} {body}" if body else f"@{agent.name}"


def _owns_agent_in_room(user_id: str) -> ColumnElement[bool]:
    """True for a `Room` row holding an agent `user_id` owns."""
    return exists().where(
        room_agents.c.room_id == Room.id,
        room_agents.c.agent_id == Agent.id,
        Agent.owner_id == user_id,
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
