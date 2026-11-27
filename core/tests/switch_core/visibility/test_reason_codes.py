"""The stop reasons are exactly the spec's fixed list."""

from switch_core.visibility.reason_codes import StopReason


def test_the_list_is_the_spec_list() -> None:
    assert [r.value for r in StopReason] == [
        "memory_guard",
        "box_restarted",
        "box_moved",
        "waiting_too_long",
        "daily_cap_reached",
        "budget_reached",
        "paused_by_switch",
        "turned_off_by_admin",
        "login_needed",
        "cant_reach",
    ]
