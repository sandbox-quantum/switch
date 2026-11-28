import logging
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent.protocol.agent_core import AgentCore


async def test_send_message_logging(caplog: pytest.LogCaptureFixture) -> None:
    core = object.__new__(AgentCore)
    core.require_room_poster = AsyncMock(side_effect=ValueError("unknown room"))
    body = "private message"
    caplog.set_level(logging.DEBUG, logger=AgentCore.__module__)

    with pytest.raises(ValueError, match="unknown room"):
        await core.send_message("agent-1", "room-1", body)

    assert (
        f"[AGENT-MSG] agent=agent-1 room=room-1 length={len(body)}" in caplog.messages
    )
    for record in caplog.records:
        assert body not in record.getMessage()
        assert body not in record.args
