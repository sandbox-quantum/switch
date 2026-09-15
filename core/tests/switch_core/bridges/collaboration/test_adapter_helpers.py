"""Shared helpers on the collaboration adapter base class.

These have no platform of their own, so they are tested here rather than in
whichever adapter happened to call them first.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.adapter import format_elapsed


def test_elapsed_is_written_the_way_it_is_read() -> None:
    assert format_elapsed(0.4) == "0s"
    assert format_elapsed(8.9) == "8s"
    assert format_elapsed(59) == "59s"
    assert format_elapsed(60) == "1m00s"
    assert format_elapsed(134) == "2m14s"
    assert format_elapsed(3600) == "1h00m"
    assert format_elapsed(3780) == "1h03m"
    # A clock that ran backwards is not a negative duration.
    assert format_elapsed(-5) == "0s"
