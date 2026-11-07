"""The outbound token bucket, with an injected clock/sleep so the test
advances time instead of actually waiting."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.irc.ratelimit import TokenBucket


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _bucket(
    capacity: float, refill: float, clock: _FakeClock
) -> tuple[TokenBucket, list[float]]:
    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)
        clock.advance(seconds)

    return TokenBucket(capacity, refill, clock=clock, sleep=fake_sleep), waits


async def test_spends_available_tokens_without_waiting() -> None:
    bucket, waits = _bucket(5, 1, _FakeClock())
    for _ in range(5):
        await bucket.acquire()
    assert waits == []


async def test_waits_for_a_refill_once_the_bucket_is_empty() -> None:
    bucket, waits = _bucket(2, 1, _FakeClock())
    await bucket.acquire()
    await bucket.acquire()
    await bucket.acquire()  # bucket is now empty: must wait for one token
    assert waits == [pytest.approx(1.0)]


async def test_refills_over_elapsed_time_before_the_next_wait() -> None:
    clock = _FakeClock()
    bucket, waits = _bucket(3, 1, clock)
    await bucket.acquire(3)
    clock.advance(2)  # two tokens refilled without a wait
    await bucket.acquire(2)
    assert waits == []
    await bucket.acquire(3)  # bucket is empty again: must wait for all 3
    assert waits == [pytest.approx(3.0)]


async def test_never_accrues_more_than_capacity() -> None:
    clock = _FakeClock()
    bucket, waits = _bucket(2, 1, clock)
    clock.advance(1000)  # a very long idle period
    await bucket.acquire(2)  # capacity caps it at 2, not 1000
    await bucket.acquire(1)  # so this must wait, rather than spend idle credit
    assert waits == [pytest.approx(1.0)]
