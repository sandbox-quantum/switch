"""Where the stop reasons come from: what Core already holds, gathered once per list of agents.

- the controller row and its leases (already loaded for the list): offline since, the status report's agent entry
  (a memory stop, a let-go for waiting too long) and its machine block (the daily cap);
- `BudgetStore.standings`, one query for the tenant: a budget covering the agent that's used up;
- `audit_events`, one query: the last restart notice per agent;
- `session_activity_items`, one query: each agent's last finished reply;
- `machine_workspaces` and `cloud_machines`, one query: each controller's box, so a box asleep, stopped by its owner
  or starting (its controller offline on purpose) is never `cant_reach`;
- Core's memory of boxes moved in the last 15 minutes (`recent_moves`);
- The pause and turn-off checks, once per owner: `paused_since` (one read) and `block_reason_in` for this workspace's
  switch. They apply only to agents on a cloud box: a person's own computer is never blocked.

Nothing here writes, and nothing the agent or its box wrote is ever read into a reason: only fixed fields and times.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    Agent,
    AgentController,
    AgentSessionActivityItem,
    AuditEvent,
    CloudMachine,
    MachineWorkspace,
)
from switch_core.db.stores.budget_store import BudgetStanding, BudgetStore
from switch_core.db.stores.hosted_machine_store import (
    idle_sleeping,
    machine_starting,
    owner_stopped,
)
from switch_core.db.stores.session_activity_store import TURN_ITEM_ID
from switch_core.process_lease import ProcessLeases
from switch_core.visibility.hosted_access import block_reason_in, paused_since
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.recent_moves import RecentMoves, recent_moves
from switch_core.visibility.stop_reasons import (
    AgentStopReason,
    ReasonInputs,
    stop_reason,
)


@dataclass
class ReasonSignals:
    budgets: list[BudgetStanding] = field(default_factory=list)
    restart_notices: dict[str, datetime] = field(default_factory=dict)
    last_worked: dict[str, datetime] = field(default_factory=dict)
    # Each controller's cloud machine, where it runs on one.
    boxes: dict[str, CloudMachine] = field(default_factory=dict)
    # Owners paused (when, where known) and owners turned off in this workspace.
    paused: dict[str, datetime | None] = field(default_factory=dict)
    turned_off: set[str] = field(default_factory=set)


async def load_reason_signals(
    session: AsyncSession,
    tenant_id: str,
    agent_ids: Sequence[str],
    budgets: BudgetStore | None = None,
    controller_ids: Sequence[str] = (),
    owner_ids: Sequence[str] = (),
) -> ReasonSignals:
    """The batched signals for these agents: four queries, whatever the number of agents, plus
    the pause and turn-off checks once per owner (a list is one owner's, so that's two or three more)."""
    signals = ReasonSignals()
    if not agent_ids:
        return signals
    signals.budgets = await (budgets or BudgetStore()).standings(
        session, tenant_id=tenant_id, agent_id=None
    )
    notices = await session.execute(
        select(AuditEvent.target_id, func.max(AuditEvent.occurred_at))
        .where(
            AuditEvent.tenant_id == tenant_id,
            AuditEvent.action == AuditAction.AGENT_RESTART_NOTICE_POSTED.value,
            AuditEvent.target_type == "agent",
            AuditEvent.target_id.in_(list(agent_ids)),
        )
        .group_by(AuditEvent.target_id)
    )
    signals.restart_notices = {
        agent_id: at for agent_id, at in notices.all() if at is not None
    }
    worked = await session.execute(
        select(
            AgentSessionActivityItem.agent_id,
            func.max(AgentSessionActivityItem.occurred_at),
        )
        .where(
            AgentSessionActivityItem.tenant_id == tenant_id,
            AgentSessionActivityItem.item_id == TURN_ITEM_ID,
            AgentSessionActivityItem.status == "completed",
            AgentSessionActivityItem.agent_id.in_(list(agent_ids)),
        )
        .group_by(AgentSessionActivityItem.agent_id)
    )
    signals.last_worked = {
        agent_id: at for agent_id, at in worked.all() if at is not None
    }
    if controller_ids:
        boxes = await session.execute(
            select(MachineWorkspace.controller_id, CloudMachine)
            .join(CloudMachine, CloudMachine.id == MachineWorkspace.machine_id)
            .where(
                MachineWorkspace.tenant_id == tenant_id,
                MachineWorkspace.controller_id.in_(list(controller_ids)),
                CloudMachine.state != "deleted",
            )
        )
        signals.boxes = {
            controller_id: machine
            for controller_id, machine in boxes.all()
            if controller_id
        }
    owners = sorted(set(owner_ids))
    since = await paused_since(session, owners)
    for owner in owners:
        # One check, so the reasons and the gate never disagree: a pause wins over a turn-off.
        block = await block_reason_in(session, owner, tenant_id)
        if block == StopReason.PAUSED_BY_SWITCH:
            signals.paused[owner] = since.get(owner)
        elif block == StopReason.TURNED_OFF_BY_ADMIN:
            signals.turned_off.add(owner)
    return signals


def _time(value: Any) -> datetime | None:
    """A time from the status report, or None if it isn't one. Never raises: a box can't break the list."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def agent_entry(
    controller: AgentController | None, agent_id: str
) -> dict[str, Any] | None:
    """The agent's entry in its controller's last stored status report. Read here rather than
    through management's reader: Core doesn't import `switch_core.management`
    (test_import_boundary)."""
    agents = (controller.status or {}).get("agents") if controller is not None else None
    for entry in agents if isinstance(agents, list) else []:
        if isinstance(entry, dict) and entry.get("agent_id") == agent_id:
            return entry
    return None


