"""Records into Postgres what was sent over the transport.

The transport remains the source of truth for history; these rows are a
parallel record that a later change reads from instead. Recording happens
after the send has been accepted, so the database never delays or blocks
delivery.

That ordering has a consequence worth stating rather than hiding: a failure
here leaves a row missing for a message that was really delivered. The
alternative — failing the send because the database is unhappy — would make
messaging less reliable than it is today, which is not a trade this step is
willing to make. Failures are logged at error, never swallowed silently, and
reconciling the two records is part of moving the read path over.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from switch_core.db.models import Message, MessageAttachment
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.transport import SendResult

logger = logging.getLogger(__name__)


class MessageRecorder:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        room_store: RoomStore,
        message_store: MessageStore,
    ) -> None:
        self._session_factory = session_factory
        self._room_store = room_store
        self._message_store = message_store
        # A room's transport id never changes, so this only ever grows and
        # never goes stale.
        self._room_ids: dict[str, str] = {}

    async def record(
        self,
        *,
        transport_room_id: str,
        result: SendResult,
        sender_matrix_id: str,
        sender_client_id: str,
        sender_name: str,
    ) -> None:
        try:
            await self._record(
                transport_room_id=transport_room_id,
                result=result,
                sender_matrix_id=sender_matrix_id,
                sender_client_id=sender_client_id,
                sender_name=sender_name,
            )
        except Exception:
            logger.error(
                "Delivered %s to %s but failed to record it as %s",
                result.event_type,
                transport_room_id,
                result.event_id,
                exc_info=True,
            )

    async def _record(
        self,
        *,
        transport_room_id: str,
        result: SendResult,
        sender_matrix_id: str,
        sender_client_id: str,
        sender_name: str,
    ) -> None:
        async with self._session_factory() as session:
            room_id = await self._resolve_room(session, transport_room_id)
            if room_id is None:
                logger.warning(
                    "Not recording %s: %s is not a Switch room",
                    result.event_id,
                    transport_room_id,
                )
                return

            content = result.content
            message = Message(
                room_id=room_id,
                transport_event_id=result.event_id,
                sender_matrix_id=sender_matrix_id,
                sender_client_id=sender_client_id,
                sender_name=sender_name,
                event_type=result.event_type,
                msgtype=_text(content.get("msgtype")),
                body=_text(content.get("body")),
                formatted_body=_text(content.get("formatted_body")),
                thread_root_event_id=_thread_root(content),
                content=content,
            )
            await self._message_store.create(session, message, _attachments_in(content))
            await session.commit()

    async def _resolve_room(
        self, session: AsyncSession, transport_room_id: str
    ) -> str | None:
        cached = self._room_ids.get(transport_room_id)
        if cached is not None:
            return cached
        room = await self._room_store.get_by_matrix_room_id(session, transport_room_id)
        if room is None:
            return None
        self._room_ids[transport_room_id] = room.id
        return room.id


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _thread_root(content: dict[str, object]) -> str | None:
    relation = content.get("m.relates_to")
    if not isinstance(relation, dict) or relation.get("rel_type") != "m.thread":
        return None
    return _text(relation.get("event_id"))


def _attachments_in(content: dict[str, object]) -> list[MessageAttachment]:
    """A media event carries exactly one file.

    A message with several files is sent as one event per file sharing a group
    id, so each of those events records a single attachment. The column exists
    as a list because reassembling the group is the reader's job, not the
    writer's.
    """
    uri = _text(content.get("url"))
    if uri is None:
        return []
    info = content.get("info")
    info = info if isinstance(info, dict) else {}
    size = info.get("size")
    return [
        MessageAttachment(
            uri=uri,
            filename=_text(content.get("filename")) or _text(content.get("body")),
            mimetype=_text(info.get("mimetype")),
            size=size if isinstance(size, int) else None,
            position=0,
        )
    ]
