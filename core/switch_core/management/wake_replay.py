"""What a cloud machine's controller gets back when it reconnects with no cursor.

A message to an agent whose Switch cloud machine is asleep wakes the machine,
and Switch says "I'll pick this up as soon as it's back". The message is kept
as one of the agent's own events, but a controller resumes each agent from
the cursor it confirmed, and it confirms one only once the agent has taken an
event. An agent that had taken none on that controller (or a controller
enrolled afresh) reconnects at `"head"`, the agent's newest own event:
the message that woke the machine, so the stream starts just past it and the
agent never gets it.

So, with hosted agents v2 on and for a controller on a cloud machine only, a
`"head"` cursor becomes the point just before the agent's own events that
arrived while the controller was down. A controller sends `"head"` only for an
agent it has confirmed nothing for, so nothing it already handled is sent
again. A cursor the controller does send always wins.

When the controller was down:

- the cursor Core last resumed this controller from for the agent
  (`open_cursors`), when it was a number: the controller confirmed nothing past
  it, so a reconnect gets the same events again, at least once;
- otherwise from when it was last seen (its last report, or the end of its
  connection, whichever is earlier);
- otherwise, for a controller with no history of its own (enrolled afresh on
  the same machine), when the machine last reported for this workspace;
- otherwise a few minutes before the machine was last started (a revived box).

Bounded either way: only events from the last `REPLAY_WINDOW`, and at most
`REPLAY_LIMIT` of them, the newest, oldest first. A cut is logged.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import AgentController, CloudMachine, MachineWorkspace
from switch_core.hosted_v2 import process_hosted_v2

logger = logging.getLogger(__name__)

#: How far back a reconnect with no cursor is given the agent's own events.
REPLAY_WINDOW = timedelta(hours=24)
#: At most this many of them: the newest, so a long sleep can't start a burst.
REPLAY_LIMIT = 20
#: Before a revived machine's start, so the message that started it is in.
STARTED_MARGIN = timedelta(minutes=10)


async def resume_cursors_after_wake(
    session: AsyncSession,
    buffer: EventBuffer,
    *,
    tenant_id: str,
    controller_id: str,
    resume_cursors: dict[str, int | None],
    now: datetime,
) -> dict[str, int | None]:
    """`resume_cursors` with each `"head"` (None) of a cloud machine's
    controller replaced by where the agent's missed events start, when it
    missed any. Read before the opening connection is recorded, so the
    controller's own row still says how its last connection went."""
    heads = [agent_id for agent_id, cursor in resume_cursors.items() if cursor is None]
    if not heads or not process_hosted_v2():
        return resume_cursors
    controller = await session.scalar(
        select(AgentController).where(
            AgentController.tenant_id == tenant_id,
            AgentController.id == controller_id,
        )
    )
    if controller is None:
        return resume_cursors
    found = await _machine_of(session, tenant_id, controller_id)
    if found is None:
        # A controller on its owner's own computer: as before.
        return resume_cursors
    machine, workspace = found
    floor = now - REPLAY_WINDOW
    down_since = _down_since(controller, machine, workspace)
    previous = controller.open_cursors or {}
    replaced = dict(resume_cursors)
    for agent_id in heads:
        before = previous.get(agent_id)
        after_seq = before if isinstance(before, int) and before >= 0 else None
        if after_seq is not None:
            since = floor
        elif down_since is not None:
            since = max(floor, down_since)
        else:
            continue
        start = await buffer.replay_start(
            tenant_id, agent_id, after_seq=after_seq, since=since, limit=REPLAY_LIMIT
        )
        if start is None:
            continue
        cursor, cut = start
        replaced[agent_id] = cursor
        logger.info(
            "Controller %s reconnected with no cursor for agent %s: resuming "
            "from %s, so it gets what arrived while it was down",
            controller_id,
            agent_id,
            cursor,
        )
        if cut:
            logger.warning(
                "Controller %s: agent %s missed more than %s events while its "
                "controller was down; only the newest %s are sent",
                controller_id,
                agent_id,
                REPLAY_LIMIT,
                REPLAY_LIMIT,
            )
    return replaced


async def _machine_of(
    session: AsyncSession, tenant_id: str, controller_id: str
) -> tuple[CloudMachine, MachineWorkspace] | None:
    """The cloud machine the controller runs on for this workspace, unlocked."""
    workspace = await session.scalar(
        select(MachineWorkspace).where(
            MachineWorkspace.tenant_id == tenant_id,
            MachineWorkspace.controller_id == controller_id,
        )
    )
    if workspace is None:
        return None
    machine = await session.get(CloudMachine, workspace.machine_id)
    if machine is None or machine.state == "deleted":
        return None
    return machine, workspace


def _down_since(
    controller: AgentController, machine: CloudMachine, workspace: MachineWorkspace
) -> datetime | None:
    """When the controller stopped taking events, as early as is known."""
    own = [t for t in (controller.last_seen_at, controller.disconnected_at) if t]
    if own:
        return min(own)
    reported = _workspace_report_at(machine, workspace)
    if reported is not None:
        return reported
    if machine.active_at is not None:
        return machine.active_at - STARTED_MARGIN
    return None


def _workspace_report_at(
    machine: CloudMachine, workspace: MachineWorkspace
) -> datetime | None:
    """When the machine's controller last reported for this workspace,
    whichever controller that was: the machine's heartbeat keeps it by
    workspace, so it outlives a controller enrolled afresh."""
    reports = (machine.heartbeat or {}).get("controllers")
    if not isinstance(reports, dict):
        return None
    entry = reports.get(workspace.id)
    at = entry.get("at") if isinstance(entry, dict) else None
    if not isinstance(at, str):
        return None
    try:
        return datetime.fromisoformat(at)
    except ValueError:
        return None
