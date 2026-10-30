"""A workspace's choice of decision backend for auto-route (`decision_settings`).

No row means the workspace uses the server default. Every query names the
workspace it is for, so a caller resolving another room's workspace (the
decision worker) and a request bound to its own read the same way.
"""

from __future__ import annotations

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import DecisionSettings


class DecisionSettingsStore:
    async def get(
        self, session: AsyncSession, tenant_id: str
    ) -> DecisionSettings | None:
        result = await session.execute(
            select(DecisionSettings)
            .where(DecisionSettings.tenant_id == tenant_id)
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def get_for_update(
        self, session: AsyncSession, tenant_id: str
    ) -> DecisionSettings | None:
        """The row, locked until the caller's transaction ends: a save reads
        the stored key to keep it, and two saves at once must not each keep a
        key the other replaced."""
        result = await session.execute(
            select(DecisionSettings)
            .where(DecisionSettings.tenant_id == tenant_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def save(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        backend: str,
        endpoint: str | None,
        api_key_encrypted: str | None,
        threshold: float | None,
    ) -> DecisionSettings:
        """Write the workspace's row exactly as given, replacing any there.
        For every backend but `machine` (`save_machine`)."""
        if backend == "machine":
            raise ValueError("A machine is saved with save_machine")
        values = {
            "backend": backend,
            "endpoint": endpoint,
            "api_key_encrypted": api_key_encrypted,
            "threshold": threshold,
            "controller_id": None,
            "model": None,
            "machine_ready_at": None,
        }
        await session.execute(
            insert(DecisionSettings)
            .values(tenant_id=tenant_id, **values)
            .on_conflict_do_update(
                index_elements=[DecisionSettings.tenant_id],
                set_={**values, "updated_at": func.now()},
            )
        )
        await session.flush()
        saved = await self.get(session, tenant_id)
        assert saved is not None
        return saved

    async def save_machine(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        controller_id: str,
        model: str,
        threshold: float | None,
    ) -> DecisionSettings:
        """Choose the workspace's machine and model, replacing any row there.
        The machine is ready only once it reports the model running for this
        choice: choosing the same machine and model again keeps when it
        became ready, choosing another starts over."""
        table = DecisionSettings.__table__
        excluded = insert(DecisionSettings).excluded
        same_choice = (
            (table.c.backend == "machine")
            & table.c.controller_id.is_not_distinct_from(excluded.controller_id)
            & table.c.model.is_not_distinct_from(excluded.model)
        )
        values = {
            "backend": "machine",
            "endpoint": None,
            "api_key_encrypted": None,
            "threshold": threshold,
            "controller_id": controller_id,
            "model": model,
        }
        await session.execute(
            insert(DecisionSettings)
            .values(tenant_id=tenant_id, machine_ready_at=None, **values)
            .on_conflict_do_update(
                index_elements=[DecisionSettings.tenant_id],
                set_={
                    **values,
                    "machine_ready_at": case(
                        (same_choice, table.c.machine_ready_at), else_=None
                    ),
                    "updated_at": func.now(),
                },
            )
        )
        await session.flush()
        saved = await self.get(session, tenant_id)
        assert saved is not None
        return saved

    async def for_controller(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> DecisionSettings | None:
        """The workspace's row when it runs its decisions on this controller."""
        result = await session.execute(
            select(DecisionSettings)
            .where(
                DecisionSettings.tenant_id == tenant_id,
                DecisionSettings.backend == "machine",
                DecisionSettings.controller_id == controller_id,
            )
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def mark_machine_ready(
        self, session: AsyncSession, tenant_id: str, controller_id: str, model: str
    ) -> bool:
        """Record that the controller reported `model` running, when the
        workspace runs on it with that model and it was not ready yet. Says
        whether this made it ready."""
        result = await session.execute(
            update(DecisionSettings)
            .where(
                DecisionSettings.tenant_id == tenant_id,
                DecisionSettings.backend == "machine",
                DecisionSettings.controller_id == controller_id,
                DecisionSettings.model == model,
                DecisionSettings.machine_ready_at.is_(None),
            )
            .values(machine_ready_at=func.now())
            .returning(DecisionSettings.tenant_id)
            .execution_options(synchronize_session=False)
        )
        return result.scalar_one_or_none() is not None

    async def clear(self, session: AsyncSession, tenant_id: str) -> None:
        """Back to the server default."""
        await session.execute(
            delete(DecisionSettings).where(DecisionSettings.tenant_id == tenant_id)
        )
        await session.flush()
