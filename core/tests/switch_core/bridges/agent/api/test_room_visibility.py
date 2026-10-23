"""An agent sees only the rooms its owner may read or that it belongs to."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import list_participants
from switch_core.bridges.agent.protocol.agent_core import AgentCore


async def test_participants_of_a_room_the_agent_is_not_in_are_refused() -> None:
    protocol = AsyncMock()
    protocol.require_room_member = AsyncMock(
        side_effect=PermissionError("Agent is not a member of this room")
    )

    with pytest.raises(HTTPException) as exc:
        await list_participants("room-1", SimpleNamespace(id="agent-1"), protocol)

    assert exc.value.status_code == 403
    protocol.list_participants.assert_not_awaited()


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def get(self, model: Any, ident: str) -> Any:
        return SimpleNamespace(id=ident)


def _room(room_id: str, *, owner_id: str, read_visibility: str) -> Any:
    return SimpleNamespace(
        id=room_id,
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility="private",
    )


async def test_list_all_rooms_hides_private_rooms_of_other_users() -> None:
    own = _room("own", owner_id="alice", read_visibility="private")
    public = _room("public", owner_id="bob", read_visibility="public")
    joined = _room("joined", owner_id="bob", read_visibility="private")
    hidden = _room("hidden", owner_id="bob", read_visibility="private")

    svc = object.__new__(AgentCore)
    svc.session_factory = _FakeSession  # type: ignore[assignment]
    svc.agent_store = SimpleNamespace(  # type: ignore[assignment]
        get=AsyncMock(return_value=SimpleNamespace(id="agent-1", owner_id="alice"))
    )
    svc.user_store = SimpleNamespace(administers=AsyncMock(return_value=False))  # type: ignore[assignment]
    svc.room_store = SimpleNamespace(  # type: ignore[assignment]
        get_rooms_for_agent=AsyncMock(return_value=[joined]),
        get_all=AsyncMock(return_value=[own, public, joined, hidden]),
    )

    rooms = await svc.list_all_rooms("agent-1")

    assert [r.id for r in rooms] == ["own", "public", "joined"]
