"""Delivery, against the model in `properties/specs/delivery.qnt`.

The machine in `delivery_machine.py` drives the real router, event buffer and
Postgres through the steps the model has, in the order Hypothesis picks, and
checks the model's invariants against the database after each.
"""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.delivery_machine import (
    COVERAGE,
    SHOULD_REACH,
    SHOULD_REACH_AT_SCALE,
    machine_on,
)


@pytest.mark.property("bus.room-seq-dense")
@pytest.mark.property("delivery.decided-at-write")
@pytest.mark.property("delivery.own-seq-contiguous")
@pytest.mark.property("delivery.addressed-exactly-once")
@pytest.mark.property("delivery.no-silent-loss")
@pytest.mark.property("delivery.no-events-after-leave")
def test_delivery_keeps_its_properties(postgres_schema: str) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    required = SHOULD_REACH
    if settings.get_current_profile_name() == "nightly":
        required = SHOULD_REACH + SHOULD_REACH_AT_SCALE
    unreached = [what for what in required if COVERAGE[what] == 0]
    assert not unreached, (
        f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
    )


@pytest.mark.property("delivery.no-silent-loss")
def test_retention_does_not_skip_an_event_that_no_gap_names(
    postgres_schema: str,
) -> None:
    """Two transactions numbering events for one agent, one in each room, the
    one that began first numbering second because it waited for its room's lock.
    Retention at the older event's `created_at` must delete a prefix of the
    agent's numbers: with `created_at` set when the transaction began, it kept
    the lower number and deleted the higher, and a client resuming from before
    both was told about the higher one's room and moved past the lower one."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema)()
    try:
        machine.begin_post(1, "r1", frozenset())
        machine.begin_post(2, "r1", frozenset({"alpha"}))
        machine.begin_post(3, "r2", frozenset({"alpha"}))
        machine.end_post(3, "commit")
        machine.end_post(1, "commit")
        machine.end_post(2, "commit")
        machine.expire_at(0)
        machine.read("alpha")
        machine.check_all()
    finally:
        machine.teardown()
    assert COVERAGE["a read reports a gap"] == 1


def test_numbering_continues_after_retention_deletes_the_newest_event(
    postgres_schema: str,
) -> None:
    """An agent's numbers come from its head row. Numbering from the highest
    stored event would hand a number out again once retention had deleted it."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema)()
    try:
        machine.begin_post(1, "r1", frozenset({"alpha"}))
        machine.end_post(1, "commit")
        machine.expire_at(0)
        machine.begin_post(2, "r1", frozenset({"alpha"}))
        machine.end_post(2, "commit")
        machine.read("alpha")
        machine.check_all()
    finally:
        machine.teardown()


def test_event_is_not_stored_for_an_agent_that_left_after_the_decision(
    postgres_schema: str,
) -> None:
    """A transaction decides a row is for an agent, then waits for the agent's
    head row behind another room's transaction while the agent leaves the room.
    The event must not be stored once the agent has gone."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema)()
    try:
        machine.begin_post(1, "r2", frozenset({"alpha"}))
        machine.begin_leave("alpha", "r1")
        machine.begin_post(2, "r1", frozenset({"alpha"}))
        machine.end_post(1, "commit")
        machine.settle()
        machine.end_post(2, "commit")
        machine.check_all()
    finally:
        machine.teardown()
    assert COVERAGE["a leave waits for a lock"] >= 1
