"""A rolling hourly limit on the segments sent to each phone number.

Stops an agent stuck in a loop, which a limit per reply cannot: two hundred
short replies are each within it. Held in memory, so each server counts its own
and a restart forgets. That is safe to lose, since it only ever sends less than
Twilio would, and the docs page tells the operator to set a Twilio usage trigger
as the hard limit.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable

_WINDOW_SECONDS = 3600.0


class HourlyBudget:
    def __init__(
        self, limit: int, *, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._limit = limit
        self._clock = clock
        self._spent: dict[str, deque[tuple[float, int]]] = {}

    def remaining(self, number: str) -> int:
        spent = self._spent.get(number)
        if spent is None:
            return self._limit
        horizon = self._clock() - _WINDOW_SECONDS
        while spent and spent[0][0] <= horizon:
            spent.popleft()
        if not spent:
            del self._spent[number]
            return self._limit
        return max(0, self._limit - sum(segments for _, segments in spent))

    def spend(self, number: str, segments: int) -> None:
        self._spent.setdefault(number, deque()).append((self._clock(), segments))
