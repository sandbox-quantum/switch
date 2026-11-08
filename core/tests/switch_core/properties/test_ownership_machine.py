"""Lease ownership, against the model in `properties/specs/ownership.qnt`.

The machine in `ownership_machine.py` drives two real `Ownership`s and process
leases on one Postgres through the steps the model has, with their clocks moved
apart, and checks the model's invariants after each.
"""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.ownership_machine import (
    COVERAGE,
    KEY,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("lease.no-overlap")
@pytest.mark.property("lease.fenced-takeover")
def test_ownership_keeps_its_properties(postgres_schema: str) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


@pytest.mark.property("lease.fenced-takeover")
@pytest.mark.property("lease.no-overlap")
def test_a_holder_that_stalled_past_its_lease_is_refused(postgres_schema: str) -> None:
    """The holder stalls, its lease lapses, the other process takes the key,
    and the holder, resumed before its timer has run, writes under the token
    it started with: the database refuses it and the other's token stands."""
    COVERAGE.clear()
    machine = machine_on(postgres_schema)()
    try:
        first, second = machine.processes[1], machine.processes[2]
        for number in (1, 2):
            machine.renew(number)
        for number in (1, 2):
            machine.balance(number)
        holder, other = (first, second) if first.running else (second, first)
        assert holder.running and not other.running

        machine.write(holder.number)
        assert machine.accepted == [1]

        machine.stall(holder.number)
        machine.tick(slow=holder.number, fast=other.number)
        machine.renew(other.number)
        machine.tick(slow=holder.number, fast=other.number)
        machine.renew(other.number)
        machine.balance(other.number)
        assert other.running and other.running[KEY].token == 2

        machine.resume(holder.number)
        assert holder.running[KEY].token == 1
        machine.write(holder.number)
        assert machine.accepted == [1]
        assert COVERAGE["a stalled holder that was taken over is refused"] == 1
        machine.write(other.number)
        assert machine.accepted == [1, 2]

        machine.balance(holder.number)
        assert not holder.running
        machine.no_overlap()
        machine.fenced_takeover()
    finally:
        machine.teardown()
