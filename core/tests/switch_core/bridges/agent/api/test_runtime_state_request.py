from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.bridges.agent.api.schemas import RuntimeStateRequest


def _subagents(count: int) -> list[dict[str, str]]:
    return [
        {"agent_id": f"sub-{i}", "agent_name": f"agent{i}", "state": "working"}
        for i in range(count)
    ]


def test_active_subagents_default_to_unchanged() -> None:
    # Omitted means "unchanged", so the stored list survives a report that says
    # nothing about subagents (the periodic activity refresh, the idle sweep).
    req = RuntimeStateRequest(room_id="room-1", state="working")

    assert req.active_subagents is None


def test_a_subagent_needs_a_name_and_a_known_state() -> None:
    with pytest.raises(ValidationError):
        RuntimeStateRequest(
            room_id="room-1",
            state="working",
            active_subagents=[{"agent_id": "sub-1", "state": "working"}],
        )
    with pytest.raises(ValidationError):
        RuntimeStateRequest(
            room_id="room-1",
            state="working",
            active_subagents=[
                {"agent_id": "sub-1", "agent_name": "a", "state": "dancing"}
            ],
        )


def test_the_subagent_list_is_capped() -> None:
    RuntimeStateRequest(
        room_id="room-1", state="working", active_subagents=_subagents(50)
    )

    with pytest.raises(ValidationError):
        RuntimeStateRequest(
            room_id="room-1", state="working", active_subagents=_subagents(51)
        )
