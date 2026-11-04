"""An agent sees only the rooms its owner may read or that it belongs to."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import list_participants


async def test_participants_of_a_room_the_agent_is_not_in_are_refused() -> None:
    protocol = AsyncMock()
    protocol.require_room_member = AsyncMock(
        side_effect=PermissionError("Agent is not a member of this room")
    )

    with pytest.raises(HTTPException) as exc:
        await list_participants("room-1", SimpleNamespace(id="agent-1"), protocol)

    assert exc.value.status_code == 403
    protocol.list_participants.assert_not_awaited()
