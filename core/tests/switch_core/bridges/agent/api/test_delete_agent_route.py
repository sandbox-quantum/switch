"""An agent cannot delete itself through the agent API when it is a cloud agent."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import delete_agent


async def test_a_cloud_agent_cannot_delete_itself() -> None:
    agent = SimpleNamespace(
        id="agent-1", name="cloud", metadata_={"hosted_launch_id": "launch-1"}
    )
    protocol = AsyncMock()

    with pytest.raises(HTTPException) as refused:
        await delete_agent("agent-1", agent, protocol)

    assert refused.value.status_code == 409
    assert "cloud agent" in refused.value.detail
    protocol.delete_agent.assert_not_awaited()


async def test_a_local_agent_can_delete_itself() -> None:
    agent = SimpleNamespace(id="agent-1", name="local", metadata_={})
    protocol = AsyncMock()

    assert await delete_agent("agent-1", agent, protocol) == {"ok": True}
    protocol.delete_agent.assert_awaited_once_with(agent_id="agent-1")
