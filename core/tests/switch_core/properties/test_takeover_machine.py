"""A controller connection taken over is fenced, against `takeover_machine.py`.

Two processes on one database, each with its own presence, ledger and signal
bus: the controller opens and attaches through either, to its newest
connection or an older one, while the ledgers' writes land late.
"""

from __future__ import annotations

from typing import Any

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.takeover_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("controller.takeover-fenced")
def test_a_connection_taken_over_is_fenced(postgres_schema: str) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


def _socket(machine: Any, number: int) -> _drawing:
    [socket] = [s for s in machine.sockets if s.number == number]
    return _drawing(socket)


def test_a_connected_write_that_lands_late_leaves_the_newer_connection(
    postgres_schema: str,
) -> None:
    """The first connection's socket attaches and its write is held, while
    the controller opens again through the other process and attaches there."""
    machine = machine_on(postgres_schema)()
    try:
        machine.open(0)
        machine.attach(_drawing(machine.opens[-1]), 0)
        machine.hold_a_flush(0)
        machine.open(1)
        machine.attach(_drawing(machine.opens[-1]), 1)
        machine.flush(1)
        machine.let_a_flush_go(_drawing(0))
        machine.settle()
    finally:
        machine.teardown()


def test_a_closing_that_lands_late_leaves_the_newer_connection(
    postgres_schema: str,
) -> None:
    """The first connection's socket goes and that write is held, while the
    controller opens again through the other process and attaches there."""
    machine = machine_on(postgres_schema)()
    try:
        machine.open(0)
        machine.attach(_drawing(machine.opens[-1]), 0)
        machine.flush(0)
        machine.drop(_socket(machine, 1))
        machine.hold_a_flush(0)
        machine.open(1)
        machine.attach(_drawing(machine.opens[-1]), 1)
        machine.flush(1)
        machine.let_a_flush_go(_drawing(0))
        machine.settle()
    finally:
        machine.teardown()


def test_a_socket_waiting_to_be_woken_is_evicted_when_taken_over(
    postgres_schema: str,
) -> None:
    machine = machine_on(postgres_schema)()
    try:
        machine.open(0)
        machine.attach(_drawing(machine.opens[-1]), 0)
        machine.idle(_socket(machine, 1))
        machine.open(1)
        machine.hear()
        machine.read(_socket(machine, 1))
    finally:
        machine.teardown()


class _drawing:
    """A stand-in for `st.data()` that draws `value` whatever is asked."""

    def __init__(self, value: object) -> None:
        self.value = value

    def draw(self, _strategy: object, label: str | None = None) -> object:
        return self.value
