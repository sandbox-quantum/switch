"""Which switch-core process holds each piece of work (`ownership_leases`).

A global table, read and written with no tenant bound: one process holds work
for every tenant at once. Every time here is the database's own clock, the
one `switch_core_processes` is renewed on, so whether a holder's process lease
still holds is answered by the same clock that stamped it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, bindparam, text, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.types import Text

from switch_core.db.models import OwnershipLease

if TYPE_CHECKING:
    from collections.abc import Collection

    from sqlalchemy.ext.asyncio import AsyncSession

# A row may be taken when nobody holds it, when this process holds it from
# before (so a stale hold of its own is fenced off by the new token), or when
# its holder's process lease no longer holds: stopped, or not renewed within
# the lease's lifetime. The new token is one more than the last, whoever held
# it, so a holder that was taken over is refused by everything it still tries.
#
# Each row taken also says when the work last ran elsewhere, as the row stood
# before the claim: when its holder let go of it, or the last renewal of a
# holder that stopped holding its lease without letting go.
_CLAIM = text(
    """
    WITH previous AS (
        SELECT lease.key,
               CASE WHEN lease.process_id IS NULL THEN lease.changed_at
                    ELSE holder.beat_at
               END AS unheld_since
        FROM ownership_leases lease
        LEFT JOIN switch_core_processes holder ON holder.id = lease.process_id
        WHERE lease.kind = :kind AND lease.key = ANY(:keys)
    ),
    taken AS (
        INSERT INTO ownership_leases AS lease
            (kind, key, process_id, token, changed_at)
        SELECT :kind, claimed.key, :process_id, 1, now()
        FROM unnest(:keys) AS claimed(key)
        ON CONFLICT (kind, key) DO UPDATE
        SET process_id = EXCLUDED.process_id,
            token = lease.token + 1,
            changed_at = now()
        WHERE lease.process_id IS NULL
           OR lease.process_id = EXCLUDED.process_id
           OR NOT EXISTS (
                SELECT 1 FROM switch_core_processes holder
                WHERE holder.id = lease.process_id
                  AND holder.stopped_at IS NULL
                  AND holder.beat_at > now() - CAST(:lease_ttl AS interval)
           )
        RETURNING lease.key, lease.token
    )
    SELECT taken.key, taken.token, previous.unheld_since
    FROM taken LEFT JOIN previous ON previous.key = taken.key
    """
).bindparams(bindparam("keys", type_=ARRAY(Text)))


@dataclass(frozen=True)
class Claim:
    """A key taken: its new token, and when the work last ran elsewhere as
    far as its row told. None for work no process held before, or whose last
    holder's lease is long gone."""

    token: int
    unheld_since: datetime | None


class OwnershipLeaseStore:
    async def claim(
        self,
        session: AsyncSession,
        *,
        kind: str,
        keys: Collection[str],
        process_id: str,
        lease_ttl: timedelta,
    ) -> dict[str, Claim]:
        """Take every one of `keys` that may be taken, in one statement.

        Returns the keys taken, each with its new token. A key held by a
        process whose lease still holds is not returned and stays its.
        """
        if not keys:
            return {}
        result = await session.execute(
            _CLAIM,
            {
                "kind": kind,
                "keys": list(keys),
                "process_id": process_id,
                "lease_ttl": lease_ttl,
            },
        )
        return {
            key: Claim(token=token, unheld_since=unheld_since)
            for key, token, unheld_since in result.tuples().all()
        }

    async def release(
        self,
        session: AsyncSession,
        *,
        kind: str,
        keys: Collection[str],
        process_id: str,
    ) -> None:
        """Let go of `keys`, where this process still holds them. The token
        is kept, so the next claim moves past every one handed out before."""
        if not keys:
            return
        await session.execute(
            update(OwnershipLease)
            .where(
                OwnershipLease.kind == kind,
                OwnershipLease.key.in_(list(keys)),
                OwnershipLease.process_id == process_id,
            )
            .values(process_id=None, changed_at=text("now()"))
        )

    async def release_all(self, session: AsyncSession, process_id: str) -> None:
        """Let go of everything this process holds, as it shuts down."""
        await session.execute(
            update(OwnershipLease)
            .where(OwnershipLease.process_id == process_id)
            .values(process_id=None, changed_at=text("now()"))
        )

    async def held(
        self,
        session: AsyncSession,
        *,
        kind: str,
        tokens: dict[str, int],
        process_id: str,
    ) -> set[str]:
        """Which of `tokens` this process still holds under the token given."""
        if not tokens:
            return set()
        result = await session.execute(
            text(
                "SELECT lease.key FROM ownership_leases lease "
                "JOIN unnest(:keys, :tokens) AS mine(key, token) "
                "ON lease.key = mine.key AND lease.token = mine.token "
                "WHERE lease.kind = :kind AND lease.process_id = :process_id"
            ).bindparams(
                bindparam("keys", type_=ARRAY(Text)),
                bindparam("tokens", type_=ARRAY(BigInteger)),
            ),
            {
                "kind": kind,
                "keys": list(tokens),
                "tokens": list(tokens.values()),
                "process_id": process_id,
            },
        )
        return set(result.scalars().all())

    async def prune(self, session: AsyncSession, older_than: timedelta) -> int:
        """Delete rows nobody has held for `older_than`. Work that still
        exists is claimed again within seconds, so such a row belongs to
        work that is gone; one that comes back is claimed afresh."""
        result = await session.execute(
            text(
                "DELETE FROM ownership_leases "
                "WHERE process_id IS NULL "
                "AND changed_at < now() - CAST(:older_than AS interval) "
                "RETURNING key"
            ),
            {"older_than": older_than},
        )
        return len(result.all())
