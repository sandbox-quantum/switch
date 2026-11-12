"""Turns cut off by a box that never came back.

A box that comes back tells each room whose turn it lost ("I was restarted
…", posted under `restart:<command>` through its controller). A box that
never comes back can't: its turns would read "Working…" for ever and the
person would hear nothing. So once a controller has been offline for
`OFFLINE_AFTER`, this marks its agents' unfinished turns interrupted (each
card redraws from the row, as for any other change) and posts the same line
as the agent, under the same key. Whichever of the box and Core posts first,
the room gets the line once.

Run in every Core process, every minute, by the session-activity upkeep
(`maintenance.py`). Nothing needs a lease: a turn is interrupted by a
conditional update that only one writer can win, and the line is keyed per
agent (uq_messages_sender_client_txn), so two sweepers, or a sweeper and the
box, never both post.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    AgentController,
    AgentDefinition,
    AgentSessionActivityItem,
    CloudMachine,
    MachineWorkspace,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.session_activity_store import TURN_ITEM_ID
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.delivery.restart_notice import RESTART_NOTICE_TEXT, restart_notice_key
from switch_core.process_lease import ProcessLeases, read_leases

logger = logging.getLogger(__name__)

# Long past any restart, roll or upgrade (a box is back in under a minute), so
# only a box that is really gone is spoken for.
OFFLINE_AFTER = timedelta(minutes=10)

UNFINISHED = ("queued", "running")


@dataclass(frozen=True)
class CutOffTurn:
    tenant_id: str
    agent_id: str
    session_id: str
    turn_id: str
    command_id: str | None
    room_id: str | None
    thread_id: str | None
    message_id: str | None

    @property
    def key(self) -> str:
        """The key the box posts its own line under: the command the turn ran.
        Only asked of a turn that has one (`sweep_tenant`)."""
        assert self.command_id is not None
        return restart_notice_key(self.command_id)

    @property
    def thread_root_id(self) -> str | None:
        """Where the box puts its line: the turn's thread, or the room's top
        level for a message asked there (whose row names the message itself)."""
        return None if self.thread_id == self.message_id else self.thread_id


PostAsAgent = Callable[..., Awaitable[str | None]]


def offline_since(
    controller: AgentController, leases: ProcessLeases
) -> datetime | None:
    """When the controller went offline, or None while it is online (or was
    never connected, or is revoked: its owner removed the machine, and that is
    said in its own way)."""
    if controller.revoked_at is not None or controller.api_key_id is None:
        return None
    if controller.connected_at is None:
        return None
    if controller.disconnected_at is not None:
        return controller.disconnected_at
    if leases.holds(controller.connection_process_id):
        return None
    # Its Core process stopped holding it without writing the disconnect. Once
    # that process's lease is pruned there is no time left, and the connection
    # is at least that old.
    ended, _why = leases.ended(controller.connection_process_id)
    return ended or controller.connected_at


async def _interrupt_turns(
    db: AsyncSession, tenant_id: str, offline_after: timedelta, now: datetime | None
) -> list[CutOffTurn]:
    leases = await read_leases(db, SwitchCoreProcessStore())
    clock = now or leases.read_at
    # Only controllers on a v2 box (sweep row 4): a person's own computer that
    # sleeps mid-turn, or a v1 machine, keeps upstream's behaviour.
    controllers = (
        (
            await db.execute(
                select(AgentController)
                .join(
                    MachineWorkspace,
                    MachineWorkspace.controller_id == AgentController.id,
                )
                .join(CloudMachine, CloudMachine.id == MachineWorkspace.machine_id)
                .where(CloudMachine.backend == "box")
            )
        )
        .scalars()
        .all()
    )
    gone = [
        c.id
        for c in controllers
        if (since := offline_since(c, leases)) is not None
        and clock - since >= offline_after
    ]
    if not gone:
        return []
    agents = select(AgentDefinition.agent_id).where(
        AgentDefinition.controller_id.in_(gone)
    )
    result = await db.execute(
        update(AgentSessionActivityItem)
        .where(
            AgentSessionActivityItem.item_id == TURN_ITEM_ID,
            AgentSessionActivityItem.status.in_(UNFINISHED),
            AgentSessionActivityItem.agent_id.in_(agents),
        )
        .values(
            status="interrupted",
            # Past the host's own, so the card redraws; a box that comes back
            # late can't move an ended turn back (report_item).
            revision=AgentSessionActivityItem.revision + 1,
        )
        .returning(
            AgentSessionActivityItem.agent_id,
            AgentSessionActivityItem.session_id,
            AgentSessionActivityItem.turn_id,
            AgentSessionActivityItem.command_id,
            AgentSessionActivityItem.room_id,
            AgentSessionActivityItem.thread_id,
            AgentSessionActivityItem.message_id,
        )
    )
    return [
        CutOffTurn(tenant_id, *row)  # type: ignore[arg-type]
        for row in result.all()
    ]


async def sweep_tenant(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    post_as_agent: PostAsAgent,
    *,
    offline_after: timedelta = OFFLINE_AFTER,
    now: datetime | None = None,
) -> list[CutOffTurn]:
    """One tenant's pass, with the tenant bound by the caller. Returns the
    turns it interrupted. Tenants are enumerated by the session-activity
    upkeep (`maintenance.py`), the module allowed to ask which tenants exist."""
    async with tenant_session(session_factory, tenant_id) as db, db.begin():
        turns = await _interrupt_turns(db, tenant_id, offline_after, now)
    for turn in turns:
        logger.info(
            "Turn %s of agent %s was cut off by its box going offline; "
            "marked interrupted",
            turn.turn_id,
            turn.agent_id,
        )
        if turn.room_id is None:
            continue
        if turn.command_id is None:
            # The box keys its line on the command that started the turn; with
            # none to match, a line posted here could be a second one.
            logger.info(
                "Turn %s of agent %s has no command id; its room is not told here",
                turn.turn_id,
                turn.agent_id,
            )
            continue
        try:
            event_id = await post_as_agent(
                tenant_id,
                turn.agent_id,
                turn.room_id,
                RESTART_NOTICE_TEXT,
                thread_root_id=turn.thread_root_id,
                client_txn_id=turn.key,
            )
            if event_id is not None:
                async with tenant_session(session_factory, tenant_id) as db:
                    await record_audit_event(
                        db,
                        tenant_id=tenant_id,
                        actor_user_id=None,
                        action=AuditAction.AGENT_RESTART_NOTICE_POSTED,
                        target_type="agent",
                        target_id=turn.agent_id,
                        details={
                            "by": "core_sweep",
                            "room_id": turn.room_id,
                            "thread_id": turn.thread_root_id,
                            "turn_id": turn.turn_id,
                            "command_id": turn.command_id,
                            "event_id": event_id,
                        },
                    )
                    await db.commit()
        except Exception:
            # The turn reads interrupted either way; the box, if it ever comes
            # back, still owes the line under the same key.
            logger.exception(
                "Could not tell room %s that turn %s was cut off",
                turn.room_id,
                turn.turn_id,
            )
    return turns
