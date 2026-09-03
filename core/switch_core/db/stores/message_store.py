from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Message, MessageAttachment


class MessageStore:
    async def create(
        self,
        session: AsyncSession,
        message: Message,
        attachments: list[MessageAttachment],
    ) -> Message:
        """Persist a message and its files as one unit.

        Attachments are numbered by their order in the list, which is the order
        they were sent in.
        """
        session.add(message)
        await session.flush()
        for position, attachment in enumerate(attachments):
            attachment.message_id = message.id
            attachment.position = position
            session.add(attachment)
        await session.flush()
        return message

    async def get_by_transport_event_id(
        self, session: AsyncSession, transport_event_id: str
    ) -> Message | None:
        result = await session.execute(
            select(Message).where(Message.transport_event_id == transport_event_id)
        )
        return result.scalar_one_or_none()

    async def list_for_room(
        self, session: AsyncSession, room_id: str, *, after_seq: int, limit: int
    ) -> list[Message]:
        """Oldest first, from just after `after_seq`.

        Paging on `seq` rather than a timestamp keeps the cursor exact: it is a
        total order with no ties, so no row can be skipped or repeated between
        pages.
        """
        result = await session.execute(
            select(Message)
            .where(Message.room_id == room_id, Message.seq > after_seq)
            .order_by(Message.seq)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_attachments(
        self, session: AsyncSession, message_id: str
    ) -> list[MessageAttachment]:
        result = await session.execute(
            select(MessageAttachment)
            .where(MessageAttachment.message_id == message_id)
            .order_by(MessageAttachment.position)
        )
        return list(result.scalars().all())
