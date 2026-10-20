"""An agent can delete itself through the agent API."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from switch_core.bridges.agent.api.handlers import delete_agent


async def test_an_agent_can_delete_itself() -> None:
    agent = SimpleNamespace(id="agent-1", name="local", metadata_={})
    protocol = AsyncMock()

    assert await delete_agent("agent-1", agent, protocol) == {"ok": True}
    protocol.delete_agent.assert_awaited_once_with(agent_id="agent-1")
