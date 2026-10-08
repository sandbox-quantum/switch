"""The rate limit on warnings that could otherwise fire once per message."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.telemetry import throttle
from switch_core.telemetry.throttle import WarningThrottle


class _Clock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock(5.0)
    monkeypatch.setattr(throttle, "time", SimpleNamespace(monotonic=fake))
    return fake


def test_the_first_occurrence_logs_even_just_after_boot(clock: _Clock) -> None:
    """The monotonic clock counts from boot, so a "last logged at 0" start
    would swallow every warning for the first minute of a fresh host."""
    assert WarningThrottle(60.0).note() == 1


def test_occurrences_inside_the_interval_are_counted_not_logged(
    clock: _Clock,
) -> None:
    warnings = WarningThrottle(60.0)
    warnings.note()

    clock.now += 30
    assert warnings.note() is None
    assert warnings.note() is None

    clock.now += 31
    assert warnings.note() == 3


def test_what_was_never_logged_can_be_taken_at_the_end(clock: _Clock) -> None:
    warnings = WarningThrottle(60.0)
    warnings.note()
    warnings.note()
    warnings.note()

    assert warnings.take_pending() == 2
    assert warnings.take_pending() == 0
