"""How many machines are in each decision-model state, for the operator's
metrics (`switch.decision.machines`).

A controller reports its decision model's state with each status report,
over the socket the process holding it reads. This keeps the last state of
each controller reported here, and counts only those whose socket this
process still holds at collection time, so a machine that went is dropped
without a hook on the disconnect. Each process counts its own machines: sum
across replicas.

Never which machine or whose. `reason` is taken from a fixed set; a reason a
newer controller sends that is not in it is counted as `other`.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterator
from typing import Literal

from switch_core.observability.catalogue import DECISION_MACHINES
from switch_core.observability.metrics import GaugeReading

DecisionModelState = Literal["off", "downloading", "starting", "running", "failed"]

_KNOWN_REASONS = frozenset(
    {
        "turned_off_on_machine",
        "not_enough_disk",
        "download_failed",
        "checksum_mismatch",
        "model_server_crashed",
        "out_of_memory",
        "unsupported_hardware",
    }
)


class MachineDecisionStates:
    def __init__(self, *, connected_here: Callable[[str], bool]) -> None:
        """`connected_here` says whether this process holds a controller's
        socket now."""
        self._connected_here = connected_here
        self._states: dict[str, tuple[DecisionModelState, str]] = {}

    def report(
        self, controller_id: str, state: DecisionModelState, reason: str | None
    ) -> None:
        """Keep a controller's reported decision-model state."""
        if state != "failed":
            label = "none"
        elif reason in _KNOWN_REASONS:
            label = reason
        else:
            label = "other"
        self._states[controller_id] = (state, label)

    def forget(self, controller_id: str) -> None:
        """A controller that reports no decision model any more."""
        self._states.pop(controller_id, None)

    def readings(self) -> Iterator[GaugeReading]:
        for controller_id in [c for c in self._states if not self._connected_here(c)]:
            del self._states[controller_id]
        for (state, reason), count in Counter(self._states.values()).items():
            yield GaugeReading(
                DECISION_MACHINES, float(count), {"state": state, "reason": reason}
            )
