from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, cast, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import Text

from switch_core.db.fingerprint import Fingerprint, row_hash
from switch_core.db.models import Agent, AgentController, AgentDefinition


@dataclass(frozen=True)
class Placement:
    """A definition placed on a controller, with what a binding needs of the
    controller: its name, and whether it is revoked. `controller_name` is None
    when the controller's row is gone."""

    agent_id: str
    controller_id: str
    desired_state: str
    controller_name: str | None
    controller_revoked_at: datetime | None


def _placement_hash() -> ColumnElement[int]:
    """What a binding is made of (`management/bindings.py`), so a fingerprint
    of it changes exactly when some binding would."""
    return row_hash(
        AgentDefinition.agent_id,
        func.coalesce(AgentDefinition.controller_id, ""),
        AgentDefinition.desired_state,
        func.coalesce(AgentController.name, ""),
        cast(AgentController.revoked_at.is_not(None), Text),
    )


class DefinitionChanged(Exception):
    """A definition changed between being read and being written."""


class AgentDefinitionStore:
    """Managed agent definitions, one per agent.

    Every read names its tenant as well as relying on the policy, for the
    reason `JoinDomainStore` gives.
    """

    async def create(
        self,
        session: AsyncSession,
        *,
        agent_id: str,
        owner_id: str,
        controller_id: str | None,
        desired_state: str,
        definition: dict[str, Any],
    ) -> AgentDefinition:
        row = AgentDefinition(
            agent_id=agent_id,
            owner_id=owner_id,
            controller_id=controller_id,
            revision=1,
            desired_state=desired_state,
            definition=definition,
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
        return row

    async def get_for_agent(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> AgentDefinition | None:
        result = await session.execute(
            select(AgentDefinition).where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id == agent_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_for_owner(
        self, session: AsyncSession, tenant_id: str, owner_id: str
    ) -> list[tuple[AgentDefinition, Agent]]:
        result = await session.execute(
            select(AgentDefinition, Agent)
            .join(
                Agent,
                (Agent.id == AgentDefinition.agent_id)
                & (Agent.tenant_id == AgentDefinition.tenant_id),
            )
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.owner_id == owner_id,
            )
            .order_by(Agent.name)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def list_for_controller(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> list[tuple[AgentDefinition, Agent]]:
        result = await session.execute(
            select(AgentDefinition, Agent)
            .join(
                Agent,
                (Agent.id == AgentDefinition.agent_id)
                & (Agent.tenant_id == AgentDefinition.tenant_id),
            )
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.controller_id == controller_id,
            )
            .order_by(Agent.name)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def list_placed(
        self, session: AsyncSession, tenant_id: str
    ) -> list[AgentDefinition]:
        """Every definition placed on a controller."""
        result = await session.execute(
            select(AgentDefinition).where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.controller_id.is_not(None),
            )
        )
        return list(result.scalars().all())

    async def placements(
        self, session: AsyncSession, tenant_id: str
    ) -> tuple[list[Placement], Fingerprint]:
        """Every definition placed on a controller, with its controller's name
        and revocation, and the fingerprint of them, in one statement: the
        columns a binding is made of and nothing else, so neither a
        definition's document nor a controller's status is read."""
        result = await session.execute(
            select(
                AgentDefinition.agent_id,
                AgentDefinition.controller_id,
                AgentDefinition.desired_state,
                AgentController.name,
                AgentController.revoked_at,
                func.count().over(),
                func.sum(_placement_hash()).over(),
            )
            .outerjoin(AgentController, _placed_on())
            .where(*_placed_in(tenant_id))
        )
        rows = result.all()
        if not rows:
            return [], (0, 0)
        placements = [
            Placement(
                agent_id=agent_id,
                controller_id=controller_id,
                desired_state=desired_state,
                controller_name=name,
                controller_revoked_at=revoked_at,
            )
            for agent_id, controller_id, desired_state, name, revoked_at, _, _ in rows
        ]
        return placements, (int(rows[0][5]), int(rows[0][6]))

    async def placements_fingerprint(
        self, session: AsyncSession, tenant_id: str
    ) -> Fingerprint:
        """The fingerprint `placements` returns, without the rows."""
        result = await session.execute(
            select(func.count(), func.coalesce(func.sum(_placement_hash()), 0))
            .select_from(AgentDefinition)
            .outerjoin(AgentController, _placed_on())
            .where(*_placed_in(tenant_id))
        )
        count, total = result.one()
        return int(count), int(total)

    async def update(
        self,
        session: AsyncSession,
        tenant_id: str,
        agent_id: str,
        *,
        controller_id: str | None,
        desired_state: str,
        definition: dict[str, Any],
        expected_revision: int | None,
    ) -> AgentDefinition:
        """Replace the placement, desired state and definition, bumping the
        revision. With `expected_revision`, only while the definition is still
        at it: `DefinitionChanged` when something changed it since it was read."""
        conditions = [
            AgentDefinition.tenant_id == tenant_id,
            AgentDefinition.agent_id == agent_id,
        ]
        if expected_revision is not None:
            conditions.append(AgentDefinition.revision == expected_revision)
        result = await session.execute(
            update(AgentDefinition)
            .where(*conditions)
            .values(
                controller_id=controller_id,
                desired_state=desired_state,
                definition=definition,
                revision=AgentDefinition.revision + 1,
            )
            .returning(AgentDefinition)
            .execution_options(synchronize_session=False, populate_existing=True)
        )
        row = result.scalar_one_or_none()
        if row is None and expected_revision is not None:
            raise DefinitionChanged(
                f"The definition of agent {agent_id} changed since revision "
                f"{expected_revision} was read"
            )
        if row is None:
            raise LookupError(f"No definition for agent: {agent_id}")
        return row

    async def delete(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> None:
        await session.execute(
            delete(AgentDefinition)
            .where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id == agent_id,
            )
            .execution_options(synchronize_session=False)
        )


def _placed_on() -> ColumnElement[bool]:
    return (AgentController.tenant_id == AgentDefinition.tenant_id) & (
        AgentController.id == AgentDefinition.controller_id
    )


def _placed_in(tenant_id: str) -> tuple[ColumnElement[bool], ...]:
    return (
        AgentDefinition.tenant_id == tenant_id,
        AgentDefinition.controller_id.is_not(None),
    )
