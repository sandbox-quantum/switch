"""A room command draws on its sender's allowance as a message does, except
one that stops an agent: someone who has been sending fast can always stop
an agent."""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME
from switch_core.delivery.send_limits import (
    STOP_COMMANDS,
    MessageTooLong,
    SendLimits,
    SendRateLimited,
)


def _limits(*, burst: int, max_message_chars: int = 100) -> SendLimits:
    """Limits whose allowance does not refill during a test."""
    return SendLimits(
        max_message_chars=max_message_chars,
        burst=burst,
        per_second=0.001,
        clock=lambda: 0.0,
    )


def test_commands_and_messages_draw_on_one_allowance() -> None:
    limits = _limits(burst=2)
    limits.admit_command("ada", "invite-agent", "@helper", actor="human")
    limits.admit("ada", "hello", actor="human", starts_post=True)

    with pytest.raises(SendRateLimited, match="2 at once"):
        limits.admit_command("ada", "set-alias", "@helper @h", actor="human")
    with pytest.raises(SendRateLimited):
        limits.admit("ada", "again", actor="human", starts_post=True)
    limits.admit_command("bo", "invite-agent", "@helper", actor="human")


@pytest.mark.parametrize("command", sorted(STOP_COMMANDS))
def test_a_command_that_stops_an_agent_is_never_held_back(command: str) -> None:
    limits = _limits(burst=1)
    limits.admit("ada", "hello", actor="human", starts_post=True)

    for _ in range(5):
        limits.admit_command("ada", command, "@helper", actor="human")


def test_a_commands_arguments_are_held_to_the_length_limit() -> None:
    limits = _limits(burst=10, max_message_chars=10)

    with pytest.raises(MessageTooLong, match="11 characters long"):
        limits.admit_command("ada", "interrupt", "x" * 11, actor="human")


def test_every_stop_command_is_a_room_command() -> None:
    assert STOP_COMMANDS <= COMMANDS_BY_NAME.keys()
