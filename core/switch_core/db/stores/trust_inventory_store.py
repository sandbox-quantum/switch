"""Where the agent inventory was sent, and what it last did there
(`trust_inventory_targets`, `trust_inventory_sent`).

Both tables are server-global, read and written in a session bound to no
tenant by the one process holding the inventory sync's lease.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import TextClause, select, text
from sqlalchemy.dialects.postgresql import insert

from switch_core.db.models import TrustInventorySent, TrustInventoryTarget

if TYPE_CHECKING:
    from datetime import datetime

    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.ownership import Fence

# Every write below names the sync's lease, so a process taken over without
# knowing it changes nothing (`ownership.py`).
_HELD = """
    EXISTS (
        SELECT 1 FROM ownership_leases lease
        WHERE lease.kind = :kind AND lease.key = :key
          AND lease.token = :token AND lease.process_id = :process_id
        FOR SHARE OF lease
    )
"""

_RECORD_SENT = text(
    f"""
    INSERT INTO trust_inventory_sent AS sent
        (target_id, tenant, digest, sent_at, failed_digest, failures, retry_at)
    SELECT :target_id, :tenant, :digest, :at, NULL, 0, NULL
    WHERE {_HELD}
    ON CONFLICT (target_id, tenant) DO UPDATE
    SET digest = EXCLUDED.digest, sent_at = EXCLUDED.sent_at,
        failed_digest = NULL, failures = 0, retry_at = NULL
    RETURNING sent.tenant
    """
)

_RECORD_FAILURE = text(
    f"""
    INSERT INTO trust_inventory_sent AS sent
        (target_id, tenant, failed_digest, failures, retry_at)
    SELECT :target_id, :tenant, :digest, :failures, :retry_at
    WHERE {_HELD}
    ON CONFLICT (target_id, tenant) DO UPDATE
    SET failed_digest = EXCLUDED.failed_digest, failures = EXCLUDED.failures,
        retry_at = EXCLUDED.retry_at
    RETURNING sent.tenant
    """
)

_FORGET_TENANT = text(
    f"""
    DELETE FROM trust_inventory_sent
    WHERE target_id = :target_id AND tenant = :tenant AND {_HELD}
    RETURNING tenant
    """
)

_HOLDS = text(f"SELECT {_HELD}")

_DROP_TARGET = text(
    f"""
    DELETE FROM trust_inventory_targets target
    WHERE target.id = :target_id
      AND NOT EXISTS (
          SELECT 1 FROM trust_inventory_sent sent WHERE sent.target_id = target.id
      )
      AND {_HELD}
    """
)


class InventoryFenceLost(Exception):
    """The sync's lease is no longer this process's: it must stop."""


def _fence_params(fence: Fence) -> dict[str, object]:
    return {
        "kind": fence.kind,
        "key": fence.key,
        "token": fence.token,
        "process_id": fence.process_id,
    }


class TrustInventoryStore:
    """Where the agent inventory was sent and what it last did there
    (`trust/inventory.py`). Writes are fenced by the sync's lease, and raise
    `InventoryFenceLost` once it is not held."""

    async def targets(self, session: AsyncSession) -> list[TrustInventoryTarget]:
        result = await session.execute(select(TrustInventoryTarget))
        return list(result.scalars().all())

    async def sent(
        self, session: AsyncSession, target_id: str
    ) -> dict[str, TrustInventorySent]:
        result = await session.execute(
            select(TrustInventorySent).where(TrustInventorySent.target_id == target_id)
        )
        return {row.tenant: row for row in result.scalars().all()}

    async def add_target(
        self,
        session: AsyncSession,
        fence: Fence,
        *,
        target_id: str,
        endpoint: str,
        api_key_encrypted: str,
    ) -> None:
        await self._require(session, fence)
        await session.execute(
            insert(TrustInventoryTarget)
            .values(
                id=target_id, endpoint=endpoint, api_key_encrypted=api_key_encrypted
            )
            .on_conflict_do_nothing(index_elements=[TrustInventoryTarget.id])
        )

    async def record_sent(
        self,
        session: AsyncSession,
        fence: Fence,
        *,
        target_id: str,
        tenant_id: str,
        digest: str,
        at: datetime,
    ) -> None:
        await self._returning(
            session,
            _RECORD_SENT,
            fence,
            target_id=target_id,
            tenant=tenant_id,
            digest=digest,
            at=at,
        )

    async def record_failure(
        self,
        session: AsyncSession,
        fence: Fence,
        *,
        target_id: str,
        tenant_id: str,
        digest: str,
        failures: int,
        retry_at: datetime,
    ) -> None:
        await self._returning(
            session,
            _RECORD_FAILURE,
            fence,
            target_id=target_id,
            tenant=tenant_id,
            digest=digest,
            failures=failures,
            retry_at=retry_at,
        )

    async def forget_tenant(
        self, session: AsyncSession, fence: Fence, *, target_id: str, tenant_id: str
    ) -> None:
        await self._require(session, fence)
        await session.execute(
            _FORGET_TENANT,
            {"target_id": target_id, "tenant": tenant_id, **_fence_params(fence)},
        )

    async def drop_target_if_done(
        self, session: AsyncSession, fence: Fence, *, target_id: str
    ) -> None:
        """Delete the target, and the key stored with it, once no tenant's
        agents are left listed there."""
        await self._require(session, fence)
        await session.execute(
            _DROP_TARGET, {"target_id": target_id, **_fence_params(fence)}
        )

    async def _require(self, session: AsyncSession, fence: Fence) -> None:
        held = (await session.execute(_HOLDS, _fence_params(fence))).scalar_one()
        if not held:
            raise InventoryFenceLost(f"{fence.kind} lease token {fence.token}")

    async def _returning(
        self,
        session: AsyncSession,
        statement: TextClause,
        fence: Fence,
        **params: object,
    ) -> None:
        result = await session.execute(statement, {**params, **_fence_params(fence)})
        if result.first() is None:
            raise InventoryFenceLost(f"{fence.kind} lease token {fence.token}")
