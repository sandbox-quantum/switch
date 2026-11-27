"""Core's side of the box start-time budget.

The box scaler gives a starting box up to `ROOM_LIMIT_S` (6 minutes) waiting
for room in the cluster, then `START_LIMIT_S` (3 minutes) once it's placed
(the hosted controller's `box_scaler.py`, which pins its own sum against the
same 600 s). Core
must wait at least that long before it calls a start that never connected a
failure (`MACHINE_CONNECT_TIMEOUT`), or a box the scaler would still bring up
is marked in error first. Change one side, change both."""

from datetime import timedelta

from switch_core.db.stores.hosted_machine_store import MACHINE_CONNECT_TIMEOUT

# The box side's budget: ROOM_LIMIT_S + START_LIMIT_S.
BOX_SIDE_START_BUDGET = timedelta(seconds=360 + 180)


def test_core_waits_at_least_as_long_as_the_box_side_may_take() -> None:
    assert MACHINE_CONNECT_TIMEOUT >= timedelta(seconds=600)
    assert MACHINE_CONNECT_TIMEOUT >= BOX_SIDE_START_BUDGET
