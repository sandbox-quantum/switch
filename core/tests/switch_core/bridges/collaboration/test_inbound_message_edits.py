from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.trust.client import NullTrustClient
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)


async def test_platform_edit_is_validated_translated_and_durably_routed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    author = await make_person(session_factory)
    agent, client = await make_agent(session_factory, "worker")
    await add_member(session_factory, room, author)
    await add_member(session_factory, room, client, agent=agent)
    transport = process.transport(author)
    original = await transport.send_message(
        room.transport_room_id, "@worker Original", sender_name="author", metered=False
    )
    mapping = SimpleNamespace(
        external_channel_id="channel", transport_event_id=original.event_id
    )
    bridge = object.__new__(CollaborationCore)
    bridge._bridge_id = "bridge"
    bridge._session_factory = session_factory
    bridge._channel_to_room = {"channel": (room.id, room.transport_room_id)}
    bridge._human_actors = {"external-author": author.id, "impostor": client.id}
    bridge._bridge_message_map_store = SimpleNamespace(
        get_by_external_post_id=AsyncMock(return_value=mapping)
    )
    bridge._client_lifecycle = SimpleNamespace(
        get=lambda _: SimpleNamespace(send_event=transport.send_event)
    )
    bridge._adapter = SimpleNamespace(
        translate_inbound=lambda text: text.replace("<@worker>", "@worker")
    )
    bridge._trust_client = NullTrustClient()
    msg = InboundMessage(
        channel_id="channel",
        channel_type="channel_public",
        sender_id="external-author",
        sender_name="author",
        message_ref="original-post",
        content="<@worker> Updated",
        edit_revision=20,
    )
    await bridge._handle_inbound_message(msg)
    await bridge._handle_inbound_message(msg)
    await bridge._handle_inbound_message(
        msg.model_copy(update={"sender_id": "impostor"})
    )
    events = await own_events(session_factory, agent.id)
    assert [event.type for event in events] == ["message", "message_edit"]
    assert events[-1].payload["payload"]["body"] == "@worker Updated"
    assert events[-1].payload["payload"]["message_id"] == original.event_id
    mapping.external_channel_id = "another-channel"
    await bridge._handle_inbound_message(msg.model_copy(update={"edit_revision": 30}))
    assert len(await own_events(session_factory, agent.id)) == 2
