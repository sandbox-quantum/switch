"""A condition that can hold for every message, logged at most once a minute.

The per-message telemetry runs once per message, so a condition that persists
— a full buffer, a database that will not answer — would otherwise write one
warning per message and bury the server's own log at the moment an operator
needs it most.
"""

from __future__ import annotations

import time


class WarningThrottle:
    """Counts occurrences of one condition and says when to log them.

    `note` records an occurrence. It returns how many there have been since
    the last time it said to log, this one included, when the interval has
    passed, and None while it has not. The first occurrence always logs.

    `take_pending` hands back what was counted but not yet logged, for a
    caller about to stop that would otherwise lose the tally of a quiet
    stretch at the end.
    """

    def __init__(self, interval_seconds: float) -> None:
        self._interval = interval_seconds
        self._pending = 0
        self._last_logged: float | None = None

    def note(self) -> int | None:
        self._pending += 1
        now = time.monotonic()
        if self._last_logged is not None and now - self._last_logged < self._interval:
            return None
        count, self._pending = self._pending, 0
        self._last_logged = now
        return count

    def take_pending(self) -> int:
        count, self._pending = self._pending, 0
        return count
