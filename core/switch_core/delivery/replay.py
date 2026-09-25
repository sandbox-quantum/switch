import logging
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import NoReturn, cast

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.attachments import parse_attachment_group
from switch_core.bridges.agent.protocol.event_buffer import (
    DEFAULT_RETENTION_SECONDS,
    BufferedEvent,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, AttachmentRef
from switch_core.clients.admin_messages import platform_replies_in_channel
from switch_core.db.models import Agent, Client, ClientRoom, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver, IncomingMessage
from switch_core.delivery.message_payload import message_payload
from switch_core.transport import InboundMedia, InboundMessage
from switch_core.transport.stored_event import to_inbound

logger = logging.getLogger(__name__)


class RoomReplayUnavailable(Exception):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code


async def replay_room_event(
    db: AsyncSession,
    agent: Agent,
    room: Room,
    message_id: str,
    sequence: int,
    now: datetime,
    live_agent_ids: Callable[[], set[str]],
) -> BufferedEvent:
    def refuse(code: str, reason: str) -> NoReturn:
        logger.warning(
            "Room replay refused for agent %s, room %s, message %s: %s",
            agent.id,
            room.id,
            message_id,
            reason,
        )
        raise RoomReplayUnavailable(code, reason)

    store = MessageStore()
    row = await store.get_by_transport_event_id(db, message_id)
    client = await db.get(Client, agent.client_id)
    membership = await db.get(ClientRoom, (agent.client_id, room.id))
    if row is None or client is None:
        refuse("ROOM_EVENT_UNAVAILABLE", "The stored room message is unavailable.")
    if row.room_id != room.id:
        refuse("ROOM_REPLAY_REFUSED", "The stored message belongs to another room.")
    if row.seq <= 0:
        refuse(
            "ROOM_REPLAY_REFUSED", "Historical messages cannot be submitted for replay."
        )
    if row.sender_id == client.matrix_user_id:
        refuse("ROOM_REPLAY_REFUSED", "An agent cannot replay its own message.")
    if cast(datetime, row.sent_at) < now - timedelta(seconds=DEFAULT_RETENTION_SECONDS):
        refuse(
            "ROOM_EVENT_UNAVAILABLE",
            "The stored message is outside the replay retention window.",
        )
    if cast(datetime, row.sent_at) > now:
        refuse("ROOM_REPLAY_REFUSED", "The stored message has a future timestamp.")
    if membership is None or cast(datetime, row.sent_at) < cast(
        datetime, membership.joined_at
    ):
        refuse(
            "ROOM_EVENT_UNAVAILABLE",
            "The message predates the agent's membership in this room.",
        )
    if room.archived_at is not None:
        refuse("ROOM_REPLAY_REFUSED", "The room is archived.")
    group = parse_attachment_group(row.content)
    if group is not None and group[2] > 1:
        refuse(
            "ROOM_EVENT_UNAVAILABLE",
            "This multi-file message could not be reconstructed after a server restart. Please send it again.",
        )
    files = (await store.attachments_for(db, [row.id])).get(row.id, [])
    event = to_inbound(row, files, transport_room_id=room.matrix_room_id)
    if not isinstance(event, InboundMessage):
        refuse("ROOM_REPLAY_REFUSED", "The stored event is not a room message.")
    addressing = AddressingResolver(
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        client_store=ClientStore(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
        live_agent_ids=live_agent_ids,
    )
    incoming = IncomingMessage(
        sender=event.sender,
        body=event.body,
        formatted_body=event.formatted_body,
        content=event.content,
    )
    if not await addressing.addresses(
        db,
        agent=agent,
        agent_matrix_id=client.matrix_user_id,
        room_id=room.id,
        channel_type=room.channel_type,
        message=incoming,
    ):
        refuse("ROOM_REPLAY_REFUSED", "The stored message does not address this agent.")
    if not (
        await addressing.permitted(
            db, agent=agent, room_id=room.id, sender=event.sender, content=event.content
        )
    ).allowed:
        refuse(
            "ROOM_REPLAY_REFUSED", "The sender is not permitted to address this agent."
        )
    payload = message_payload(
        event,
        addressed=True,
        body=event.body,
        sender_name=event.sender_name or event.sender,
        thread_id=None
        if not isinstance(event, InboundMedia)
        and platform_replies_in_channel(event.content)
        else event.thread_root_id,
        attachments=[
            AttachmentRef(
                mxc=file.uri,
                filename=file.filename or event.body,
                mimetype=file.mimetype or "",
                size=file.size or 0,
                msgtype=row.msgtype or "m.file",
            )
            for file in files
        ],
    )
    return BufferedEvent(
        seq=sequence,
        room_id=room.id,
        event=AgentEvent(
            type="message",
            room_id=room.id,
            bridge_id=room.bridge_id,
            channel_type=room.channel_type,
            payload=payload,
        ),
        notifiable=True,
        appended_at=time.monotonic(),
    )
