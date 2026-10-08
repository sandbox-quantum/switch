"""What Switch Console is shown of a chat: summaries, messages and members.

Assembled from the database alone, so the HTTP routes and the event stream
describe a room in exactly the same terms.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    Client,
    CollaborationBridge,
    Message,
    Room,
    room_agents,
)
from switch_core.db.stores.message_store import MessageStore

MESSAGE_EVENT_TYPE = "m.room.message"
PREVIEW_CHARS = 140

_MESSAGE_STORE = MessageStore()


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ChatAgent(CamelModel):
    id: str
    name: str
    display_name: str | None
    icon_url: str | None
    provider: str | None


class ChatLastMessage(CamelModel):
    seq: int
    sent_at: str
    preview: str
    sender_name: str


class ChatSummary(CamelModel):
    room_id: str
    name: str
    channel_type: str
    bridge_type: str | None
    channel_name: str | None
    agents: list[ChatAgent]
    can_manage: bool
    last_message: ChatLastMessage | None


class ChatSender(CamelModel):
    client_id: str
    name: str
    kind: str
    agent_id: str | None
    user_id: str | None


class ChatAttachment(CamelModel):
    uri: str
    filename: str
    mimetype: str
    size: int
    msgtype: str


class ChatMessage(CamelModel):
    message_id: str
    seq: int
    room_id: str
    sent_at: str
    sender: ChatSender
    source: str
    body: str
    format: str | None
    thread_root_id: str | None
    attachments: list[ChatAttachment]
    client_txn: str | None


class ChatMember(CamelModel):
    user_id: str
    name: str
    is_owner: bool


def _iso(value: object) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value)


async def _bridge(session: AsyncSession, room: Room) -> CollaborationBridge | None:
    if room.bridge_id is None:
        return None
    return await session.get(CollaborationBridge, room.bridge_id)


async def chat_summary(
    session: AsyncSession, room: Room, *, can_manage: bool
) -> ChatSummary:
    agent_rows = (
        await session.execute(
            select(Agent)
            .join(room_agents, room_agents.c.agent_id == Agent.id)
            .where(room_agents.c.room_id == room.id)
            .order_by(Agent.name)
        )
    ).scalars()
    agents = list(agent_rows)
    providers = {
        definition.agent_id: definition.definition.get("provider")
        for definition in (
            await session.execute(
                select(AgentDefinition).where(
                    AgentDefinition.agent_id.in_([agent.id for agent in agents])
                )
            )
        ).scalars()
    }
    bridge = await _bridge(session, room)
    channel_name: str | None = None
    if bridge is not None and room.external_channel_id is not None:
        prefix = f"{bridge.display_name}: "
        channel_name = (
            room.name[len(prefix) :] if room.name.startswith(prefix) else room.name
        )
    last = (
        await session.execute(
            select(Message)
            .where(Message.room_id == room.id, Message.event_type == MESSAGE_EVENT_TYPE)
            .order_by(Message.seq.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return ChatSummary(
        room_id=room.id,
        name=room.name,
        channel_type=room.channel_type or "channel_public",
        bridge_type=bridge.type if bridge is not None else None,
        channel_name=channel_name,
        agents=[
            ChatAgent(
                id=agent.id,
                name=agent.name,
                display_name=agent.display_name,
                icon_url=agent.icon_url,
                provider=(
                    provider
                    if isinstance(provider := providers.get(agent.id), str)
                    else None
                ),
            )
            for agent in agents
        ],
        can_manage=can_manage,
        last_message=(
            ChatLastMessage(
                seq=last.seq,
                sent_at=_iso(last.sent_at),
                preview=(last.body or "")[:PREVIEW_CHARS],
                sender_name=last.sender_name or "",
            )
            if last is not None
            else None
        ),
    )


async def chat_messages(
    session: AsyncSession, room: Room, messages: Sequence[Message]
) -> list[ChatMessage]:
    """`messages` as Switch Console renders them, in the order given.

    Only conversation is shown: a row of any other event type is skipped.
    """
    shown = [m for m in messages if m.event_type == MESSAGE_EVENT_TYPE]
    client_ids = {m.sender_client_id for m in shown if m.sender_client_id}
    clients = {
        client.id: client
        for client in (
            await session.execute(select(Client).where(Client.id.in_(client_ids)))
        ).scalars()
    }
    agents = {
        agent.client_id: agent
        for agent in (
            await session.execute(select(Agent).where(Agent.client_id.in_(client_ids)))
        ).scalars()
    }
    bridge = await _bridge(session, room)
    attachments = await _MESSAGE_STORE.attachments_for(session, [m.id for m in shown])
    out: list[ChatMessage] = []
    for message in shown:
        client = clients.get(message.sender_client_id or "")
        agent = agents.get(message.sender_client_id or "")
        if agent is not None:
            kind, source = "agent", "switch"
        elif client is not None and client.type == MEMBER_CLIENT_TYPE:
            kind, source = "human", "console"
        elif client is not None and client.type == "user":
            kind, source = "human", bridge.type if bridge is not None else "switch"
        else:
            kind, source = "system", "switch"
        format_ = message.content.get("format")
        out.append(
            ChatMessage(
                message_id=message.transport_event_id,
                seq=message.seq,
                room_id=room.id,
                sent_at=_iso(message.sent_at),
                sender=ChatSender(
                    client_id=message.sender_client_id or "",
                    name=message.sender_name
                    or (client.display_name if client is not None else ""),
                    kind=kind,
                    agent_id=agent.id if agent is not None else None,
                    user_id=client.user_id if client is not None else None,
                ),
                source=source,
                body=message.body or "",
                format=format_ if isinstance(format_, str) else None,
                thread_root_id=message.thread_root_event_id,
                attachments=[
                    ChatAttachment(
                        uri=attachment.uri,
                        filename=attachment.filename or "",
                        mimetype=attachment.mimetype or "application/octet-stream",
                        size=attachment.size or 0,
                        msgtype=message.msgtype or "m.file",
                    )
                    for attachment in attachments.get(message.id, [])
                ],
                client_txn=message.client_txn_id,
            )
        )
    return out
