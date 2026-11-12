from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import (
    Attachment,
    BridgeOperationError,
    InboundCommand,
)
from switch_core.bridges.collaboration.webex.adapter import WebexAdapter
from switch_core.transport.types import TransportError

from .test_bridge_inbound_media import _fake_bridge, _msg
from .test_webex_adapter import config


@pytest.mark.parametrize("kind", ["text", "file", "join", "command"])
@pytest.mark.parametrize("confirmed", [False, True])
async def test_failed_room_delivery_is_not_confirmed(
    kind: str, confirmed: bool
) -> None:
    bridge = _fake_bridge()
    if confirmed:
        bridge._adapter = WebexAdapter(config=config())
    message = _msg(content="A message to relay")
    if kind == "text":
        bridge.human_actor.send_message = AsyncMock(return_value=None)
    elif kind == "file":
        bridge.human_actor.send_media = AsyncMock(return_value=None)
        message = _msg(
            attachments=[
                Attachment(
                    filename="note.txt", mimetype="text/plain", data=b"file bytes"
                )
            ]
        )
    elif kind == "join":
        bridge._ensure_human_in_room = AsyncMock(return_value=None)
    else:
        bridge.human_actor.send_event = AsyncMock(
            side_effect=TransportError("Room is unavailable")
        )
        bridge._event_for_external_post = AsyncMock(return_value=None)

    async def deliver() -> None:
        if kind == "command":
            await CollaborationCore._handle_inbound_command(
                bridge,
                InboundCommand(
                    channel_id="chan-1",
                    channel_type="group",
                    sender_id="person",
                    sender_name="Member",
                    command="help",
                    args="",
                    message_ref="command",
                ),
            )
        else:
            await CollaborationCore._handle_inbound_message(bridge, message)

    if confirmed:
        with pytest.raises(
            TransportError if kind == "command" else BridgeOperationError
        ):
            await deliver()
    else:
        await deliver()
    assert bridge.recorded == []
