"""An agent deleted while the bridge handles its join to a channel.

The process holding the bridge bridges the channels an agent's bot is already
in as soon as it sets the bot up; with several processes, the agent can be
deleted on another one in that moment. Adding it to the channel's room then
finds no agent row.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.exc import IntegrityError

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


def _bridge(*, still_there: bool) -> Any:
    reads: list[str] = []

    async def get_by_name(session: Any, name: str) -> Any:
        # Read once before the add; a second read sees what the add found.
        reads.append(name)
        return SimpleNamespace(name=name) if len(reads) == 1 or still_there else None

    async def add_agents_to_room(room_id: str, **kwargs: Any) -> None:
        raise IntegrityError(
            "INSERT INTO room_agents", {}, Exception("fk_room_agents_agent")
        )

    return SimpleNamespace(
        _agent_store=SimpleNamespace(get_by_name=get_by_name),
        _session_factory=_Session,
        _channel_to_room={"chan-1": ("room-1", "sw_room_1")},
        _room_service=SimpleNamespace(add_agents_to_room=add_agents_to_room),
    )


def _join() -> InboundAgentJoin:
    return InboundAgentJoin(
        channel_id="chan-1",
        channel_type="channel_public",
        agent_name="helper",
        channel_name="general",
    )


def test_an_agent_deleted_mid_join_is_said_not_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bridge = _bridge(still_there=False)
    with caplog.at_level(logging.WARNING):
        asyncio.run(
            CollaborationCore._handle_agent_joined_channel_locked(bridge, _join())
        )
    assert any("was deleted while its join" in r.message for r in caplog.records)


def test_the_same_failure_for_an_agent_that_still_exists_is_raised() -> None:
    bridge = _bridge(still_there=True)
    with pytest.raises(IntegrityError):
        asyncio.run(
            CollaborationCore._handle_agent_joined_channel_locked(bridge, _join())
        )
