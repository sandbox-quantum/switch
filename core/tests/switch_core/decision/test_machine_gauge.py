"""Machines by decision-model state: counted from their status reports, only
while their socket is held here, and never naming a machine."""

from __future__ import annotations

from switch_core.decision.machine_gauge import MachineDecisionStates
from switch_core.observability.catalogue import DECISION_MACHINES


def _counts(states: MachineDecisionStates) -> dict[tuple[str, str], float]:
    readings = list(states.readings())
    assert all(reading.spec is DECISION_MACHINES for reading in readings)
    return {
        (str(r.attributes["state"]), str(r.attributes["reason"])): r.value
        for r in readings
    }


def test_machines_are_counted_by_state_and_failed_ones_by_reason() -> None:
    held = {"c-1", "c-2", "c-3", "c-4"}
    states = MachineDecisionStates(connected_here=lambda c: c in held)

    states.report("c-1", "running", None)
    states.report("c-2", "running", None)
    states.report("c-3", "failed", "out_of_memory")
    states.report("c-4", "failed", "a_reason_from_a_newer_controller")

    assert _counts(states) == {
        ("running", "none"): 2,
        ("failed", "out_of_memory"): 1,
        ("failed", "other"): 1,
    }


def test_a_machine_moves_through_its_states() -> None:
    states = MachineDecisionStates(connected_here=lambda c: True)

    for state in ("downloading", "starting", "running", "off"):
        states.report("c-1", state, "turned_off_on_machine" if state == "off" else None)
        assert _counts(states) == {(state, "none"): 1}


def test_a_machine_that_went_or_stopped_serving_is_not_counted() -> None:
    held = {"c-1", "c-2"}
    states = MachineDecisionStates(connected_here=lambda c: c in held)
    states.report("c-1", "running", None)
    states.report("c-2", "running", None)

    held.discard("c-1")
    states.forget("c-2")

    assert _counts(states) == {}


def test_no_attribute_names_a_machine() -> None:
    states = MachineDecisionStates(connected_here=lambda c: True)
    states.report("controller-secret-id", "failed", "download_failed")

    for reading in states.readings():
        assert "controller-secret-id" not in reading.attributes.values()
