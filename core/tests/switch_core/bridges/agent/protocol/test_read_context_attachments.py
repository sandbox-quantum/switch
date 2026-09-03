from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.transport import (
    HistoryPage,
    InboundEvent,
    InboundMedia,
    InboundMessage,
)
from tests.switch_core.transport.fake import FakeTransport


def _image_event() -> InboundMedia:
    content = {
        "msgtype": "m.image",
        "body": "what's this?",
        "filename": "cat.png",
        "url": "mxc://s/abc",
        "info": {"mimetype": "image/png", "size": 1234},
        "sender_name": "Alice",
    }
    return InboundMedia(
        room_id="!room",
        event_id="$img",
        sender="@alice:s",
        timestamp=1700000000000,
        content=content,
        body="what's this?",
        sender_name="Alice",
        msgtype="m.image",
        uri="mxc://s/abc",
        filename="cat.png",
        mimetype="image/png",
        size=1234,
    )


def _text_event() -> InboundMessage:
    content = {"msgtype": "m.text", "body": "hello", "sender_name": "Bob"}
    return InboundMessage(
        room_id="!room",
        event_id="$txt",
        sender="@bob:s",
        timestamp=1700000001000,
        content=content,
        body="hello",
        sender_name="Bob",
    )


def _build_service(chunk: list[InboundEvent]) -> ProtocolService:
    # No continuation token: this page is the start of the room.
    transport = FakeTransport(history=HistoryPage(events=list(chunk), next_token=None))
    fake_client = SimpleNamespace(transport=transport)

    async def _require(agent_id: str, room_id: str):
        return SimpleNamespace(matrix_room_id="!room")

    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.require_room_member = _require  # type: ignore[assignment]
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_agent_id=lambda agent_id: fake_client
    )
    return svc


async def test_image_event_carries_attachment() -> None:
    svc = _build_service([_image_event()])

    # read_context returns thread groups; a standalone message is its own root.
    groups = (await svc.read_context("agent-1", "room-1"))["threads"]

    assert len(groups) == 1
    root = groups[0]["root"]
    assert root["body"] == "what's this?"
    assert root["attachments"] == [
        {
            "filename": "cat.png",
            "mimetype": "image/png",
            "size": 1234,
            "mxc": "mxc://s/abc",
            "msgtype": "m.image",
        }
    ]


async def test_text_event_has_empty_attachments() -> None:
    svc = _build_service([_text_event()])

    groups = (await svc.read_context("agent-1", "room-1"))["threads"]

    assert len(groups) == 1
    root = groups[0]["root"]
    assert root["body"] == "hello"
    assert root["attachments"] == []
