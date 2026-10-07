"""Rows for hosted-machine tests, written straight to the session (flushed, not committed)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentController, HostedMachine


async def seed_machine(
    session: AsyncSession,
    *,
    owner_id: str,
    slot_id: str,
    state: str,
    desired_state: str,
    stop_reason: str | None,
    revision: int,
    generation: int,
) -> HostedMachine:
    now = datetime.now(UTC)
    machine = HostedMachine(
        id=str(uuid4()),
        owner_id=owner_id,
        slot_id=slot_id,
        state=state,
        desired_state=desired_state,
        stop_reason=stop_reason,
        revision=revision,
        generation=generation,
        active_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(machine)
    await session.flush()
    return machine


class LinkingControllers:
    """Links a machine to a new ec2 controller, as agent management does for
    an owner's first machine."""

    async def cloud_controller(self, session, machine):
        if machine.controller_id is not None:
            linked = await session.scalar(
                select(AgentController).where(
                    AgentController.id == machine.controller_id
                )
            )
            return linked, False
        controller = AgentController(
            owner_id=machine.owner_id, name="Switch cloud", kind="ec2"
        )
        session.add(controller)
        await session.flush()
        machine.controller_id = controller.id
        return controller, True
