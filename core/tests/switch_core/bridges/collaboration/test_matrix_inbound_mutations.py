from __future__ import annotations

from contextlib import asynccontextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import (
    InboundMessageDelete,
    InboundMessageEdit,
)
from switch_core.transport import InboundCustomEvent
from switch_core.transport import InboundMessage as TransportMessage
from switch_core.transport.types import RoomRef

CHANNEL = "!matrix:example.org"
SWITCH_ROOM = "!switch:internal"
TRANSPORT_ROOM = "!switch:transport"
EXTERNAL_MESSAGE = "$external"
SWITCH_MESSAGE = "$switch"


class _MapStore:
    async def get_by_external_post_id(
        self, session: object, bridge_id: str, external_post_id: str
    ) -> SimpleNamespace:
        assert external_post_id == EXTERNAL_MESSAGE
        return SimpleNamespace(transport_event_id=SWITCH_MESSAGE)


def _core() -> tuple[CollaborationCore, AsyncMock]:
    core = object.__new__(CollaborationCore)
    core._bridge_id = "bridge"
    core._channel_to_room = {CHANNEL: (SWITCH_ROOM, TRANSPORT_ROOM)}
    core._bridge_message_map_store = _MapStore()

    @asynccontextmanager
    async def session_factory():
        yield object()

    core._session_factory = session_factory
    actor = SimpleNamespace(client_id="human-client", send_event=AsyncMock())

    async def ensure_human(**kwargs: object) -> SimpleNamespace:
        assert kwargs["room_id"] == SWITCH_ROOM
        assert kwargs["transport_room_id"] == TRANSPORT_ROOM
        return actor

    core._ensure_human_in_room = ensure_human
    core._adapter = SimpleNamespace(translate_inbound=lambda text: text)
    return core, actor.send_event


async def test_matrix_edits_are_written_as_replacements_through_transport() -> None:
    core, send_event = _core()

    await core._handle_inbound_edit(
        InboundMessageEdit(
            channel_id=CHANNEL,
            sender_id="@alice:example.org",
            sender_name="Alice",
            message_ref=EXTERNAL_MESSAGE,
            edit_ref="$edit",
            content="updated",
        )
    )

    send_event.assert_awaited_once()
    args = send_event.await_args.args
    assert args[:2] == (TRANSPORT_ROOM, "m.room.message")
    assert args[2]["m.relates_to"] == {
        "rel_type": "m.replace",
        "event_id": SWITCH_MESSAGE,
    }
    assert args[2]["m.new_content"]["body"] == "updated"


async def test_matrix_deletes_are_written_as_replacement_tombstones() -> None:
    core, send_event = _core()

    await core._handle_inbound_delete(
        InboundMessageDelete(
            channel_id=CHANNEL,
            sender_id="@alice:example.org",
            sender_name="Alice",
            message_ref=EXTERNAL_MESSAGE,
            delete_ref="$redaction",
        )
    )

    send_event.assert_awaited_once()
    content = send_event.await_args.args[2]
    assert content["m.relates_to"]["event_id"] == SWITCH_MESSAGE
    assert content["m.new_content"]["body"] == "[message deleted]"


async def test_switch_message_edits_update_the_mapped_matrix_post() -> None:
    core, _send_event = _core()
    update = AsyncMock()
    core._channel_for_room = AsyncMock(return_value=CHANNEL)
    core._external_post_for_event = AsyncMock(return_value=EXTERNAL_MESSAGE)
    core._room_tenant = AsyncMock(return_value="tenant")
    core._counted_outbound = lambda _kind: nullcontext()
    core._adapter = SimpleNamespace(
        update_message=update,
        translate_outbound=lambda text: text,
    )

    await core.handle_outbound_message(
        RoomRef(room_id=TRANSPORT_ROOM),
        TransportMessage(
            room_id=TRANSPORT_ROOM,
            event_id="$edit-event",
            sender="@agent:internal",
            timestamp=0,
            content={
                "m.relates_to": {
                    "rel_type": "m.replace",
                    "event_id": SWITCH_MESSAGE,
                },
                "m.new_content": {"body": "edited from Switch"},
            },
            body="* edited from Switch",
        ),
    )

    update.assert_awaited_once_with(CHANNEL, EXTERNAL_MESSAGE, "edited from Switch")


async def test_switch_redactions_delete_the_mapped_matrix_post() -> None:
    core, _send_event = _core()
    delete = AsyncMock()
    core._channel_for_room = AsyncMock(return_value=CHANNEL)
    core._external_post_for_event = AsyncMock(return_value=EXTERNAL_MESSAGE)
    core._room_tenant = AsyncMock(return_value="tenant")
    core._counted_outbound = lambda _kind: nullcontext()
    core._adapter = SimpleNamespace(delete_message=delete)

    await core.handle_outbound_delete(
        RoomRef(room_id=TRANSPORT_ROOM),
        InboundCustomEvent(
            room_id=TRANSPORT_ROOM,
            event_id="$redaction-event",
            sender="@agent:internal",
            timestamp=0,
            content={"redacts": SWITCH_MESSAGE},
            event_type="m.room.redaction",
        ),
    )

    delete.assert_awaited_once_with(CHANNEL, EXTERNAL_MESSAGE)
