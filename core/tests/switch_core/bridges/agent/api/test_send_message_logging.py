import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import send_message
from switch_core.bridges.agent.api.schemas import SendMessageRequest


@pytest.mark.parametrize(
    "body, fails", [("private message", False), ("", False), ("private message", True)]
)
async def test_send_message_logging(
    body: str, fails: bool, caplog: pytest.LogCaptureFixture
) -> None:
    agent = SimpleNamespace(id="agent-1", name="local")
    request = SendMessageRequest(room_id="room-1", content=body)
    protocol = AsyncMock()
    caplog.set_level(logging.DEBUG, logger=send_message.__module__)

    if fails:
        protocol.send_message.side_effect = ValueError("unknown room")
        with pytest.raises(HTTPException) as exc:
            await send_message(agent.id, request, agent, protocol)
        assert exc.value.status_code == 404
    else:
        protocol.send_message.return_value = SimpleNamespace(
            event_id="event-1", trust=None
        )
        assert await send_message(agent.id, request, agent, protocol) == {
            "ok": True,
            "event_id": "event-1",
        }

    protocol.send_message.assert_awaited_once_with(agent.id, request.room_id, body)
    assert (
        f"Received message from agent agent-1 for room room-1 ({len(body)} characters)"
        in caplog.messages
    )
    for record in caplog.records:
        assert body not in record.args
        if body:
            assert body not in record.getMessage()
