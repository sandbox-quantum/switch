from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentControllerOperation

OPEN_STATES = ("pending", "claimed")


class AgentControllerOperationStore:
    """Operations a controller claims under a lease.

    Every state change is a conditional `UPDATE … RETURNING`: the condition is
    the transition's precondition, so a transition that lost a race returns
    nothing rather than overwriting the winner. Every read names its tenant as
    well as relying on the policy, for the reason `JoinDomainStore` gives.
    """

    async def create(
        self,
        session: AsyncSession,
        *,
        controller_id: str,
        agent_id: str | None,
        kind: str,
        params: dict[str, Any],
        created_by: str,
    ) -> AgentControllerOperation:
        operation = AgentControllerOperation(
            controller_id=controller_id,
            agent_id=agent_id,
            kind=kind,
            params=params,
            state="pending",
            created_by=created_by,
        )
        session.add(operation)
        await session.flush()
        await session.refresh(operation)
        return operation

    async def get(
        self, session: AsyncSession, tenant_id: str, operation_id: str
    ) -> AgentControllerOperation | None:
        result = await session.execute(
            select(AgentControllerOperation)
            .where(
                AgentControllerOperation.tenant_id == tenant_id,
                AgentControllerOperation.id == operation_id,
            )
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def list_offered(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        now: datetime,
    ) -> list[AgentControllerOperation]:
        """Pending operations, and claimed ones whose lease has lapsed."""
        result = await session.execute(
            select(AgentControllerOperation)
            .where(
                AgentControllerOperation.tenant_id == tenant_id,
                AgentControllerOperation.controller_id == controller_id,
                or_(
                    AgentControllerOperation.state == "pending",
                    and_(
                        AgentControllerOperation.state == "claimed",
                        AgentControllerOperation.lease_expires_at <= now,
                    ),
                ),
            )
            .order_by(AgentControllerOperation.created_at, AgentControllerOperation.id)
        )
        return list(result.scalars().all())

    async def list_for_controllers(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_ids: Sequence[str],
        limit: int,
    ) -> list[AgentControllerOperation]:
        if not controller_ids:
            return []
        result = await session.execute(
            select(AgentControllerOperation)
            .where(
                AgentControllerOperation.tenant_id == tenant_id,
                AgentControllerOperation.controller_id.in_(controller_ids),
            )
            .order_by(
                AgentControllerOperation.created_at.desc(),
                AgentControllerOperation.id,
            )
            .limit(limit)
        )
        return list(result.scalars().all())

    async def claim(
        self,
        session: AsyncSession,
        tenant_id: str,
        operation_id: str,
        *,
        now: datetime,
        lease_expires_at: datetime,
    ) -> AgentControllerOperation | None:
        """Claim a pending operation, or one whose lease has lapsed."""
        return await self._transition(
            session,
            tenant_id,
            operation_id,
            or_(
                AgentControllerOperation.state == "pending",
                and_(
                    AgentControllerOperation.state == "claimed",
                    AgentControllerOperation.lease_expires_at <= now,
                ),
            ),
            state="claimed",
            lease_expires_at=lease_expires_at,
        )

    async def renew_lease(
        self,
        session: AsyncSession,
        tenant_id: str,
        operation_id: str,
        lease_expires_at: datetime,
    ) -> AgentControllerOperation | None:
        return await self._transition(
            session,
            tenant_id,
            operation_id,
            AgentControllerOperation.state == "claimed",
            lease_expires_at=lease_expires_at,
        )

    async def complete(
        self,
        session: AsyncSession,
        tenant_id: str,
        operation_id: str,
        *,
        state: str,
        result: dict[str, Any],
    ) -> AgentControllerOperation | None:
        return await self._transition(
            session,
            tenant_id,
            operation_id,
            AgentControllerOperation.state == "claimed",
            state=state,
            result=result,
            lease_expires_at=None,
        )

    async def cancel_open(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        controller_id: str,
        agent_id: str | None,
    ) -> list[str]:
        """Cancel every open operation on a controller, or on one agent there.

        Returns the ids cancelled.
        """
        conditions = [
            AgentControllerOperation.tenant_id == tenant_id,
            AgentControllerOperation.controller_id == controller_id,
            AgentControllerOperation.state.in_(OPEN_STATES),
        ]
        if agent_id is not None:
            conditions.append(AgentControllerOperation.agent_id == agent_id)
        result = await session.execute(
            update(AgentControllerOperation)
            .where(*conditions)
            .values(state="cancelled", lease_expires_at=None)
            .returning(AgentControllerOperation.id)
            .execution_options(synchronize_session=False)
        )
        return list(result.scalars().all())

    async def expire_overdue(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        created_before: datetime,
    ) -> list[str]:
        """Expire open operations created before `created_before`.

        An operation offered for that long and never finished is not going to
        be; leaving it open would offer it for ever. Returns the ids expired.
        """
        result = await session.execute(
            update(AgentControllerOperation)
            .where(
                AgentControllerOperation.tenant_id == tenant_id,
                AgentControllerOperation.controller_id == controller_id,
                AgentControllerOperation.state.in_(OPEN_STATES),
                AgentControllerOperation.created_at < created_before,
            )
            .values(state="expired", lease_expires_at=None)
            .returning(AgentControllerOperation.id)
            .execution_options(synchronize_session=False)
        )
        return list(result.scalars().all())

    async def _transition(
        self,
        session: AsyncSession,
        tenant_id: str,
        operation_id: str,
        precondition: Any,
        **values: Any,
    ) -> AgentControllerOperation | None:
        result = await session.execute(
            update(AgentControllerOperation)
            .where(
                AgentControllerOperation.tenant_id == tenant_id,
                AgentControllerOperation.id == operation_id,
                precondition,
            )
            .values(**values)
            .returning(AgentControllerOperation)
            .execution_options(synchronize_session=False, populate_existing=True)
        )
        return result.scalar_one_or_none()
