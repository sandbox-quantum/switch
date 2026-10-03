from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentController, AgentControllerEnrollmentCode


class AgentControllerStore:
    """Agent controllers and the one-time codes they enroll with.

    Every read names its tenant as well as relying on the policy, for the
    reason `JoinDomainStore` gives: the owner connection the tests (and an
    unrestricted deployment) run on is exempt from row-level security.
    """

    async def create(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        name: str,
        kind: str,
        platform: dict[str, Any] | None,
        version: str | None,
        public_key: dict[str, Any] | None,
        api_key_id: str,
    ) -> AgentController:
        controller = AgentController(
            owner_id=owner_id,
            name=name,
            kind=kind,
            platform=platform,
            version=version,
            public_key=public_key,
            api_key_id=api_key_id,
        )
        session.add(controller)
        await session.flush()
        await session.refresh(controller)
        return controller

    async def get(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> AgentController | None:
        result = await session.execute(
            select(AgentController).where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_api_key(
        self, session: AsyncSession, tenant_id: str, api_key_id: str
    ) -> AgentController | None:
        result = await session.execute(
            select(AgentController).where(
                AgentController.tenant_id == tenant_id,
                AgentController.api_key_id == api_key_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_for_owner(
        self, session: AsyncSession, tenant_id: str, owner_id: str
    ) -> list[AgentController]:
        result = await session.execute(
            select(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.owner_id == owner_id,
            )
            .order_by(AgentController.created_at, AgentController.id)
        )
        return list(result.scalars().all())

    async def bump_assignment_revision(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> int:
        """Increment and return the controller's assignment revision.

        In SQL rather than read-modify-write, so two changes landing together
        each get a revision of their own.
        """
        result = await session.execute(
            update(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
            )
            .values(assignment_revision=AgentController.assignment_revision + 1)
            .returning(AgentController.assignment_revision)
            .execution_options(synchronize_session=False)
        )
        revision = result.scalar_one_or_none()
        if revision is None:
            raise LookupError(f"No such controller: {controller_id}")
        return int(revision)

    async def record_status(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        *,
        seq: int,
        status: dict[str, Any],
        version: str,
        platform: dict[str, Any],
        seen_at: datetime,
    ) -> bool:
        """Store a status report unless one at or past `seq` is already stored.

        Returns whether it was stored. The comparison is in the `UPDATE`
        itself, so two reports racing each other cannot leave the older one
        standing.
        """
        values: dict[str, Any] = {
            "status": status,
            "status_seq": seq,
            "last_seen_at": seen_at,
            "version": version,
            "platform": platform,
        }
        result = await session.execute(
            update(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
                or_(
                    AgentController.status_seq.is_(None),
                    AgentController.status_seq < seq,
                ),
            )
            .values(**values)
            .returning(AgentController.id)
            .execution_options(synchronize_session=False)
        )
        return result.scalar_one_or_none() is not None

    async def set_credential(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        api_key_id: str | None,
    ) -> None:
        await session.execute(
            update(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
            )
            .values(api_key_id=api_key_id)
            .execution_options(synchronize_session=False)
        )

    async def mark_revoked(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        revoked_at: datetime,
    ) -> None:
        await session.execute(
            update(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
            )
            .values(revoked_at=revoked_at, api_key_id=None)
            .execution_options(synchronize_session=False)
        )

    # ── Enrollment codes ──────────────────────────────────────────────────────

    async def create_enrollment_code(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        api_key_id: str,
        expires_at: datetime,
    ) -> AgentControllerEnrollmentCode:
        code = AgentControllerEnrollmentCode(
            owner_id=owner_id, api_key_id=api_key_id, expires_at=expires_at
        )
        session.add(code)
        await session.flush()
        return code

    async def consume_enrollment_code(
        self,
        session: AsyncSession,
        tenant_id: str,
        api_key_id: str,
        now: datetime,
    ) -> AgentControllerEnrollmentCode | None:
        """Mark the code behind `api_key_id` used, if it is unused and unexpired.

        Returns the code, or None when there is no such code or it is spent or
        expired. The conditions are in the `UPDATE`, so of two enrollments
        racing on one code exactly one gets it.
        """
        result = await session.execute(
            update(AgentControllerEnrollmentCode)
            .where(
                AgentControllerEnrollmentCode.tenant_id == tenant_id,
                AgentControllerEnrollmentCode.api_key_id == api_key_id,
                AgentControllerEnrollmentCode.used_at.is_(None),
                AgentControllerEnrollmentCode.expires_at > now,
            )
            .values(used_at=now)
            .returning(AgentControllerEnrollmentCode)
            .execution_options(synchronize_session=False)
        )
        return result.scalar_one_or_none()

    async def complete_enrollment(
        self,
        session: AsyncSession,
        tenant_id: str,
        code_id: str,
        controller_id: str,
    ) -> None:
        """Record what a used code enrolled, and detach the code's own key."""
        await session.execute(
            update(AgentControllerEnrollmentCode)
            .where(
                AgentControllerEnrollmentCode.tenant_id == tenant_id,
                AgentControllerEnrollmentCode.id == code_id,
            )
            .values(controller_id=controller_id, api_key_id=None)
            .execution_options(synchronize_session=False)
        )
