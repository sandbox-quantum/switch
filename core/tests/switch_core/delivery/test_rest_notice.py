"""The line a room gets when an agent's background processes were stopped at
rest: the agreed wording, a count only, and one key per
wake so a retry posts nothing twice."""

from __future__ import annotations

from switch_core.delivery.rest_notice import rest_notice_key, rest_notice_text


def test_one_process_reads_in_the_singular() -> None:
    assert rest_notice_text(1) == (
        "When I went to rest, I stopped 1 background process I'd left running. "
        "Start it again if you still need it."
    )


def test_several_read_in_the_plural_with_the_count() -> None:
    assert rest_notice_text(3) == (
        "When I went to rest, I stopped 3 background processes I'd left running. "
        "Start them again if you still need them."
    )


def test_the_key_is_scoped_to_rest_notices() -> None:
    assert rest_notice_key("wake-1") == "rest:wake-1"
    assert rest_notice_key("wake-1") != "restart:wake-1"
