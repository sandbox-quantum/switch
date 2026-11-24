"""A bridged message crosses once in each direction, against
`bridge_machine.py`.

One bridge on two processes sharing Postgres: posts on the platform, delivered
again to either copy; messages written in Switch, some refused by the platform
or taken and then failed; and the bridge handed over between processes.
"""

from __future__ import annotations

from typing import Any

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.bridge_machine import (
    COVERAGE,
    REFUSE,
    SHOULD_REACH,
    TAKE_THEN_FAIL,
    machine_on,
)


class _drawing:
    """A stand-in for `st.data()` in a fixed scenario."""

    def __init__(self, value: Any) -> None:
        self.value = value

    def draw(self, strategy: Any, label: str | None = None) -> Any:
        return self.value


@pytest.mark.property("bridge.roundtrip-exactly-once")
def test_a_bridged_message_crosses_once_in_each_direction(
    postgres_schema: str,
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


@pytest.mark.property("bridge.roundtrip-exactly-once")
@pytest.mark.parametrize("to_quiet", [False, True])
def test_a_post_delivered_again_is_in_the_room_once(
    postgres_schema: str, to_quiet: bool
) -> None:
    machine = machine_on(postgres_schema)()
    try:
        machine.person_posts()
        machine.deliver_again(_drawing(machine.world.posted[0]), to_quiet)
        machine.settle()
    finally:
        machine.teardown()


@pytest.mark.property("bridge.roundtrip-exactly-once")
def test_a_post_delivered_again_after_a_handover_is_in_the_room_once(
    postgres_schema: str,
) -> None:
    machine = machine_on(postgres_schema)()
    try:
        machine.person_posts()
        machine.hand_over()
        machine.deliver_again(_drawing(machine.world.posted[0]), False)
        machine.deliver_again(_drawing(machine.world.posted[0]), True)
        machine.settle()
    finally:
        machine.teardown()


@pytest.mark.property("bridge.roundtrip-exactly-once")
@pytest.mark.parametrize("outcome", [REFUSE, TAKE_THEN_FAIL])
@pytest.mark.parametrize("hand_over", [False, True])
def test_a_post_that_failed_is_tried_again(
    postgres_schema: str, outcome: str, hand_over: bool
) -> None:
    """Tried again by the holder, or by the next if the bridge is handed
    over while it waits. The next holder then reads the room from the failed
    post, so it reads the message after it again, which went out already."""
    machine = machine_on(postgres_schema)()
    try:
        machine.fail_the_next_post(outcome)
        machine.switch_says()
        machine.switch_says()
        if hand_over:
            machine.hand_over()
        machine.settle()
    finally:
        machine.teardown()
