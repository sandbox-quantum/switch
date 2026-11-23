"""A platform message or command for a frozen or archived room is not
relayed, and its sender is told why (`room_read_only.py`).

The person's writes go through a real transport on the test database, so it
is the router's refusal the bridge answers, not a stand-in for it.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import (
    Attachment,
    InboundCommand,
    InboundMessage,
)
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.db.models import TENANT_ZERO_ID, Client, Message, Room
from switch_core.db.session_scope import tenant_session
from switch_core.trust.client import NullTrustClient
from tests.routing import Process, add_member, make_person, make_room, process_on


class _HumanActor:
    """The person's actor, writing through the process's real transport."""

    def __init__(self, process: Process, client: Client) -> None:
        self.client_id = client.id
        self.transport_user_id = client.transport_user_id
        self._transport = process.transport(client)
        self._name = client.display_name

    async def send_message(self, room_id: str, content: str, **kw: object) -> str:
        result = await self._transport.send_message(
            room_id,
            content,
            sender_name=self._name,
            metered=False,
            format="markdown",
            thread_root_id=None,
            extra_content=kw.get("extra_content"),  # type: ignore[arg-type]
        )
        return result.event_id

    async def upload_media(self, data: bytes, mimetype: str, filename: str) -> str:
        return f"switch-media://{filename}"

    async def send_media(
        self,
        room_id: str,
        uri: str,
        filename: str,
        mimetype: str,
        size: int,
        **kw: object,
    ) -> str:
        result = await self._transport.send_media(
            room_id,
            uri,
            filename,
            mimetype,
            size,
            sender_name=self._name,
            metered=False,
            msgtype="m.image",
            caption=kw.get("caption"),  # type: ignore[arg-type]
            thread_root_id=None,
            group=None,
        )
        return result.event_id

    async def send_event(
        self, room_id: str, event_type: str, content: dict[str, object]
    ) -> str:
        result = await self._transport.send_event(room_id, event_type, content)
        return result.event_id


class _Adapter:
    platform_name = "Fake"
    private_notice_delivery = "in_channel"

    def __init__(self) -> None:
        self.admin_messages: list[tuple[str, str, str]] = []
        self.answers: list[str] = []

    def translate_inbound(self, content: str) -> str:
        return content

    def unlinkable_account_reason(self, _external_user_id: str) -> str | None:
        return None

    async def admin_message(
        self, channel_id: str, body: str, root_or_ref: str | None, *, message_type: str
    ) -> None:
        self.admin_messages.append((channel_id, body, message_type))

    async def answer_command(self, _command: InboundCommand, text: str) -> None:
        self.answers.append(text)


def _bridge(
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    actor: _HumanActor,
    adapter: _Adapter,
) -> SimpleNamespace:
    async def nothing(*_args: object, **_kwargs: object) -> None:
        return None

    async def no(_name: str) -> bool:
        return False

    async def ensure_human_in_room(**_kw: object) -> _HumanActor:
        return actor

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _repair_placeholder_username=nothing,
        _is_registered_agent=no,
        # Hosted agents v2's duplicate-post check: never a copy here.
        _already_handed_in=AsyncMock(return_value=False),
        _ensure_human_in_room=ensure_human_in_room,
        _record_message_map=nothing,
        _event_for_external_post=AsyncMock(return_value=None),
        _adapter=adapter,
        _handle_text_answer=nothing,
        _channel_to_room={"chan-1": (room.id, room.transport_room_id)},
        _channel_locks={},
        _trust_client=NullTrustClient(),
        _session_factory=session_factory,
        _room_tenant=AsyncMock(return_value=TENANT_ZERO_ID),
    )
    bridge._post_sender_notice = lambda msg, body, message_type: (
        CollaborationCore._post_sender_notice(bridge, msg, body, message_type)
    )
    bridge._tell_read_only = lambda msg, refused: CollaborationCore._tell_read_only(
        bridge, msg, refused
    )
    return bridge


def _message(**kw: object) -> InboundMessage:
    fields: dict[str, object] = {
        "channel_id": "chan-1",
        "channel_type": "channel_public",
        "sender_id": "ext-alice",
        "sender_name": "alice",
        "content": "hello",
        "message_ref": "post-1",
        **kw,
    }
    return InboundMessage.model_validate(fields)


async def _rows(
    session_factory: async_sessionmaker[AsyncSession], room: Room
) -> list[Message]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return list(
            await session.scalars(select(Message).where(Message.room_id == room.id))
        )


@pytest.fixture
async def scene(session_factory: async_sessionmaker[AsyncSession]):  # type: ignore[no-untyped-def]
    process = process_on(session_factory)
    room = await make_room(session_factory, "incident")
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    adapter = _Adapter()
    return (
        room,
        adapter,
        _bridge(session_factory, room, _HumanActor(process, alice), adapter),
    )


async def _make(
    session_factory: async_sessionmaker[AsyncSession], room: Room, state: str
) -> None:
    column = "frozen_at" if state == "frozen" else "archived_at"
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(Room).where(Room.id == room.id).values({column: func.now()})
        )
        await session.commit()


@pytest.mark.parametrize("state", ["frozen", "archived"])
async def test_a_message_is_refused_and_its_sender_told(
    session_factory: async_sessionmaker[AsyncSession], scene, state: str
) -> None:  # type: ignore[no-untyped-def]
    room, adapter, bridge = scene
    await _make(session_factory, room, state)

    relayed = await CollaborationCore._handle_inbound_message(bridge, _message())

    assert relayed is None
    assert await _rows(session_factory, room) == []
    [(channel, body, message_type)] = adapter.admin_messages
    assert channel == "chan-1"
    assert message_type == AdminMessageType.ROOM_READ_ONLY.value
    assert "not delivered" in body
    assert state in body


async def test_a_message_with_files_is_refused(
    session_factory: async_sessionmaker[AsyncSession], scene
) -> None:  # type: ignore[no-untyped-def]
    room, adapter, bridge = scene
    await _make(session_factory, room, "frozen")

    relayed = await CollaborationCore._handle_inbound_message(
        bridge,
        _message(
            attachments=[
                Attachment(data=b"png", filename="a.png", mimetype="image/png")
            ]
        ),
    )

    assert relayed is None
    assert await _rows(session_factory, room) == []
    assert len(adapter.admin_messages) == 1


async def test_a_command_is_refused_and_its_sender_answered(
    session_factory: async_sessionmaker[AsyncSession], scene
) -> None:  # type: ignore[no-untyped-def]
    room, adapter, bridge = scene
    await _make(session_factory, room, "frozen")

    await CollaborationCore._handle_inbound_command(
        bridge,
        InboundCommand(
            channel_id="chan-1",
            channel_type="channel_public",
            sender_id="ext-alice",
            sender_name="alice",
            command="help",
            args="",
            message_ref="post-2",
        ),
    )

    assert await _rows(session_factory, room) == []
    [answer] = adapter.answers
    assert "frozen" in answer


async def test_an_unfrozen_room_relays_again(
    session_factory: async_sessionmaker[AsyncSession], scene
) -> None:  # type: ignore[no-untyped-def]
    room, adapter, bridge = scene
    await _make(session_factory, room, "frozen")
    assert await CollaborationCore._handle_inbound_message(bridge, _message()) is None
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(Room).where(Room.id == room.id).values(frozen_at=None)
        )
        await session.commit()

    relayed = await CollaborationCore._handle_inbound_message(
        bridge, _message(message_ref="post-3")
    )

    assert relayed is not None
    assert [row.body for row in await _rows(session_factory, room)] == ["hello"]
