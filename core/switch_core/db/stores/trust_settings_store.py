from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TrustSettings

_ROW_ID = "global"


class TrustSettingsStore:
    """Storage for Switch Trust's one server-global settings row.

    No row, or one missing ``policy_id``/``api_key_encrypted``, means the
    check is off — see ``switch_core.trust.client.DynamicTrustClient``.
    ``endpoint``/``policy_id`` are written exactly as given; ``upsert``'s
    ``api_key_encrypted=None`` means "leave whatever is already stored
    untouched"; ``clear()`` is what drops the key, with the policy id. That merge happens in the
    ``ON CONFLICT`` clause itself via ``COALESCE``, not in a caller that reads
    the row first: two saves racing each other can't have one silently
    overwrite the other's key with a value it read before the write.
    ``share_agent_instructions=None`` leaves the stored choice untouched the
    same way, and is off for a row it creates.
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
        share_agent_instructions: bool | None,
    ) -> TrustSettings:
        insert_stmt = insert(TrustSettings).values(
            id=_ROW_ID,
            endpoint=endpoint,
            policy_id=policy_id,
            api_key_encrypted=api_key_encrypted,
            share_agent_instructions=bool(share_agent_instructions),
        )
        stmt = insert_stmt.on_conflict_do_update(
            index_elements=[TrustSettings.id],
            set_={
                "endpoint": endpoint,
                "policy_id": policy_id,
                "share_agent_instructions": func.coalesce(
                    share_agent_instructions,
                    TrustSettings.share_agent_instructions,
                ),
                "api_key_encrypted": func.coalesce(
                    insert_stmt.excluded.api_key_encrypted,
                    TrustSettings.api_key_encrypted,
                ),
                "updated_at": func.now(),
            },
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

    async def clear(self, session: AsyncSession) -> TrustSettings | None:
        """Turn the check and the inventory off: drop the key and the policy
        id. The endpoint and the sharing choice stay, so turning it back on
        does not quietly reset what an operator chose to share."""
        await session.execute(
            update(TrustSettings)
            .where(TrustSettings.id == _ROW_ID)
            .values(policy_id=None, api_key_encrypted=None, updated_at=func.now())
        )
        await session.flush()
        result = await session.execute(
            select(TrustSettings)
            .where(TrustSettings.id == _ROW_ID)
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()
