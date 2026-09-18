from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal, Unpack

from switch_core.agent_display_name import agent_label_with_identifier
from switch_core.bridges.agent.commands import (
    dispatch_admin_command,
    resolve_command_target,
)
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.clients.admin_messages import (
    ADMIN_MARKER,
    PLATFORM_MARKER,
    AdminMessageType,
    OnBehalfOf,
    admin_extra_content,
)
from switch_core.clients.client_base import (
    ClientBase,
    ClientBaseKwargs,
    ClientConfig,
)
from switch_core.clients.mentions import (
    mention_regex,
    strip_emphasis,
    unique_mention_tokens,
)
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver
from switch_core.events import CommandEvent
from switch_core.transport import InboundMessage, RoomRef

if TYPE_CHECKING:
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)


class AdminClient(ClientBase[ClientConfig]):
    """The always-present system client that lives in every room and emits
    first-class admin/system messages.

    Two jobs:
      1. Observe room messages and post heads-up notices when a message tags an
         agent that is not a member, or a room-role with no live holder.
      2. Handle the room/info/alias `!` commands (the admin-owned set) and
         render their results as admin messages.

    Every admin message carries the admin marker so it renders natively per
    bridge and never triggers another client (loop-safe). The admin client is
    not an agent — it holds no Agent row — so it reasons purely from the stores.
    """

    def __init__(
        self,
        *,
        agent_store: AgentStore,
        room_store: RoomStore,
        room_role_store: RoomRoleStore,
        connections: ConnectionRegistry,
        document_store: DocumentStore,
        reference_store: ReferenceStore,
        agent_session_store: AgentSessionStore,
        external_user_store: ExternalUserStore,
        room_service: RoomService,
        frontend_base_url: str | None,
        **kwargs: Unpack[ClientBaseKwargs[ClientConfig]],
    ) -> None:
        super().__init__(**kwargs)
        self._agent_store = agent_store
        self._room_store = room_store
        self._room_role_store = room_role_store
        self._connections = connections
        self._document_store = document_store
        self._reference_store = reference_store
        self._agent_session_store = agent_session_store
        self._room_service = room_service
        # The same resolver the agent clients use, so a command aimed at an
        # agent is judged by exactly the rules a message to it would be.
        self._addressing = AddressingResolver(
            room_store=room_store,
            room_role_store=room_role_store,
            client_store=self.client_store,
            agent_store=agent_store,
            external_user_store=external_user_store,
            live_agent_ids=lambda: connections.live_agent_ids(),
        )
        self._frontend_base_url = (
            frontend_base_url.rstrip("/") if frontend_base_url else None
        )
        # matrix_room_id -> RoomMeta (None when no Switch room maps).
        self._room_meta_cache: dict[str, RoomMeta | None] = {}

    # ── Event hooks ───────────────────────────────────────────────────────────

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        content = event.content
        # Never react to admin/system messages — including our own notices —
        # so the rail can't loop on itself.
        if ADMIN_MARKER in content:
            return
        body = event.body or ""
        if "@" not in body:
            return

        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return

        thread_id = event.thread_root_id
        thread_root = thread_id if thread_id is not None else event.event_id

        await self._warn_unreachable_roles(room, event, meta.room_id, thread_root)
        await self._warn_absent_agents(room, event, meta.room_id, thread_root)

    async def on_command(self, room: RoomRef, event: CommandEvent) -> None:
        await dispatch_admin_command(self, room, event)

    async def command_refusal(self, event: CommandEvent, room_id: str) -> str | None:
        """The refusal to post for a command aimed at an agent the sender may
        not address, or None when it may go ahead.

        Commands act on an agent as surely as a message to it does — an alias
        changes how it is addressed, an invite puts it in a room — so the
        agent's addressing policy governs both. A target that resolves to no
        agent is not refused here: the handler runs and gives its own "no such
        agent" notice, which is the more useful answer and leaks nothing, since
        the policy could not have applied to a nonexistent agent anyway.
        """
        async with self.session_factory() as session:
            target = await resolve_command_target(self, session, room_id, event.args)
            if target is None:
                return None
            decision = await self._addressing.permitted(
                session,
                agent=target,
                room_id=room_id,
                sender=event.user_id,
            )
        if decision.allowed:
            return None
        logger.warning(
            "Command %s from %s refused: sender may not address %s in room %s",
            event.command,
            event.user_id,
            target.name,
            room_id,
        )
        return decision.refusal

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
        await self.send_message(
            room_id,
            body,
            format=format,
            thread_root_id=thread_root_id,
            extra_content=admin_extra_content(AdminMessageType.COMMAND_RESULT),
        )

    # ── Platform messages ───────────────────────────────────────────────────

    async def send_platform_message(
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id: str | None = None,
        on_behalf_of: OnBehalfOf | None = None,
        reply_in_channel: bool = False,
    ) -> str | None:
        """Send an addressed message as the Switch platform.

        Unlike an admin notice it carries no ADMIN_MARKER and IS addressed to
        agents. ``on_behalf_of`` names the person whose authority it carries:
        each addressed agent applies its policy to that person, so the
        platform can say what they could have said and nothing more. Without
        it the message is the platform's own, which agents deny unless a rule
        opts them in.
        """
        marker_value: dict[str, object] = {}
        if on_behalf_of is not None:
            marker_value["on_behalf_of"] = {
                "user_id": on_behalf_of.user_id,
                "name": on_behalf_of.name,
            }
        if reply_in_channel:
            # Only meaningful for a threaded message: the agents it addresses
            # answer at the top level instead of under it.
            marker_value["reply_in_channel"] = True
        return await self.send_message(
            room_id,
            body,
            format="markdown",
            thread_root_id=thread_root_id,
            extra_content={PLATFORM_MARKER: marker_value},
        )

    # ── Admin notices ─────────────────────────────────────────────────────────

    async def _warn_unreachable_roles(
        self,
        room: RoomRef,
        event: InboundMessage,
        room_id: str,
        thread_id: str | None,
    ) -> None:
        """Warn when a tagged room-role has no LIVE holder.

        A role with no live lease (unassigned, or a stale lease whose holder's
        session is gone — shown free by `!roles`) routes to nobody, so the admin
        posts a heads-up in the triggering message's thread. A role WITH a live
        holder is not flagged: that holder is addressed and responds.
        """
        body = getattr(event, "body", "") or ""
        if "@" not in body:
            return
        unreachable: list[str] = []
        async with self.session_factory() as session:
            roles = await self._room_role_store.list_roles(session, room_id)
            for role in roles:
                if mention_regex(role.name).search(strip_emphasis(body)) is None:
                    continue
                if not await self._room_role_store.has_live_holder(
                    session, role.id, self._connections.live_agent_ids()
                ):
                    unreachable.append(role.name)
        handle = self._sender_handle(event)
        for name in unreachable:
            notice = (
                f"⚠️ @{handle} no agent currently holds the **{name}** role — "
                f"your message may go unanswered. Run `!roles` to see "
                f"availability, or have an agent assume it."
            )
            await self._send_admin(
                room.room_id,
                notice,
                message_type=AdminMessageType.UNREACHABLE_ROLE,
                thread_root_id=thread_id,
                mentions=[event.sender],
            )

    async def _warn_absent_agents(
        self,
        room: RoomRef,
        event: InboundMessage,
        room_id: str,
        thread_id: str | None,
    ) -> None:
        """Warn when a tagged agent is not a member of the room.

        An `@name` that resolves to a registered agent which is not in this room
        routes to nobody, so the admin posts a heads-up in the triggering
        message's thread naming the absent agent(s). Tokens that map to a
        room-role (handled by `_warn_unreachable_roles`), to a current member, or
        to no agent at all (a human user or a typo) are ignored.
        """
        body = getattr(event, "body", "") or ""
        if "@" not in body:
            return
        tokens = unique_mention_tokens(body)
        if not tokens:
            return
        absent: list[str] = []
        async with self.session_factory() as session:
            member_ids = set(await self._room_store.get_agent_ids(session, room_id))
            role_names = {
                role.name.lower()
                for role in await self._room_role_store.list_roles(session, room_id)
            }
            for token in tokens:
                if token.lower() in role_names:
                    continue
                agent = await self._agent_store.get_by_name_insensitive(session, token)
                if agent is None or agent.id in member_ids:
                    continue
                absent.append(
                    agent_label_with_identifier(agent.display_name, agent.name)
                )
        if not absent:
            return
        names = ", ".join(f"**{label}**" for label in absent)
        verb = "isn't" if len(absent) == 1 else "aren't"
        pronoun = "it" if len(absent) == 1 else "them"
        handle = self._sender_handle(event)
        notice = (
            f"⚠️ @{handle} {names} {verb} in this room, so your message won't "
            f"reach {pronoun}. Add the agent from the room's detail page in the "
            f"gateway, or have an agent with room-management tools invite it."
        )
        await self._send_admin(
            room.room_id,
            notice,
            message_type=AdminMessageType.ABSENT_AGENT,
            thread_root_id=thread_id,
            mentions=[event.sender],
        )

    # ── Helpers ────────────────────────────────────────────────────────────────

    async def _send_admin(
        self,
        room_id: str,
        body: str,
        *,
        message_type: AdminMessageType,
        thread_root_id: str | None,
        mentions: list[str] | None = None,
    ) -> None:
        await self.send_message(
            room_id,
            body,
            format="markdown",
            mentions=mentions,
            thread_root_id=thread_root_id,
            extra_content=admin_extra_content(message_type),
        )

    def _sender_handle(self, event: InboundMessage) -> str:
        """The @-handle to tag the message sender with.

        Prefers the bridge-provided `sender_name` (the external username, which
        the collaboration bridge rewrites into a real @mention on Slack /
        Mattermost); falls back to the mxid localpart for a native Matrix user
        (paired with `mentions=[event.sender]` so Matrix renders a pill).
        """
        content = event.content
        name = content.get("sender_name")
        if name:
            return str(name)
        return str(event.sender).split(":")[0].lstrip("@")

    async def _resolve_room_meta(self, matrix_room_id: str) -> RoomMeta | None:
        if matrix_room_id in self._room_meta_cache:
            return self._room_meta_cache[matrix_room_id]
        async with tenant_session(self.session_factory, self.tenant_id) as session:
            room = await self._room_store.get_by_matrix_room_id(session, matrix_room_id)
        if room is None:
            logger.error("Room not found for matrix room ID: %s", matrix_room_id)
            self._room_meta_cache[matrix_room_id] = None
            return None
        meta = RoomMeta(
            room_id=room.id,
            name=room.name,
            bridge_id=room.bridge_id,
            channel_type=room.channel_type,
        )
        self._room_meta_cache[matrix_room_id] = meta
        return meta

    async def _is_direct_room(self, matrix_room_id: str) -> bool:
        meta = await self._resolve_room_meta(matrix_room_id)
        return meta is not None and meta.channel_type == "direct"
