"""Why an agent stopped or can't take work: one fixed list.

Shared by Core, Console and the room line, so the same code always means the
same thing to the person reading it. A reason is only ever one of these codes,
never anything the agent itself wrote.
"""

from __future__ import annotations

from enum import StrEnum


class StopReason(StrEnum):
    MEMORY_GUARD = "memory_guard"
    BOX_RESTARTED = "box_restarted"
    BOX_MOVED = "box_moved"
    WAITING_TOO_LONG = "waiting_too_long"
    DAILY_CAP_REACHED = "daily_cap_reached"
    # A workspace budget (`usage_budgets`, checked by `BudgetGuard`) is used up.
    BUDGET_REACHED = "budget_reached"
    PAUSED_BY_SWITCH = "paused_by_switch"
    TURNED_OFF_BY_ADMIN = "turned_off_by_admin"
    # The agent's provider login is missing (for example after a resume or a
    # turn-on revoked it), from `provider_login_missing`.
    LOGIN_NEEDED = "login_needed"
    CANT_REACH = "cant_reach"
