"""What a controller is sent, against `controller_stream_machine.py`.

The machine is a controller on a real stream and database: it asks its agents,
reads, confirms, and reopens its socket or its connection, while passes fail.
"""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.controller_stream_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("session.addressed-reaches-controller")
def test_a_controller_is_sent_everything_addressed_to_its_agents(
    postgres_schema: str,
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
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
