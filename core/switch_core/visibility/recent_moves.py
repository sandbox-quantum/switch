"""Boxes that moved to another machine in the last 15 minutes (the `box_moved` reason).

Kept in Core's memory, not a table: a move is a passing "back in a moment", and losing the record when
Core restarts only drops a reason that was about to clear anyway. On this cluster a box only moves by eviction (drain,
scale-down or a machine going away), so the box scaler's eviction count in its observation records them (platform).
The placer's own moves would not show there; it is off, and its switch-on checklist covers reporting them.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

MOVE_SHOWN_FOR = timedelta(minutes=15)


class RecentMoves:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._moved: dict[str, datetime] = {}

    def record(self, machine_id: str, at: datetime) -> None:
        """A box (its cloud machine) was moved at `at`: an eviction the box scaler reported."""
        with self._lock:
            self._moved[machine_id] = at

    def moved_at(self, machine_id: str, now: datetime) -> datetime | None:
        """When this box last moved, if within the last 15 minutes. Older records are dropped as they're read."""
        with self._lock:
            at = self._moved.get(machine_id)
            if at is None:
                return None
            if now - at >= MOVE_SHOWN_FOR:
                del self._moved[machine_id]
                return None
            return at


# One per Core process, beside the other in-memory registries.
recent_moves = RecentMoves()
