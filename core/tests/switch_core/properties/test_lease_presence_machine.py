"""A connection reads online only while its holder holds its lease, against
`lease_presence_machine.py`.

Two processes on one database, each with its own registry, presence, ledger,
lease and signal bus: an agent's connection and a controller's are opened and
closed through either, while the leases are renewed, lapse and are stopped.
"""

from __future__ import annotations

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

from tests.switch_core.properties.lease_presence_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("presence.online-iff-lease")
def test_a_connection_reads_online_only_while_its_holder_holds(
    postgres_schema: str,
) -> None:
    COVERAGE.clear()
    run_state_machine_as_test(machine_on(postgres_schema))
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


@pytest.mark.property("presence.online-iff-lease")
@pytest.mark.parametrize("kind", ["agent", "controller"])
def test_a_holder_that_stops_renewing_reads_offline_once_its_lease_is_checked(
    postgres_schema: str, kind: str
) -> None:
    """The holder dies holding only this connection: the other process's
    lease watch is what takes it offline there."""
    machine = machine_on(postgres_schema)()
    try:
        getattr(machine, f"connect_{kind}")(0)
        machine.hear()
        machine.lapse(_drawing(machine.processes[0]))
        machine.check_the_leases(1)
        machine.renew(_drawing(machine.processes[0]))
        machine.reread(1)
    finally:
        machine.teardown()


@pytest.mark.property("presence.online-iff-lease")
def test_a_holder_that_shuts_down_reads_offline_before_its_sockets_go(
    postgres_schema: str,
) -> None:
    machine = machine_on(postgres_schema)()
    try:
        machine.connect_agent(1)
        machine.connect_controller(1)
        machine.hear()
        machine.stop(_drawing(machine.processes[1]))
        machine.check_the_leases(0)
    finally:
        machine.teardown()


@pytest.mark.property("presence.online-iff-lease")
def test_a_controller_held_again_after_a_lapse_reads_online_on_the_recheck(
    postgres_schema: str,
) -> None:
    """The other process read every controller's connection, so its re-check
    skips a workspace whose rows and live processes are unchanged. The lease
    watch dropped the copy meanwhile: once the holder renews, the re-check
    must still read the workspace again."""
    machine = machine_on(postgres_schema)()
    try:
        machine.connect_controller(0)
        machine.hear()
        machine.reread(1)
        machine.lapse(_drawing(machine.processes[0]))
        machine.check_the_leases(1)
        machine.renew(_drawing(machine.processes[0]))
        machine.reread(1)
    finally:
        machine.teardown()


class _drawing:
    """A stand-in for `st.data()` that draws `value` whatever is asked."""

    def __init__(self, value: object) -> None:
        self.value = value

    def draw(self, _strategy: object, label: str | None = None) -> object:
        return self.value
