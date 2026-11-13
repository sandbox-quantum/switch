"""Why an agent stopped or can't take work.

Core decides one reason per agent from what it already holds, and Console and the room only show it, using the
words below. A reason is only ever a fixed code from `StopReason`, plus times: never anything the agent or its
box wrote. `stop_reason()` is pure, so every code can be forced on its own in tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from switch_core.visibility.reason_codes import StopReason

# A controller that dropped off for less than this is a blip, not a reason the user needs to see.
CANT_REACH_AFTER = timedelta(seconds=60)
# How long "your cloud restarted" stays up if the agent doesn't work again first.
RESTARTED_SHOWN_FOR = timedelta(minutes=30)
# At most one room line per reason per agent in this time; the copy doc's hourly rule for the
# paused and turned-off lines is longer and wins for those.
ROOM_LINE_EVERY = timedelta(minutes=10)


@dataclass(frozen=True)
class AgentStopReason:
    code: StopReason
    since: (
        datetime | None
    )  # None where Core holds no start time (a budget: only its reset)
    reset_at: datetime | None = None  # the daily cap and budgets only


@dataclass(frozen=True)
class ReasonInputs:
    """A snapshot of what Core knows about one agent. Each field is None when that signal isn't present."""

    now: datetime
    paused_since: datetime | None = None  # the paused mark
    turned_off: bool = False  # the per-workspace switch; a turn-off has no time
    login_needed_since: datetime | None = (
        None  # the agent's provider reports `provider_login_missing`
    )
    controller_offline_since: datetime | None = None  # the connection ledger
    capped_since: datetime | None = (
        None  # `machine.gateway_capped` in the status report
    )
    cap_resets_at: datetime | None = None
    budget_reached: bool = (
        False  # `BudgetGuard`'s standings: a budget covering it is used up
    )
    budget_resets_at: datetime | None = None
    memory_stopped_since: datetime | None = (
        None  # the agent's process: stopped, reason: out_of_memory
    )
    let_go_at: datetime | None = None  # the box let a message go for waiting too long
    moved_at: datetime | None = None  # the cluster's placement-move report
    restart_notice_at: datetime | None = (
        None  # the last restart notice posted for this agent
    )
    last_worked_at: datetime | None = None  # the agent's last finished reply


def _after_last_work(at: datetime | None, inputs: ReasonInputs) -> bool:
    return at is not None and (
        inputs.last_worked_at is None or at > inputs.last_worked_at
    )


def stop_reason(inputs: ReasonInputs) -> AgentStopReason | None:
    """The one reason to show, in this order (the first that applies wins), or None when the agent can work."""
    if inputs.paused_since is not None:
        return AgentStopReason(StopReason.PAUSED_BY_SWITCH, inputs.paused_since)
    if inputs.turned_off:
        return AgentStopReason(StopReason.TURNED_OFF_BY_ADMIN, None)
    offline = inputs.controller_offline_since
    if offline is not None and inputs.now - offline >= CANT_REACH_AFTER:
        return AgentStopReason(StopReason.CANT_REACH, offline)
    # After can't reach: a box Core can't reach has a stale provider report.
    if inputs.login_needed_since is not None:
        return AgentStopReason(StopReason.LOGIN_NEEDED, inputs.login_needed_since)
    if inputs.capped_since is not None:
        return AgentStopReason(
            StopReason.DAILY_CAP_REACHED, inputs.capped_since, inputs.cap_resets_at
        )
    if inputs.budget_reached:
        return AgentStopReason(StopReason.BUDGET_REACHED, None, inputs.budget_resets_at)
    if inputs.memory_stopped_since is not None:
        return AgentStopReason(StopReason.MEMORY_GUARD, inputs.memory_stopped_since)
    # The three below clear once the agent works again.
    if _after_last_work(inputs.let_go_at, inputs):
        assert inputs.let_go_at is not None
        return AgentStopReason(StopReason.WAITING_TOO_LONG, inputs.let_go_at)
    if _after_last_work(inputs.moved_at, inputs):
        assert inputs.moved_at is not None
        return AgentStopReason(StopReason.BOX_MOVED, inputs.moved_at)
    notice = inputs.restart_notice_at
    if (
        _after_last_work(notice, inputs)
        and notice is not None
        and inputs.now - notice < RESTARTED_SHOWN_FOR
    ):
        return AgentStopReason(StopReason.BOX_RESTARTED, notice)
    return None


# ---- the words: one table ----
# Console holds a copy of the headings and "what to do" lines; a test on each side checks it against this one.


@dataclass(frozen=True)
class ReasonWords:
    heading: str  # the Status panel's heading
    what_to_do: str  # its one "What to do" line
    restart_helps: bool = False  # the panel offers "Restart agent"


