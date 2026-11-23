"""`revocation.takes-effect-everywhere`, one resource at a time.

The machine in `revocation_machine.py` grants and revokes a resource under two
processes on one Postgres, severs their listening connections for real, moves
the clock, and checks after every step that no process acts on a revocation
past its bound.
"""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from switch_core import signals
from tests.switch_core.properties.revocation_machine import (
    COVERAGE,
    HELD_ROWS_MODULE,
    TTL,
    Clock,
    ControllerAccess,
    held_rows_clock,
    machine_on,
)

SHOULD_REACH = (
    "a listening connection is severed",
    "a severed process connects again",
    "a process that missed the revocation acts on it within the TTL",
    "a read straddled other steps",
)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """The machine's clock in `HeldRows`, and a bus that notices a severed
    connection, and reconnects, within a step, and leaves its re-check to
    the machine."""
    clock = Clock()
    monkeypatch.setattr(HELD_ROWS_MODULE, "time", held_rows_clock(clock))
    monkeypatch.setattr(signals, "HEARTBEAT_SECONDS", 0.02)
    monkeypatch.setattr(signals, "RECONNECT_BACKOFF_BASE", 0.01)
    monkeypatch.setattr(signals, "RECONNECT_BACKOFF_CAP", 0.02)
    monkeypatch.setattr(signals, "RECHECK_SECONDS", 3600.0)
    return clock


def _reached() -> None:
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_revoked_controller_is_refused_everywhere(
    postgres_schema: str, clock: Clock
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema, ControllerAccess, clock))
    _reached()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_controller_revoked_while_a_process_was_severed(
    postgres_schema: str, clock: Clock
) -> None:
    """The process read the controller while listening, lost its connection,
    missed the revocation, and connected again: it may answer from memory
    until the TTL, and not after."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema, ControllerAccess, clock)()
    try:
        machine.check(1)
        machine.sever(_drawing(1))
        machine.revoke()
        machine.reconnect(_drawing(1))
        machine.check(1)
        assert COVERAGE[
            "a process that missed the revocation acts on it within the TTL"
        ]
        machine.tick(TTL)
        machine.check(1)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_read_that_straddled_a_heard_revocation_is_not_kept(
    postgres_schema: str, clock: Clock
) -> None:
    machine = machine_on(postgres_schema, ControllerAccess, clock)()
    try:
        machine.begin_slow_check(_drawing(1))
        machine.revoke()
        machine.finish_slow_check(_drawing(1))
        machine.check(1)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_slow_read_across_a_missed_revocation_lasts_the_ttl_from_its_start(
    postgres_schema: str, clock: Clock
) -> None:
    """A read that began before a revocation the process could not hear is
    stored, but only for the TTL from when it began: stored later, it must
    not last longer."""
    machine = machine_on(postgres_schema, ControllerAccess, clock)()
    try:
        machine.sever(_drawing(1))
        machine.begin_slow_check(_drawing(1))
        machine.revoke()
        machine.tick(TTL / 2)
        machine.finish_slow_check(_drawing(1))
        machine.tick(TTL / 2)
        machine.check(1)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_an_entry_read_while_not_listening_lasts_the_ttl(
    postgres_schema: str, clock: Clock
) -> None:
    """Read while the bus was down, nothing could drop the entry, so the TTL
    is all it gets, however long the bus stays down."""
    machine = machine_on(postgres_schema, ControllerAccess, clock)()
    try:
        machine.sever(_drawing(1))
        machine.check(1)
        machine.revoke()
        machine.tick(TTL)
        machine.check(1)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_revoking_again_does_not_move_the_bound(
    postgres_schema: str, clock: Clock
) -> None:
    """A resource revoked twice was revoked from the first: an entry read
    before it lasts the TTL from then, not from the second."""
    machine = machine_on(postgres_schema, ControllerAccess, clock)()
    try:
        machine.check(1)
        machine.sever(_drawing(1))
        machine.revoke()
        machine.tick(TTL)
        machine.revoke()
        machine.check(1)
    finally:
        machine.teardown()


class _drawing:
    """A stand-in for `st.data()` that draws `value` whatever is asked."""

    def __init__(self, value: object) -> None:
        self.value = value

    def draw(self, _strategy: object) -> object:
        return self.value
