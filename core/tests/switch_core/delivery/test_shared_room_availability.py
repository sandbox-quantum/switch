"""A message in a room sharing an agent's session finds the agent available
when a session is in its home room, even before the watcher has recorded the
share (it records it as it routes the room's first message)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.delivery.recipient import AgentRecipient

AGENT = "agent-1"


def _recipient(registry: AgentConnectionRegistry, sharing: set[str]) -> Any:
    async def sharing_agent_ids(_session: Any, room_id: str) -> set[str]:
        return {AGENT} if room_id in sharing else set()

    recipient = SimpleNamespace(
        agent=SimpleNamespace(id=AGENT),
        _connections=registry,
        _room_store=SimpleNamespace(sharing_agent_ids=sharing_agent_ids),
    )
    recipient._answered_from_home = AgentRecipient._answered_from_home.__get__(
        recipient
    )
    return recipient


@pytest.mark.asyncio
async def test_a_shared_room_is_answered_while_the_home_room_has_a_session() -> None:
    registry = AgentConnectionRegistry()
    agent = SimpleNamespace(id=AGENT, home_room_id="hub")
    recipient = _recipient(registry, sharing={"work"})

    # Nobody home yet: a session has to start, so the room is not answered.
    assert not await recipient._answered_from_home(None, agent, "work")

    registry.place_session(AGENT, "lead", "hub", "conn-1")
    assert await recipient._answered_from_home(None, agent, "work")
    # An isolated room, and the home room itself, are not this rule's.
    assert not await recipient._answered_from_home(None, agent, "elsewhere")
    assert not await recipient._answered_from_home(None, agent, "hub")
    # An agent with no home room shares nothing.
    no_home = SimpleNamespace(id=AGENT, home_room_id=None)
    assert not await recipient._answered_from_home(None, no_home, "work")