WORDS: dict[StopReason, ReasonWords] = {
    StopReason.MEMORY_GUARD: ReasonWords(
        "Stopped: this agent used too much memory",
        "Send again; try a smaller task",
        restart_helps=True,
    ),
    StopReason.BOX_RESTARTED: ReasonWords(
        "Your cloud restarted", "Send again if a reply was cut off"
    ),
    StopReason.BOX_MOVED: ReasonWords(
        "Your cloud moved to another machine", "Nothing; it's back in a moment"
    ),
    StopReason.WAITING_TOO_LONG: ReasonWords(
        "Still waiting for room after {minutes} minutes", "Try again later"
    ),
    StopReason.DAILY_CAP_REACHED: ReasonWords(
        "Today's AI limit reached", "It resets at the time shown"
    ),
    StopReason.BUDGET_REACHED: ReasonWords(
        "A budget for this agent has been reached",
        "Ask a workspace admin to raise the budget, or wait until it resets",
    ),
    StopReason.PAUSED_BY_SWITCH: ReasonWords("Paused by Switch", "Contact your admin"),
    StopReason.TURNED_OFF_BY_ADMIN: ReasonWords(
        "Hosted agents turned off by your admin", "Ask your admin to turn it on"
    ),
    StopReason.LOGIN_NEEDED: ReasonWords(
        "Your AI login needs setting up again",
        "Give your AI login once more in Add agent → Set up AI provider. "
        "Your agents and their work are all still there.",
    ),
    StopReason.CANT_REACH: ReasonWords(
        "Can't reach your cloud right now",
        "We're on it; try again in a few minutes",
        restart_helps=True,
    ),
}

# The room lines Core posts, as the agent. `memory_guard` and `waiting_too_long` are posted by the box, which
# knows first; `budget_reached` is BudgetGuard's existing refusal; `box_moved` only when a reply was cut off.
# The owner is named as the existing auto-replies do ("my owner (@handle)", or "my owner" with no handle on
# the room's bridge); `{resets}` is a UTC time. Both are filled by Core: never agent text.
ROOM_LINES: dict[StopReason, str] = {
    StopReason.BOX_RESTARTED: "I was restarted while working on this and lost my reply. Please send it again.",
    StopReason.BOX_MOVED: (
        "My cloud moved to another machine while I was working on this, and my reply was cut off. "
        "Please send it again."
    ),
    StopReason.DAILY_CAP_REACHED: (
        "{owner_ref} has reached today's AI limit, so I can't start on this. It resets at {resets}. "
        "Send it again after that."
    ),
    StopReason.PAUSED_BY_SWITCH: (
        "Switch has paused hosted agents for {owner_ref_lower}, so I can't answer. This message won't be "
        "answered later. Contact your workspace admin."
    ),
    StopReason.TURNED_OFF_BY_ADMIN: (
        "Hosted agents are turned off for {owner_ref_lower}, so I can't answer. This message won't be "
        "answered later. Ask your workspace admin to turn them back on."
    ),
    StopReason.CANT_REACH: (
        "I can't reach my cloud right now, and Switch is on it. If I haven't answered in a few minutes, "
        "send this again."
    ),
}
ROOM_LINE_EVERY_BY_CODE: dict[StopReason, timedelta] = {
    StopReason.PAUSED_BY_SWITCH: timedelta(hours=1),
    StopReason.TURNED_OFF_BY_ADMIN: timedelta(hours=1),
}
# `login_needed` is the box's existing start-failure line, posted by the box.
BOX_POSTS = frozenset(
    {StopReason.MEMORY_GUARD, StopReason.WAITING_TOO_LONG, StopReason.LOGIN_NEEDED}
)


def heading(code: StopReason, wait_limit_minutes: int = 10) -> str:
    """The Status panel heading, with the wait limit filled in so it always matches the setting."""
    return WORDS[code].heading.format(minutes=wait_limit_minutes)


def room_line(
    code: StopReason, owner_handle: str | None, resets_at: datetime | None = None
) -> str | None:
    """The line Core posts for a reason, or None where the box or BudgetGuard posts it instead.
    `owner_handle` is the owner's handle on the room's bridge (no "@"), or None, as `owner_handle_in`
    gives it."""
    template = ROOM_LINES.get(code)
    if template is None:
        return None
    ref = f"my owner (@{owner_handle})" if owner_handle else "my owner"
    # The gateway counts calls per UTC day, so the cap always resets at 00:00 UTC.
    resets = resets_at.strftime("%H:%M UTC") if resets_at is not None else "00:00 UTC"
    return template.format(
        owner_ref=ref[0].upper() + ref[1:], owner_ref_lower=ref, resets=resets
    )


def room_line_due(
    code: StopReason, last_posted_at: datetime | None, now: datetime
) -> bool:
    """Whether a new line may go out for this reason: at most one per agent per window, so a box that flaps
    doesn't flood the room."""
    every = ROOM_LINE_EVERY_BY_CODE.get(code, ROOM_LINE_EVERY)
    return last_posted_at is None or now - last_posted_at >= every
