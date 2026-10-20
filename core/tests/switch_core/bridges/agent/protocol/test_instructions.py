"""The instructions an agent receives on connecting to a room."""

from __future__ import annotations

from switch_core.bridges.agent.protocol.instructions import build_room_instructions
from switch_core.bridges.agent.protocol.types import ParticipantDescriptor
from switch_core.db.models import Agent, Room


def _instructions() -> str:
    agent = Agent(id="a1", name="worker", agent_type="session_addressable")
    room = Room(id="r1", name="build", description="", channel_type="group")
    room.admin_mode = False
    room.instructions = None
    participants = [
        ParticipantDescriptor(
            id="a2", name="reviewer", type="agent", agent_type="always_on"
        ),
        ParticipantDescriptor(id="u1", name="alice", type="user"),
    ]
    return build_room_instructions(agent, room, participants, None)


def test_instructions_do_not_teach_tasks() -> None:
    text = _instructions().lower()
    assert "task" not in text
    assert "delegat" not in text


def test_instructions_name_the_coordination_tools() -> None:
    text = _instructions()
    assert "`post_message`" in text
    assert "`send_targeted_message`" in text
