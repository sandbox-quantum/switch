"""How what Core already holds becomes a reason, without a database: the controller row, its status report and
the batched signals, each mapped on its own."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from switch_core.db.models import Agent, AgentController
from switch_core.db.stores.budget_store import BudgetStanding
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.stop_reason_sources import (
    ReasonSignals,
    agent_stop_reason,
    reason_inputs,
    stop_reason_view,
)
from switch_core.visibility.stop_reasons import AgentStopReason

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
AGENT = Agent(id="agent-a", name="a")


def controller(
    *, agent: dict | None = None, machine: dict | None = None
) -> AgentController:
    entry = {
        "agent_id": AGENT.id,
        "process": "running",
        "since": "2026-10-29T11:00:00Z",
        **(agent or {}),
    }
    return AgentController(
        id="c1",
        status={
            "observed_at": "2026-10-29T11:58:00Z",
            "machine": machine or {},
            "agents": [entry],
        },
    )


def budget(
    agent_id: str | None, spent: int, limit: int = 10, resets: int = 5
) -> BudgetStanding:
    return BudgetStanding(
        id=f"b-{agent_id}-{resets}",
        agent_id=agent_id,
        agent_name=None,
        metric="messages",
        model="",
        amount_limit=limit,
        period_hours=24,
        spent=spent,
        resets_at=NOW + timedelta(hours=resets),
    )


def code(
    ctrl: AgentController | None, signals: ReasonSignals | None = None
) -> str | None:
    view = agent_stop_reason(AGENT, ctrl, None, signals or ReasonSignals(), NOW)
    return view and view["code"]


def test_a_healthy_agent_has_no_reason():
    assert code(controller()) is None
    assert code(None) is None


def test_a_memory_stop_in_the_status_report_is_memory_guard_since_the_reported_time():
    inputs = reason_inputs(
        AGENT,
        controller(agent={"process": "stopped", "reason": "out_of_memory"}),
        None,
        ReasonSignals(),
        NOW,
    )
    assert inputs.memory_stopped_since == datetime(2026, 10, 29, 11, 0, tzinfo=UTC)
    assert (
        code(controller(agent={"process": "stopped", "reason": "out_of_memory"}))
        == "memory_guard"
    )
    assert code(controller(agent={"process": "stopped", "reason": "owner"})) is None


def test_a_let_go_for_timing_out_is_waiting_too_long():
    let_go = {"let_go": {"at": "2026-10-29T11:50:00Z", "reason": "timed_out"}}
    assert code(controller(agent=let_go)) == "waiting_too_long"
    worked = ReasonSignals(
        last_worked={AGENT.id: datetime(2026, 10, 29, 11, 55, tzinfo=UTC)}
    )
    assert (
        code(controller(agent=let_go), worked) is None
    )  # it worked since, so it's cleared


def test_the_daily_cap_resets_at_the_next_utc_midnight():
    view = agent_stop_reason(
        AGENT, controller(machine={"gateway_capped": True}), None, ReasonSignals(), NOW
    )
    assert view == {
        "code": "daily_cap_reached",
        "since": "2026-10-29T11:58:00+00:00",
        "reset_at": "2026-10-30T00:00:00+00:00",
    }
    assert code(controller(machine={"gateway_capped": False})) is None
    assert (
        code(controller(machine={"gateway_capped": "yes"})) is None
    )  # only a real true counts


def test_a_used_up_budget_covering_this_agent_counts_and_others_dont():
    mine = ReasonSignals(budgets=[budget(AGENT.id, spent=10)])
    workspace = ReasonSignals(budgets=[budget(None, spent=12)])
    other_agent = ReasonSignals(budgets=[budget("agent-b", spent=99)])
    not_used_up = ReasonSignals(budgets=[budget(AGENT.id, spent=9)])
    assert code(controller(), mine) == "budget_reached"
    assert code(controller(), workspace) == "budget_reached"
    assert code(controller(), other_agent) is None
    assert code(controller(), not_used_up) is None
    two = ReasonSignals(
        budgets=[budget(AGENT.id, 10, resets=2), budget(None, 10, resets=9)]
    )
    view = agent_stop_reason(AGENT, controller(), None, two, NOW)
    assert (
        view["since"] is None
        and view["reset_at"] == (NOW + timedelta(hours=9)).isoformat()
    )  # the later


def test_a_restart_notice_shows_until_the_agent_works_again():
    notice = datetime(2026, 10, 29, 11, 50, tzinfo=UTC)
    assert (
        code(controller(), ReasonSignals(restart_notices={AGENT.id: notice}))
        == "box_restarted"
    )
    worked = ReasonSignals(
        restart_notices={AGENT.id: notice},
        last_worked={AGENT.id: notice + timedelta(minutes=1)},
    )
    assert code(controller(), worked) is None


class Leases:
    def __init__(self, holds: bool):
        self._holds = holds

    def holds(self, process_id):
        return self._holds

    def ended(self, process_id):
        return (NOW - timedelta(minutes=3), "lost")


def test_a_controller_offline_for_over_a_minute_is_cant_reach():
    ctrl = controller()
    ctrl.api_key_id = "k"
    ctrl.connected_at = NOW - timedelta(hours=1)
    ctrl.connection_process_id = "p"
    assert (
        agent_stop_reason(AGENT, ctrl, Leases(holds=True), ReasonSignals(), NOW) is None
    )
    view = agent_stop_reason(AGENT, ctrl, Leases(holds=False), ReasonSignals(), NOW)
    assert view["code"] == "cant_reach"
    ctrl.disconnected_at = NOW - timedelta(seconds=30)  # a blip
    assert (
        agent_stop_reason(AGENT, ctrl, Leases(holds=False), ReasonSignals(), NOW)
        is None
    )


def test_a_box_cant_break_the_list_with_bad_times():
    bad = controller(
        agent={"process": "stopped", "reason": "out_of_memory", "since": "not a time"}
    )
    assert code(bad) == "memory_guard"  # falls back to now rather than failing
    assert code(controller(agent={"let_go": {"at": 12, "reason": "timed_out"}})) is None
    assert code(controller(agent={"let_go": "weird"})) is None


def test_the_api_view_is_a_code_and_times_only():
    reason = AgentStopReason(StopReason.CANT_REACH, NOW)
    assert stop_reason_view(reason) == {
        "code": "cant_reach",
        "since": NOW.isoformat(),
        "reset_at": None,
    }
    assert stop_reason_view(None) is None


def test_a_recorded_move_shows_as_box_moved_for_15_minutes():
    from switch_core.db.models import CloudMachine
    from switch_core.visibility.recent_moves import RecentMoves
    from switch_core.visibility.stop_reasons import stop_reason

    moves = RecentMoves()
    ctrl = controller()
    box = CloudMachine(id="m1", state="ready", desired_state="running")
    on_box = ReasonSignals(boxes={ctrl.id: box})
    assert reason_inputs(AGENT, ctrl, None, on_box, NOW, moves).moved_at is None
    moves.record("m1", NOW - timedelta(minutes=14))
    # no box known for the controller, no move
    assert (
        reason_inputs(AGENT, ctrl, None, ReasonSignals(), NOW, moves).moved_at is None
    )
    inputs = reason_inputs(AGENT, ctrl, None, on_box, NOW, moves)
    assert inputs.moved_at == NOW - timedelta(minutes=14)
    assert stop_reason(inputs).code == StopReason.BOX_MOVED
    later = NOW + timedelta(minutes=1)
    assert moves.moved_at("m1", later) is None  # 15 minutes passed: dropped
    assert moves.moved_at("m1", later) is None


def test_a_box_offline_on_purpose_is_never_cant_reach():
    from switch_core.db.models import CloudMachine

    ctrl = controller()
    ctrl.api_key_id = "k"
    ctrl.connected_at = NOW - timedelta(hours=1)
    ctrl.connection_process_id = "p"
    lost = Leases(holds=False)
    asleep = CloudMachine(
        id="m", state="stopped", desired_state="stopped", stop_reason="idle"
    )
    stopped = CloudMachine(
        id="m", state="stopped", desired_state="stopped", stop_reason="owner"
    )
    starting = CloudMachine(id="m", state="provisioning", desired_state="running")
    running = CloudMachine(id="m", state="ready", desired_state="running")
    for box in (asleep, stopped, starting):
        signals = ReasonSignals(boxes={ctrl.id: box})
        assert agent_stop_reason(AGENT, ctrl, lost, signals, NOW) is None, box.state
    signals = ReasonSignals(boxes={ctrl.id: running})
    assert agent_stop_reason(AGENT, ctrl, lost, signals, NOW)["code"] == "cant_reach"


def test_the_agents_own_provider_without_a_login_is_login_needed():
    from switch_core.db.models import CloudMachine

    def ctrl(providers):  # type: ignore[no-untyped-def]
        c = controller()
        c.status = {**c.status, "providers": providers}
        return c

    box = ReasonSignals(
        boxes={"c1": CloudMachine(id="m", state="ready", desired_state="running")}
    )
    missing = {
        "provider": "claude",
        "auth": "missing",
        "checked_at": "2026-10-29T11:30:00Z",
    }
    expired = {
        "provider": "claude",
        "auth": "expired",
        "checked_at": "2026-10-29T11:40:00Z",
    }
    view = agent_stop_reason(AGENT, ctrl([missing]), None, box, NOW, provider="claude")
    assert view == {
        "code": "login_needed",
        "since": "2026-10-29T11:30:00+00:00",
        "reset_at": None,
    }
    expired_view = agent_stop_reason(
        AGENT, ctrl([expired]), None, box, NOW, provider="claude"
    )
    assert expired_view["code"] == "login_needed"
    # another provider's missing login, no box, no provider known, or a login that's fine: nothing
    assert (
        agent_stop_reason(AGENT, ctrl([missing]), None, box, NOW, provider="codex")
        is None
    )
    no_box = agent_stop_reason(
        AGENT, ctrl([missing]), None, ReasonSignals(), NOW, provider="claude"
    )
    assert no_box is None
    assert agent_stop_reason(AGENT, ctrl([missing]), None, box, NOW) is None
    for fine in ("ok", "unknown"):
        entry = {"provider": "claude", "auth": fine}
        assert (
            agent_stop_reason(AGENT, ctrl([entry]), None, box, NOW, provider="claude")
            is None
        )


def test_v3s_marks_apply_to_an_agent_on_a_cloud_box_and_a_pause_wins():
    from switch_core.db.models import CloudMachine

    owned = Agent(id=AGENT.id, name="a", owner_id="ada")
    ctrl = controller()
    on_box = {ctrl.id: CloudMachine(id="m", state="ready", desired_state="running")}
    paused_at = NOW - timedelta(hours=2)

    def view(signals: ReasonSignals) -> dict | None:
        return agent_stop_reason(owned, ctrl, None, signals, NOW)

    assert view(ReasonSignals(boxes=on_box, paused={"ada": paused_at})) == {
        "code": "paused_by_switch",
        "since": paused_at.isoformat(),
        "reset_at": None,
    }
    # A turn-off has no time.
    assert view(ReasonSignals(boxes=on_box, turned_off={"ada"})) == {
        "code": "turned_off_by_admin",
        "since": None,
        "reset_at": None,
    }
    both = ReasonSignals(boxes=on_box, paused={"ada": paused_at}, turned_off={"ada"})
    assert view(both)["code"] == "paused_by_switch"
    # Paused, but the time couldn't be read: still paused, from now.
    assert view(ReasonSignals(boxes=on_box, paused={"ada": None}))["since"] == (
        NOW.isoformat()
    )
    # Someone else's mark is not this agent's.
    assert view(ReasonSignals(boxes=on_box, paused={"bob": paused_at})) is None


def test_v3s_marks_never_block_an_agent_on_its_owners_own_computer():
    owned = Agent(id=AGENT.id, name="a", owner_id="ada")
    signals = ReasonSignals(paused={"ada": NOW}, turned_off={"ada"})  # no box
    assert agent_stop_reason(owned, controller(), None, signals, NOW) is None
