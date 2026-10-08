"""Rows for hosted-machine tests, written straight to the session (flushed, not committed)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import HostedLaunch, HostedMachine


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


async def seed_launch(
    session: AsyncSession,
    *,
    machine: HostedMachine,
    request_id: str,
    name: str,
    state: str,
    desired_state: str,
    revision: int,
    agent_id: str | None,
    spec: dict,
) -> HostedLaunch:
    now = datetime.now(UTC)
    launch = HostedLaunch(
        id=request_id,
        owner_id=machine.owner_id,
        machine_id=machine.id,
        name=name,
        spec=spec,
        state=state,
        desired_state=desired_state,
        revision=revision,
        agent_id=agent_id,
        active_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(launch)
    await session.flush()
    return launch
