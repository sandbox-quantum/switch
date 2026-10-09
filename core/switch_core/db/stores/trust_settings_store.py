from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TrustSettings

_ROW_ID = "global"


class TrustSettingsStore:
    """Storage for Switch Trust's one server-global settings row.

    No row, or one missing ``policy_id``/``api_key_encrypted``, means the
    check is off — see ``switch_core.trust.client.DynamicTrustClient``.
    Merge semantics (e.g. keeping the existing API key when a caller doesn't
    supply a new one) are the caller's job; this store only ever writes the
    exact values it's given.
    """

    async def get(self, session: AsyncSession) -> TrustSettings | None:
        result = await session.execute(
            select(TrustSettings).where(TrustSettings.id == _ROW_ID)
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        session: AsyncSession,
        *,
        endpoint: str,
        policy_id: str | None,
        api_key_encrypted: str | None,
    ) -> TrustSettings:
        stmt = (
            insert(TrustSettings)
            .values(
                id=_ROW_ID,
                endpoint=endpoint,
                policy_id=policy_id,
                api_key_encrypted=api_key_encrypted,
            )
            .on_conflict_do_update(
                index_elements=[TrustSettings.id],
                set_={
                    "endpoint": endpoint,
                    "policy_id": policy_id,
                    "api_key_encrypted": api_key_encrypted,
                    "updated_at": func.now(),
                },
            )
        )
        await session.execute(stmt)
        await session.flush()
        # Not `.returning(TrustSettings)`: a caller that already loaded this
        # row this session (as `update_trust_settings` does, to read the
        # existing `api_key_encrypted`) has it in the identity map, and an
        # ORM-mapped `RETURNING` result would hand back that same stale
        # object rather than the row this statement just wrote.
        # `populate_existing` forces the fresh columns onto it instead.
        result = await session.execute(
            select(TrustSettings)
            .where(TrustSettings.id == _ROW_ID)
            .execution_options(populate_existing=True)
        )
        return result.scalar_one()

    async def clear(self, session: AsyncSession) -> None:
        await session.execute(delete(TrustSettings).where(TrustSettings.id == _ROW_ID))
        await session.flush()
