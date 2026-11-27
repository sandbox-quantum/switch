"""One sender's allowance. A room command draws on it as a message does,
except one that stops an agent: someone who has been sending fast can always
stop an agent. A sender over it is told once for a run of refusals."""

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
    limits.admit("ada", "hello", actor="human")

    with pytest.raises(SendRateLimited, match="2 at once"):
        limits.admit_command("ada", "set-alias", "@helper @h", actor="human")
    with pytest.raises(SendRateLimited):
        limits.admit("ada", "again", actor="human")
    limits.admit_command("bo", "invite-agent", "@helper", actor="human")


@pytest.mark.parametrize("command", sorted(STOP_COMMANDS))
def test_a_command_that_stops_an_agent_is_never_held_back(command: str) -> None:
    limits = _limits(burst=1)
    limits.admit("ada", "hello", actor="human")

    for _ in range(5):
        limits.admit_command("ada", command, "@helper", actor="human")


def test_a_commands_arguments_are_held_to_the_length_limit() -> None:
    limits = _limits(burst=10, max_message_chars=10)

    with pytest.raises(MessageTooLong, match="11 characters long"):
        limits.admit_command("ada", "interrupt", "x" * 11, actor="human")


def test_every_stop_command_is_a_room_command() -> None:
    assert STOP_COMMANDS <= COMMANDS_BY_NAME.keys()


def test_a_steady_sender_over_the_rate_is_told_once_for_the_run() -> None:
    """3 a second against 2: some get through, some are refused, and only
    the first refusal of the run is told."""
    now = [0.0]
    limits = SendLimits(
        max_message_chars=100, burst=2, per_second=2.0, clock=lambda: now[0]
    )
    firsts: list[bool] = []
    let_through = 0
    for tick in range(30):
        now[0] = tick / 3
        try:
            limits.admit("ada", "hi", actor="human")
            let_through += 1
        except SendRateLimited as refused:
            firsts.append(refused.first)

    assert let_through > len(firsts) > 1
    assert firsts == [True] + [False] * (len(firsts) - 1)


def test_a_sender_who_lets_the_allowance_refill_is_told_again() -> None:
    now = [0.0]
    limits = SendLimits(
        max_message_chars=100, burst=2, per_second=2.0, clock=lambda: now[0]
    )
    limits.admit("ada", "one", actor="human")
    limits.admit("ada", "two", actor="human")
    with pytest.raises(SendRateLimited) as refused:
        limits.admit("ada", "three", actor="human")
    assert refused.value.first

    # Half refilled: one gets through, and the run goes on.
    now[0] = 0.5
    limits.admit("ada", "four", actor="human")
    with pytest.raises(SendRateLimited) as again:
        limits.admit("ada", "five", actor="human")
    assert not again.value.first

    # Full again: the next run is told.
    now[0] = 1.5
    limits.admit("ada", "six", actor="human")
    limits.admit("ada", "seven", actor="human")
    with pytest.raises(SendRateLimited) as next_run:
        limits.admit("ada", "eight", actor="human")
    assert next_run.value.first
