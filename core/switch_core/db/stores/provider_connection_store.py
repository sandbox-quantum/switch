from datetime import datetime

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ProviderConnection, require_tenant_id


class ProviderConnectionBusy(Exception):
    pass


class ProviderConnectionStore:
    async def lock_user(self, session: AsyncSession, user_id: str) -> None:
        acquired = await session.scalar(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"provider-connection:{require_tenant_id()}:{user_id}"},
        )
        if not acquired:
            raise ProviderConnectionBusy(
                "A connection change is already in progress. Try again shortly."
            )

    async def get(
        self, session: AsyncSession, user_id: str
    ) -> ProviderConnection | None:
        result = await session.execute(
            select(ProviderConnection).where(
                ProviderConnection.tenant_id == require_tenant_id(),
                ProviderConnection.user_id == user_id,
                ProviderConnection.provider == "claude",
            )
        )

        return result.scalar_one_or_none()

    async def save(
        self,
        session: AsyncSession,
        user_id: str,
        kind: str,
        encrypted: str,
        verified_at: datetime,
    ) -> None:
        values = dict(
            tenant_id=require_tenant_id(),
            user_id=user_id,
            provider="claude",
            kind=kind,
            encrypted_credential=encrypted,
            verified_at=verified_at,
        )
        await session.execute(
            insert(ProviderConnection)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["tenant_id", "user_id", "provider"],
                set_={
                    "kind": kind,
                    "encrypted_credential": encrypted,
                    "verified_at": verified_at,
                },
            )
        )

    async def delete(self, session: AsyncSession, user_id: str) -> None:
        await session.execute(
            delete(ProviderConnection).where(
                ProviderConnection.tenant_id == require_tenant_id(),
                ProviderConnection.user_id == user_id,
                ProviderConnection.provider == "claude",
            )
        )
