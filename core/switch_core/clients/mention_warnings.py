"""The admin's heads-up for a message that tags something that cannot answer:
a room role nobody live-holds, or an agent that is not in the room.

The router posts them once a message has committed, on whichever process
wrote it (`delivery/router.py`), and only for a message that tags a name
that is none of the room's agents (`unmatched_mentions`). Deciding the
message has read the room's agents already, so a message that tags only them
costs nothing here; one that tags anything else costs what it always did.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_display_name import agent_label_with_identifier
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.clients.mentions import (
    mention_regex,
    strip_emphasis,
    unique_mention_tokens,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_wide_mention import is_reserved_mention_name
from switch_core.transport import InboundMessage, RoomRef


def unmatched_mentions(body: str, names: Iterable[str]) -> list[str]:
    """The names `body` tags that are none of `names` (the room's agents'
    names and aliases) and no room-wide mention word, compared without case,
    each once."""
    known = {name.lower() for name in names}
    return [
        token
        for token in unique_mention_tokens(body)
        if token.lower() not in known and not is_reserved_mention_name(token)
    ]


class MentionWarnings:
    def __init__(
        self,
        *,
        actor: SystemActor,
        tenant_id: str,
        session_factory: async_sessionmaker[AsyncSession],
        connections: AgentConnectionRegistry,
        room_store: RoomStore,
        room_role_store: RoomRoleStore,
        agent_store: AgentStore,
    ) -> None:
        self.actor = actor
        self.tenant_id = tenant_id
        self.session_factory = session_factory
        self._connections = connections
        self._room_store = room_store
        self._room_role_store = room_role_store
        self._agent_store = agent_store

    async def check(
        self,
        room: RoomRef,
        event: InboundMessage,
        room_id: str,
        member_ids: set[str],
    ) -> None:
        """Both warnings for `event`, in the thread it starts or is in.
        `member_ids` are the room's agents as the router read them."""
        thread_id = event.thread_root_id
        thread_root = thread_id if thread_id is not None else event.event_id
        await self._warn_unreachable_roles(room, event, room_id, thread_root)
        await self._warn_absent_agents(room, event, room_id, thread_root, member_ids)

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
        async with tenant_session(self.session_factory, self.tenant_id) as session:
            roles = await self._room_role_store.list_roles(session, room_id)
            for role in roles:
                if mention_regex(role.name).search(strip_emphasis(body)) is None:
                    continue
                if not await self._room_role_store.has_live_holder(
                    session, role.id, self._connections.live_connection_ids()
                ):
                    unreachable.append(role.name)
        handle = self._sender_handle(event)
        for name in unreachable:
            notice = (
                f"⚠️ @{handle} no agent currently holds the **{name}** role — "
                f"your message may go unanswered. Run `!roles` to see "
                f"availability, or have an agent assume it."
            )
            await self.actor.send_admin(
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
        member_ids: set[str] | None = None,
    ) -> None:
        """Warn when a tagged agent is not a member of the room.

        An `@name` that resolves to a registered agent which is not in this room
        routes to nobody, so the admin posts a heads-up in the triggering
        message's thread naming the absent agent(s). Tokens that map to a
        room-role (handled by `_warn_unreachable_roles`), to a current member,
        to no agent at all (a human user or a typo), or that is a room-wide
        mention word (`@everyone` pages the room's people) are ignored.
        `member_ids` are the room's agents when the caller has read them.
        """
        body = getattr(event, "body", "") or ""
        if "@" not in body:
            return
        tokens = unique_mention_tokens(body)
        if not tokens:
            return
        absent: list[str] = []
        async with tenant_session(self.session_factory, self.tenant_id) as session:
            if member_ids is None:
                member_ids = set(await self._room_store.get_agent_ids(session, room_id))
            role_names = {
                role.name.lower()
                for role in await self._room_role_store.list_roles(session, room_id)
            }
            for token in tokens:
                if token.lower() in role_names or is_reserved_mention_name(token):
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
        await self.actor.send_admin(
            room.room_id,
            notice,
            message_type=AdminMessageType.ABSENT_AGENT,
            thread_root_id=thread_id,
            mentions=[event.sender],
        )

    def _sender_handle(self, event: InboundMessage) -> str:
        """The @-handle to tag the message sender with.

        Prefers the bridge-provided `sender_name` (the external username, which
        the collaboration bridge rewrites into a real @mention on Slack /
        Mattermost); falls back to the participant id's localpart for a client with no
        bridge-provided name (paired with `mentions=[event.sender]` so the
        mention renders as a pill).
        """
        content = event.content
        name = content.get("sender_name")
        if name:
            return str(name)
        return str(event.sender).split(":")[0].lstrip("@")
