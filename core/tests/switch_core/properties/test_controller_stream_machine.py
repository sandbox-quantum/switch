"""What a controller is sent, against `controller_stream_machine.py`.

The machine is a controller on a real stream and database: it asks its agents,
reads, confirms, and reopens its socket or its connection, while passes fail,
its agents are moved away and back, and retention deletes their events.
"""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.controller_stream_machine import (
    CHANGES_SHOULD_REACH,
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("session.addressed-reaches-controller")
@pytest.mark.property("controller.stream-complete")
def test_a_controller_is_sent_everything_addressed_to_its_agents(
    postgres_schema: str,
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    if settings.get_current_profile_name() == "nightly":
        unreached = [
            what
            for what in (*SHOULD_REACH, *CHANGES_SHOULD_REACH)
            if COVERAGE[what] == 0
        ]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


@pytest.mark.property("session.addressed-reaches-controller")
def test_a_controller_that_reopens_and_retries_is_still_sent_everything(
    postgres_schema: str,
) -> None:
    """Every kind of step, in one run, so that a pull request's search is not
    the only thing that has reopened a connection or retried a pass."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema)()
    try:
        machine.open_connection()
        for agent in ("one", "two", "one"):
            machine.ask(agent)
        machine.read(1)
        machine.confirm()
        machine.reopen_socket()
        machine.drain()
        machine.ask("two")
        machine.fail_a_pass(2)
        machine.ask("one")
        machine.drain()
        machine.confirm()
        machine.ask("one")
        machine.ask("two")
        machine.reopen_connection()
        machine.drain()
    finally:
        machine.teardown()
    unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
    assert not unreached, f"never reached {unreached}; reached {dict(COVERAGE)}"


@pytest.mark.property("controller.stream-complete")
def test_agents_moved_and_events_deleted_under_an_open_stream(
    postgres_schema: str,
) -> None:
    """Every change to what the stream carries, in one run: an agent moved
    away and back while the stream is open, and retention deleting events
    under it and under a confirmed position."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema)()
    try:
        machine.open_connection()
        machine.ask("one")
        machine.ask("two")
        machine.drain()
        machine.move("one")
        machine.ask("one")
        machine.ask("two")
        machine.drain()
        machine.move("one")
        machine.ask("one")
        machine.drain()
        machine.confirm()
        machine.ask("two")
        machine.expire(_drawing("two"))
        machine.ask("two")
        machine.drain()
        machine.ask("one")
        machine.expire(_drawing("one"))
        machine.reopen_connection()
        machine.ask("one")
        machine.drain()
    finally:
        machine.teardown()
    unreached = [what for what in CHANGES_SHOULD_REACH if COVERAGE[what] == 0]
    assert not unreached, f"never reached {unreached}; reached {dict(COVERAGE)}"


@pytest.mark.property("controller.stream-complete")
def test_events_read_before_retention_deleted_them_still_arrive(
    postgres_schema: str,
) -> None:
    """A stream that read two events and sent one has the other in hand when
    retention deletes both: it sends it, and only then tells the gap."""
    machine = machine_on(postgres_schema)()
    try:
        machine.open_connection()
        machine.ask("one")
        machine.ask("one")
        machine.ask("one")
        machine.read(1)
        machine.ask("one")
        machine.expire(_drawing("one"))
        machine.ask("one")
        machine.drain()
        machine.ask("one")
        machine.drain()
    finally:
        machine.teardown()


@pytest.mark.property("controller.stream-complete")
def test_events_in_hand_when_an_agent_is_moved_away_come_before_its_detach(
    postgres_schema: str,
) -> None:
    machine = machine_on(postgres_schema)()
    try:
        machine.open_connection()
        machine.ask("one")
        machine.ask("one")
        machine.read(1)
        machine.move("one")
        machine.ask("one")
        machine.drain()
        machine.move("one")
        machine.drain()
    finally:
        machine.teardown()


class _drawing:
    """A stand-in for `st.data()` that draws `value` whatever is asked."""

    def __init__(self, value: object) -> None:
        self.value = value

    def draw(self, _strategy: object) -> object:
        return self.value
