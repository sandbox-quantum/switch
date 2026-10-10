from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    AgentController,
    AgentControllerEnrollmentCode,
    SealedProviderLogin,
)


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
        description: str | None,
        kind: str,
        platform: dict[str, Any] | None,
        version: str | None,
        public_key: dict[str, Any] | None,
        api_key_id: str,
    ) -> AgentController:
        controller = AgentController(
            owner_id=owner_id,
            name=name,
            description=description,
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

    async def update_details(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        changes: dict[str, str | None],
    ) -> AgentController:
        """Set the controller's `name` and/or `description` and return the row."""
        unknown = set(changes) - {"name", "description"}
        if unknown:
            raise ValueError(f"Not editable on a controller: {sorted(unknown)}")
        controller = await self.get(session, tenant_id, controller_id)
        if controller is None:
            raise LookupError(f"No such controller: {controller_id}")
        for key, value in changes.items():
            setattr(controller, key, value)
        await session.flush()
        await session.refresh(controller)
        return controller

    async def set_public_key(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        public_key: dict[str, Any],
    ) -> AgentController:
        """Record the key provider logins are sealed to, and return the row."""
        controller = await self.get(session, tenant_id, controller_id)
        if controller is None:
            raise LookupError(f"No such controller: {controller_id}")
        controller.public_key = public_key
        await session.flush()
        await session.refresh(controller)
        return controller

    async def sealed_login(
        self, session: AsyncSession, tenant_id: str, controller_id: str, provider: str
    ) -> SealedProviderLogin | None:
        result = await session.execute(
            select(SealedProviderLogin).where(
                SealedProviderLogin.tenant_id == tenant_id,
                SealedProviderLogin.controller_id == controller_id,
                SealedProviderLogin.provider == provider,
            )
        )
        return result.scalar_one_or_none()

    async def sealed_logins(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> list[SealedProviderLogin]:
        rows = await session.scalars(
            select(SealedProviderLogin)
            .where(
                SealedProviderLogin.tenant_id == tenant_id,
                SealedProviderLogin.controller_id == controller_id,
            )
            .order_by(SealedProviderLogin.provider)
        )
        return list(rows)

    async def put_sealed_login(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        provider: str,
        sealed: dict[str, Any],
        sealed_by: str,
    ) -> SealedProviderLogin:
        """Store the controller's login for `provider`, replacing any before it
        under the next revision, and return the row."""
        statement = (
            insert(SealedProviderLogin)
            .values(
                tenant_id=tenant_id,
                controller_id=controller_id,
                provider=provider,
                revision=1,
                sealed=sealed,
                sealed_by=sealed_by,
            )
            .on_conflict_do_update(
                index_elements=["controller_id", "provider"],
                set_={
                    "revision": SealedProviderLogin.revision + 1,
                    "sealed": sealed,
                    "sealed_by": sealed_by,
                    "updated_at": func.now(),
                },
            )
        )
        await session.execute(statement)
        row = await self.sealed_login(session, tenant_id, controller_id, provider)
        if row is None:
            raise LookupError(
                f"The {provider} login for {controller_id} was not stored"
            )
        await session.refresh(row)
        return row

    async def delete_sealed_logins(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        provider: str | None,
    ) -> int:
        """Delete the controller's login for `provider`, or every one of its
        logins when `provider` is None. Returns how many went."""
        statement = delete(SealedProviderLogin).where(
            SealedProviderLogin.tenant_id == tenant_id,
            SealedProviderLogin.controller_id == controller_id,
        )
        if provider is not None:
            statement = statement.where(SealedProviderLogin.provider == provider)
        result = await session.execute(statement)
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

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

    async def record_connected(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        *,
        connection_id: str,
        process_id: str,
        connected_at: datetime,
    ) -> str | None:
        """Record that the controller's socket attached to this connection,
        held by this process. It replaces whatever the row held: the process
        holding the live socket is the authority. Returns the controller's
        owner, or None when it has no row. `updated_at` is left alone:
        connecting is not an edit."""
        result = await session.execute(
            update(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
            )
            .values(
                connection_id=connection_id,
                connection_process_id=process_id,
                connected_at=connected_at,
                disconnected_at=None,
                disconnect_reason=None,
                updated_at=AgentController.updated_at,
            )
            .returning(AgentController.owner_id)
            .execution_options(synchronize_session=False)
        )
        return result.scalar_one_or_none()

    async def record_disconnected(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        *,
        connection_id: str,
        disconnected_at: datetime,
        reason: str,
    ) -> str | None:
        """Record that the controller's socket on this connection went, and
        why. Written only while the row still names this connection, so a
        process closing a connection the controller has since replaced
        through another process leaves the replacement standing. Returns the
        controller's owner when the row was written, else None."""
        result = await session.execute(
            update(AgentController)
            .where(
                AgentController.tenant_id == tenant_id,
                AgentController.id == controller_id,
                AgentController.connection_id == connection_id,
            )
            .values(
                disconnected_at=disconnected_at,
                disconnect_reason=reason,
                updated_at=AgentController.updated_at,
            )
            .returning(AgentController.owner_id)
            .execution_options(synchronize_session=False)
        )
        return result.scalar_one_or_none()

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
        machine_workspace_id: str | None,
    ) -> AgentControllerEnrollmentCode:
        code = AgentControllerEnrollmentCode(
            owner_id=owner_id,
            api_key_id=api_key_id,
            expires_at=expires_at,
            machine_workspace_id=machine_workspace_id,
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
