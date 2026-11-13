"""What Switch Console is shown of a chat: summaries, messages and members.

Assembled from the database alone, so the HTTP routes and the event stream
describe a room in exactly the same terms.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import and_, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from switch_core.agent_runs import TRACE_OPENING
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.admin_messages import (
    platform_on_behalf_of,
    platform_replies_in_channel,
)
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    ChatRead,
    Client,
    CollaborationBridge,
    Message,
    Room,
    User,
    room_agents,
)
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import (
    MENTIONS_KEY,
    addressable_text,
    named_agents,
)
from switch_core.providers.registry import agent_providers

MESSAGE_EVENT_TYPE = "m.room.message"
COMMAND_EVENT_TYPE = "com.switch.command"
# A room command (`!reset @agent`) is shown, as a system line, so its threaded acknowledgement has a visible root.
SHOWN_EVENT_TYPES = (MESSAGE_EVENT_TYPE, COMMAND_EVENT_TYPE)
PREVIEW_CHARS = 140

_MESSAGE_STORE = MessageStore()
_ROOM_STORE = RoomStore()


def _provider(agent: Agent, defined: object) -> str | None:
    """The provider an agent runs on: its managed definition's, else its registration's."""
    if isinstance(defined, str):
        return defined
    metadata = agent.metadata_ if isinstance(agent.metadata_, dict) else {}
    known = metadata.get("known_agent_type")
    if not isinstance(known, str):
        return None
    return next((p.id for p in agent_providers() if p.known_agent_type == known), None)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ChatAgent(CamelModel):
    id: str
    name: str
    display_name: str | None
    icon_url: str | None
    provider: str | None
    # The name the agent also answers to in this room, if any.
    alias: str | None
    owner_name: str | None
    owned_by_viewer: bool


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
    # The viewer owns one of the agents, which keeps them in the room.
    owns_agent: bool
    # The people in the room, sorted, so any membership change re-sends the summary.
    member_count: int
    member_user_ids: list[str]
    # Shown messages past the viewer's read position, less their own.
    unread_count: int
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


class ChatKickoff(CamelModel):
    """A template's kickoff: the request Switch posts for whoever ran the
    template, so Switch Console can show it as theirs rather than as one of
    Switch's own notices.

    ``agent_id`` is set when an agent ran it (switch-buddy, say), and ``name``
    is then the agent's name; otherwise ``name`` is the person's.
    ``agent_note`` is the run history appended for the agents, split off the
    body so a person need not read it.
    """

    name: str
    agent_id: str | None
    user_id: str
    agent_note: str | None


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
    # The room's agents the body names by @name or @alias. Display only: who
    # a message addresses is each agent's own decision.
    named_agent_ids: list[str]
    # The people the sender named (`mentionUserIds`); they address no agent.
    named_user_ids: list[str]
    mentions: list[ChatMention]
    # Of a thread's root; 0 and None on a reply and on a message with none.
    thread_reply_count: int
    thread_last_reply_seq: int | None
    # Set on a template kickoff's request; None on everything else.
    kickoff: ChatKickoff | None = None


class ChatMention(CamelModel):
    """Where a message names an agent or a person: `offset` and `length` in
    UTF-16 code units of its body, as JavaScript strings count."""

    kind: Literal["agent", "user"]
    id: str
    offset: int
    length: int


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
    session: AsyncSession, room: Room, *, viewer_id: str, can_manage: bool
) -> ChatSummary:
    [summary] = await chat_summaries(
        session, [room], viewer_id=viewer_id, can_manage={room.id: can_manage}
    )
    return summary


async def chat_summaries(
    session: AsyncSession,
    rooms: Sequence[Room],
    *,
    viewer_id: str,
    can_manage: Mapping[str, bool],
) -> list[ChatSummary]:
    """The rooms' summaries for the viewer, in the order given, read with one
    query per kind of fact (agents, providers, bridges, people, unread counts,
    last messages) whatever the number of rooms."""
    if not rooms:
        return []
    room_ids = [room.id for room in rooms]
    agent_rows: dict[str, list[tuple[Agent, str | None, str | None]]] = {}
    for room_id, agent, alias, owner_name in await session.execute(
        select(room_agents.c.room_id, Agent, room_agents.c.alias, User.name)
        .join(room_agents, room_agents.c.agent_id == Agent.id)
        .outerjoin(User, User.id == Agent.owner_id)
        .where(room_agents.c.room_id.in_(room_ids))
        .order_by(Agent.name)
    ):
        agent_rows.setdefault(room_id, []).append((agent, alias, owner_name))
    agent_ids = {agent.id for rows in agent_rows.values() for agent, _, _ in rows}
    providers = (
        {
            definition.agent_id: definition.definition.get("provider")
            for definition in (
                await session.execute(
                    select(AgentDefinition).where(
                        AgentDefinition.agent_id.in_(agent_ids)
                    )
                )
            ).scalars()
        }
        if agent_ids
        else {}
    )
    bridge_ids = {room.bridge_id for room in rooms if room.bridge_id is not None}
    bridges = (
        {
            bridge.id: bridge
            for bridge in (
                await session.execute(
                    select(CollaborationBridge).where(
                        CollaborationBridge.id.in_(bridge_ids)
                    )
                )
            ).scalars()
        }
        if bridge_ids
        else {}
    )
    members = await _ROOM_STORE.member_users_by_room(session, room_ids)
    viewer_client = (
        select(Client.id)
        .where(Client.user_id == viewer_id, Client.type == MEMBER_CLIENT_TYPE)
        .scalar_subquery()
    )
    unread: dict[str, int] = {}
    for room_id, count in await session.execute(
        select(Message.room_id, func.count())
        .select_from(Message)
        .outerjoin(
            ChatRead,
            and_(
                ChatRead.room_id == Message.room_id,
                ChatRead.user_id == viewer_id,
            ),
        )
        .where(
            Message.room_id.in_(room_ids),
            Message.event_type.in_(SHOWN_EVENT_TYPES),
            Message.seq > func.coalesce(ChatRead.read_through_seq, 0),
            Message.sender_client_id.is_distinct_from(viewer_client),
        )
        .group_by(Message.room_id)
    ):
        unread[room_id] = count
    # Per room, back along (room_id, seq) to its newest shown message only.
    last_shown = (
        select(Message)
        .where(
            Message.room_id == Room.id,
            Message.event_type.in_(SHOWN_EVENT_TYPES),
        )
        .order_by(Message.seq.desc())
        .limit(1)
        .lateral()
    )
    last_messages = {
        message.room_id: message
        for message in (
            await session.execute(
                select(aliased(Message, last_shown))
                .select_from(Room)
                .join(last_shown, true())
                .where(Room.id.in_(room_ids))
            )
        ).scalars()
    }
    summaries: list[ChatSummary] = []
    for room in rooms:
        rows = agent_rows.get(room.id, [])
        bridge = bridges.get(room.bridge_id) if room.bridge_id else None
        channel_name: str | None = None
        if bridge is not None and room.external_channel_id is not None:
            prefix = f"{bridge.display_name}: "
            channel_name = (
                room.name[len(prefix) :] if room.name.startswith(prefix) else room.name
            )
        member_user_ids = sorted(user_id for user_id, _ in members.get(room.id, []))
        last = last_messages.get(room.id)
        summaries.append(
            ChatSummary(
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
                        provider=_provider(agent, providers.get(agent.id)),
                        alias=alias,
                        owner_name=owner_name,
                        owned_by_viewer=agent.owner_id == viewer_id,
                    )
                    for agent, alias, owner_name in rows
                ],
                can_manage=can_manage[room.id],
                owns_agent=any(agent.owner_id == viewer_id for agent, _, _ in rows),
                member_count=len(member_user_ids),
                member_user_ids=member_user_ids,
                unread_count=unread.get(room.id, 0),
                last_message=(
                    ChatLastMessage(
                        seq=last.seq,
                        sent_at=_iso(last.sent_at),
                        preview=(last.body or _command_text(last))[:PREVIEW_CHARS],
                        sender_name=last.sender_name or "",
                    )
                    if last is not None
                    else None
                ),
            )
        )
    return summaries


_COMMAND_LINES = {
    "reset": "Context reset requested for {agent}",
    "compact": "Compaction requested for {agent}",
    "interrupt": "Stop requested for {agent}",
    "retry": "Retry requested for {agent}",
}


def _command_text(message: Message) -> str:
    if message.event_type != COMMAND_EVENT_TYPE:
        return ""
    command = message.content.get("command")
    args = message.content.get("args")
    text_args = args if isinstance(args, str) else ""
    target = text_args.split()[0] if text_args.split() else ""
    line = _COMMAND_LINES.get(command) if isinstance(command, str) else None
    if line is not None and target.startswith("@"):
        text = line.format(agent=target[1:])
    elif line is not None and "@" not in text_args:
        # Without an `@` the command addresses every agent in the room.
        text = line.format(agent="everyone")
    else:
        return f"!{command} {args}".strip() if args else f"!{command}"
    return f"{text} by {message.sender_name}" if message.sender_name else text


async def chat_messages(
    session: AsyncSession, room: Room, messages: Sequence[Message]
) -> list[ChatMessage]:
    """`messages` as Switch Console renders them, in the order given.

    Only conversation is shown: a row of any other event type is skipped.
    """
    shown = [m for m in messages if m.event_type in SHOWN_EVENT_TYPES]
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
    names: dict[str, str] = {}
    aliases: dict[str, str] = {}
    for agent_id, name, alias in await session.execute(
        select(Agent.id, Agent.name, room_agents.c.alias)
        .join(room_agents, room_agents.c.agent_id == Agent.id)
        .where(room_agents.c.room_id == room.id)
    ):
        names[agent_id] = name
        if alias:
            aliases[agent_id] = alias
    roots = [m.transport_event_id for m in shown if m.thread_root_event_id is None]
    threads: dict[str, tuple[int, int]] = {}
    if roots:
        for root, count, last in await session.execute(
            select(Message.thread_root_event_id, func.count(), func.max(Message.seq))
            .where(
                Message.room_id == room.id,
                Message.thread_root_event_id.in_(roots),
                Message.event_type.in_(SHOWN_EVENT_TYPES),
            )
            .group_by(Message.thread_root_event_id)
        ):
            threads[root] = (count, last)
    out: list[ChatMessage] = []
    for message in shown:
        client = clients.get(message.sender_client_id or "")
        agent = agents.get(message.sender_client_id or "")
        if message.event_type == COMMAND_EVENT_TYPE:
            kind, source = "system", "switch"
        elif agent is not None:
            kind, source = "agent", "switch"
        elif client is not None and client.type == MEMBER_CLIENT_TYPE:
            kind, source = "human", "console"
        elif client is not None and client.type == "user":
            kind, source = "human", bridge.type if bridge is not None else "switch"
        else:
            kind, source = "system", "switch"
        format_ = message.content.get("format")
        thread = threads.get(message.transport_event_id)
        body = message.body or _command_text(message)
        kickoff = _kickoff(message) if kind == "system" else None
        if kickoff is not None and kickoff.agent_note is not None:
            body = body.split(TRACE_OPENING, 1)[0].rstrip()
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
                body=body,
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
                named_agent_ids=named_agents(
                    names,
                    aliases,
                    addressable_text(message.body or "", message.content),
                ),
                named_user_ids=_named_user_ids(message),
                mentions=_mentions(message),
                thread_reply_count=thread[0] if thread is not None else 0,
                thread_last_reply_seq=thread[1] if thread is not None else None,
                kickoff=kickoff,
            )
        )
    return out


def _kickoff(message: Message) -> ChatKickoff | None:
    """The kickoff a platform message carries, or None. Only the request
    itself counts: it is the one platform message on someone's behalf that
    asks for answers in the channel. Its one-line headline is left a notice."""
    content = message.content or {}
    person = platform_on_behalf_of(content)
    if person is None or not platform_replies_in_channel(content):
        return None
    body = message.body or ""
    _, found, note = body.partition(TRACE_OPENING)
    return ChatKickoff(
        name=person.name,
        agent_id=person.agent_id,
        user_id=person.user_id,
        agent_note=f"{TRACE_OPENING}{note}".strip() if found else None,
    )


def _named_user_ids(message: Message) -> list[str]:
    mentions = message.content.get(MENTIONS_KEY)
    if not isinstance(mentions, dict):
        return []
    return [each for each in mentions.get("user_ids") or [] if isinstance(each, str)]


def _mentions(message: Message) -> list[ChatMention]:
    mentions = message.content.get(MENTIONS_KEY)
    if not isinstance(mentions, dict):
        return []
    return [ChatMention.model_validate(span) for span in mentions.get("spans") or []]