def _login_missing_since(
    status: dict[str, Any], provider: str | None, now: datetime
) -> datetime | None:
    """When the agent's own provider was found without a usable login, its `auth` reading
    `missing` or `expired` in its controller's providers list, or None; it
    clears when `auth` reads `ok`. Only the agent's provider counts, so another provider's
    missing login on the same box never stops it."""
    if not provider:
        return None
    providers = status.get("providers")
    for entry in providers if isinstance(providers, list) else []:
        if (
            isinstance(entry, dict)
            and entry.get("provider") == provider
            and entry.get("auth") in ("missing", "expired")
        ):
            return _time(entry.get("checked_at")) or now
    return None


def _next_utc_midnight(now: datetime) -> datetime:
    """The gateway counts calls per UTC day, so the daily cap resets at the next UTC midnight."""
    return datetime(now.year, now.month, now.day, tzinfo=UTC) + timedelta(days=1)


def _offline_on_purpose(box: CloudMachine | None) -> bool:
    """A box asleep after a quiet spell, stopped by its owner, or starting: its controller is
    offline on purpose, and the card says Resting or Back in a moment, never `cant_reach`."""
    return box is not None and (
        idle_sleeping(box) or owner_stopped(box) or machine_starting(box)
    )


def reason_inputs(
    agent: Agent,
    controller: AgentController | None,
    leases: ProcessLeases | None,
    signals: ReasonSignals,
    now: datetime,
    moves: RecentMoves = recent_moves,
    provider: str | None = None,
) -> ReasonInputs:
    from switch_core.session_activity.restart_sweep import offline_since

    entry = agent_entry(controller, agent.id) or {}
    status = (controller.status or {}) if controller is not None else {}
    # Bound to a name before the check, so the type narrows: a box could put anything here.
    raw_machine = status.get("machine")
    machine: dict[str, Any] = raw_machine if isinstance(raw_machine, dict) else {}
    capped = machine.get("gateway_capped") is True
    raw_let_go = entry.get("let_go")
    let_go: dict[str, Any] = raw_let_go if isinstance(raw_let_go, dict) else {}
    exhausted = [
        s
        for s in signals.budgets
        if s.exhausted and (s.agent_id is None or s.agent_id == agent.id)
    ]
    box = signals.boxes.get(controller.id) if controller is not None else None
    # Pause and turn-off marks block cloud boxes only; an agent on its owner's own computer is never paused.
    owner = agent.owner_id if box is not None else None
    paused_at: datetime | None = None
    if owner is not None and owner in signals.paused:
        paused_at = signals.paused[owner] or now  # paused, but its time wasn't readable
    reachable_check = (
        controller is not None and leases is not None and not _offline_on_purpose(box)
    )
    return ReasonInputs(
        now=now,
        paused_since=paused_at,
        turned_off=owner is not None and owner in signals.turned_off,
        controller_offline_since=(
            offline_since(controller, leases)
            if reachable_check and controller and leases
            else None
        ),
        # Core records no "capped since"; the report that says so is the nearest time it has.
        capped_since=(_time(status.get("observed_at")) or now) if capped else None,
        cap_resets_at=_next_utc_midnight(now) if capped else None,
        budget_reached=bool(exhausted),
        budget_resets_at=max((s.resets_at for s in exhausted), default=None),
        memory_stopped_since=(
            _time(entry.get("since")) or now
            if entry.get("process") == "stopped"
            and entry.get("reason") == "out_of_memory"
            else None
        ),
        let_go_at=_time(let_go.get("at"))
        if let_go.get("reason") == "timed_out"
        else None,
        # Core's memory of boxes moved in the last 15 minutes, filled by drain's report.
        moved_at=moves.moved_at(box.id, now) if box is not None else None,
        # The agent's own provider reports its login missing on this box.
        login_needed_since=(
            _login_missing_since(status, provider, now) if box is not None else None
        ),
        restart_notice_at=signals.restart_notices.get(agent.id),
        last_worked_at=signals.last_worked.get(agent.id),
    )


def stop_reason_view(reason: AgentStopReason | None) -> dict[str, Any] | None:
    """The API's `stop_reason`: a fixed code and times, never text."""
    if reason is None:
        return None
    return {
        "code": reason.code.value,
        "since": reason.since.isoformat() if reason.since is not None else None,
        "reset_at": reason.reset_at.isoformat()
        if reason.reset_at is not None
        else None,
    }


def agent_stop_reason(
    agent: Agent,
    controller: AgentController | None,
    leases: ProcessLeases | None,
    signals: ReasonSignals,
    now: datetime,
    provider: str | None = None,
) -> dict[str, Any] | None:
    return stop_reason_view(
        stop_reason(
            reason_inputs(agent, controller, leases, signals, now, provider=provider)
        )
    )
