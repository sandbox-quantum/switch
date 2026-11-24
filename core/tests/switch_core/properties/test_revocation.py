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
from switch_core.transport import postgres
from tests.switch_core.properties.revocation_machine import (
    COVERAGE,
    HELD_ROWS_MODULE,
    TTL,
    Clock,
    held_rows_clock,
    machine_on,
)
from tests.switch_core.properties.revocation_resources import (
    ConnectorGrant,
    ControllerAccess,
    RoomAccess,
    RoomMembership,
)
from tests.switch_core.properties.shards import Shard

SHOULD_REACH = (
    "a listening connection is severed",
    "a severed process connects again",
    "a read straddled other steps",
)
HELD_SHOULD_REACH = (
    *SHOULD_REACH,
    "a process that missed the revocation acts on it within the TTL",
)
# The broker's slow check is never held: it reads nothing worth holding,
# since every check reads the database.
DIRECT_SHOULD_REACH = (
    "a listening connection is severed",
    "a severed process connects again",
)
REREAD_SHOULD_REACH = (
    *SHOULD_REACH,
    "a process that missed the change is behind until it re-reads",
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
    monkeypatch.setattr(postgres, "RECHECK_SECONDS", 3600.0)
    return clock


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_revoked_controller_is_refused_everywhere(
    postgres_schema: str, clock: Clock, shard: Shard
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(
        machine_on(postgres_schema, ControllerAccess, clock),
        settings=shard.of(settings()),
    )
    shard.reached(COVERAGE, HELD_SHOULD_REACH)


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_an_agent_removed_from_a_room_is_refused_everywhere(
    postgres_schema: str, clock: Clock, shard: Shard
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(
        machine_on(postgres_schema, RoomAccess, clock), settings=shard.of(settings())
    )
    shard.reached(COVERAGE, HELD_SHOULD_REACH)


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_client_removed_from_a_room_stops_reading_it_everywhere(
    postgres_schema: str, clock: Clock, shard: Shard
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(
        machine_on(postgres_schema, RoomMembership, clock),
        settings=shard.of(settings()),
    )
    shard.reached(COVERAGE, REREAD_SHOULD_REACH)


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


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_an_agent_removed_from_a_room_while_a_process_listened(
    postgres_schema: str, clock: Clock
) -> None:
    """Each process has the membership in memory; the one that hears the
    removal refuses the next post at once, the other within the TTL."""
    machine = machine_on(postgres_schema, RoomAccess, clock)()
    try:
        machine.check(1)
        machine.check(2)
        machine.sever(_drawing(2))
        machine.revoke()
        machine.check(1)
        machine.check(2)
        machine.tick(TTL)
        machine.check(2)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_copy_that_missed_a_removal_stops_reading_on_reconnect(
    postgres_schema: str, clock: Clock
) -> None:
    COVERAGE.clear()
    machine = machine_on(postgres_schema, RoomMembership, clock)()
    try:
        machine.sever(_drawing(1))
        machine.revoke()
        machine.check(1)
        assert COVERAGE["a process that missed the change is behind until it re-reads"]
        machine.check(2)
        machine.reconnect(_drawing(1))
        machine.check(1)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_copy_that_missed_a_removal_stops_reading_on_the_recheck(
    postgres_schema: str, clock: Clock
) -> None:
    """Severed and connected again before the removal's signal could be
    resent: the periodic re-check is what catches the copy up."""
    machine = machine_on(postgres_schema, RoomMembership, clock)()
    try:
        machine.sever(_drawing(1))
        machine.revoke()
        machine.recheck()
        machine.check(1)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_reread_that_straddled_a_removal_does_not_keep_the_room(
    postgres_schema: str, clock: Clock
) -> None:
    machine = machine_on(postgres_schema, RoomMembership, clock)()
    try:
        machine.begin_slow_check(_drawing(1))
        machine.revoke()
        machine.finish_slow_check(_drawing(1))
        machine.check(1)
        machine.grant()
        machine.check(1)
        machine.check(2)
    finally:
        machine.teardown()


@pytest.mark.property("revocation.takes-effect-everywhere")
def test_a_revoked_connector_grant_issues_nothing_anywhere(
    postgres_schema: str, clock: Clock, shard: Shard
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(
        machine_on(postgres_schema, ConnectorGrant, clock),
        settings=shard.of(settings()),
    )
    shard.reached(COVERAGE, DIRECT_SHOULD_REACH)


class _drawing:
    """A stand-in for `st.data()` that draws `value` whatever is asked."""

    def __init__(self, value: object) -> None:
        self.value = value

    def draw(self, _strategy: object) -> object:
        return self.value
