"""A token bucket for outbound IRC lines, so a long reply or a command burst
never floods the connection and trips a server's own throttle."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable


class TokenBucket:
    """Classic token bucket: `capacity` tokens, refilling at `refill_per_second`.

    `acquire` waits rather than raising — a flood is paced, not dropped —
    since the caller's line still has to reach the channel, just not all at
    once. `clock` is injectable so tests advance time without sleeping.
    """

    def __init__(
        self,
        capacity: float,
        refill_per_second: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._capacity = capacity
        self._refill_per_second = refill_per_second
        self._clock = clock
        self._sleep = sleep
        self._tokens = capacity
        self._last_refill = clock()

    def _refill(self) -> None:
        now = self._clock()
        elapsed = max(0.0, now - self._last_refill)
        self._tokens = min(
            self._capacity, self._tokens + elapsed * self._refill_per_second
        )
        self._last_refill = now

    async def acquire(self, cost: float = 1.0) -> None:
        while True:
            self._refill()
            if self._tokens >= cost:
                self._tokens -= cost
                return
            short_by = cost - self._tokens
            wait = short_by / self._refill_per_second
            await self._sleep(wait)
