"""Following a messaging platform when what was written there is taken back.

A person who deletes their post on a bridged platform has deleted the room's
copy too: Switch keeps no message its author has withdrawn where they wrote
it. An edit replaces the copy's words, and a channel deleted on the platform
takes every message of its room with it. `docs/design/data-retention.md` has
the rules; `CollaborationCore` decides when they apply.

Each deletion takes what is derived from the messages with them, as retention
and erasing a person do: the record of which platform post carried each, the
copies stored as agents' own events, a question still waiting for the
decision service, a multi-file post still assembling, and the stored files
nothing else refers to. The files go at once rather than at the next hourly
sweep: they are known to have been attached to the deleted messages, so none
is an upload still waiting for its message.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import parse_attachment_group
from switch_core.db.models import Message
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.message_store import DeletedMessages, MessageStore
from switch_core.db.stores.retention_store import RetentionStore

logger = logging.getLogger(__name__)

#: Messages deleted per transaction when a whole room's go. Far above the
#: number of files one post can carry, so one post is always one batch.
DELETE_BATCH = 1000


class PlatformDeletions:
    def __init__(self) -> None:
        self._messages = MessageStore()
        self._retention = RetentionStore()
        self._mappings = BridgeMessageMapStore()
        self._external_users = ExternalUserStore()

    async def find_post(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        room_id: str,
        external_post_id: str,
    ) -> Message | None:
        """The room message a person wrote on the platform as
        `external_post_id`, or None when there is none.

        None too for a post that carries a message written in Switch: an
        agent's reply the bridge posted, or a card. Switch's copy is the
        original there, and the bridge deletes its own posts too (a typing
        notice, an answered card), which the platform reports like any other
        deletion. Only what was written on this platform follows it."""
        mapping = await self._mappings.get_by_external_post_id(
            session, bridge_id, external_post_id
        )
        if mapping is None:
            return None
        message = await self._messages.get_by_transport_event_id(
            session, mapping.transport_event_id
        )
        if message is None or message.room_id != room_id:
            return None
        if not await self._external_users.is_bridge_user(
            session, bridge_id, message.sender_id
        ):
            return None
        return message

    async def delete_post(
        self, session: AsyncSession, message: Message
    ) -> DeletedMessages:
        """Delete `message`, every other file of the post it belongs to, and
        what is derived from them, in the caller's transaction."""
        deleted = await self._messages.delete_posts(
            session, message.room_id, [message.transport_event_id], limit=DELETE_BATCH
        )
        await self._delete_derived(session, deleted)
        return deleted

    async def replace_text(
        self, session: AsyncSession, message: Message, body: str, *, edited_at_ms: int
    ) -> None:
        """Make `message` and the agents' copies of it say `body`, in the
        caller's transaction."""
        await self._messages.replace_body(
            session, message, body, edited_at_ms=edited_at_ms
        )
        group = parse_attachment_group(message.content)
        await self._retention.replace_agent_copy_bodies(
            session,
            group[0] if group is not None else message.transport_event_id,
            message.body or "",
        )

    async def delete_room_messages(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        tenant_id: str,
        room_id: str,
    ) -> int:
        """Delete every message in `room_id` and what is derived from them,
        `DELETE_BATCH` at a time, each batch in its own transaction so a long
        room never holds a long lock. Returns how many were deleted."""
        total = 0
        while True:
            async with tenant_session(session_factory, tenant_id) as db, db.begin():
                batch = await self._messages.delete_room_messages(
                    db, room_id, limit=DELETE_BATCH
                )
                await self._delete_derived(db, batch)
            total += len(batch.event_ids)
            if len(batch.event_ids) < DELETE_BATCH:
                return total

    async def _delete_derived(
        self, session: AsyncSession, deleted: DeletedMessages
    ) -> None:
        if not deleted.event_ids:
            return
        keys = {*deleted.event_ids, *deleted.message_keys}
        await self._retention.delete_bridge_mappings(session, deleted.event_ids)
        await self._retention.delete_agent_copies(session, deleted.message_keys)
        await self._retention.delete_pending_decisions(session, keys)
        await self._retention.delete_pending_attachment_groups(
            session, deleted.room_ids, deleted.message_keys
        )
        await self._retention.delete_unreferenced_files(session, deleted.uris)
