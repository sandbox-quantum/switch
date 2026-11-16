"""Sign-in and sign-up counts (`auth_attempts`).

A global table, read and written with no tenant bound. What a count means,
and when it refuses an attempt, is `gateway/login_limits.py`'s; this only
keeps the rows.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import delete, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AuthAttempt

# Expired rows deleted by any one attempt: enough to keep up with the attempts
# that leave them, and never a long statement in front of a sign-in.
_PRUNE_BATCH = 500


class AuthAttemptStore:
    async def get(
        self, session: AsyncSession, kind: str, key: str
    ) -> AuthAttempt | None:
        return await session.get(AuthAttempt, (kind, key), populate_existing=True)

    async def lock(
        self, session: AsyncSession, keys: Sequence[tuple[str, str]], now: datetime
    ) -> list[AuthAttempt]:
        """The row for each `(kind, key)`, created empty where there is none,
        locked for this transaction in the order given.

        Every caller locks the same kinds in the same order, so two attempts
        sharing rows queue rather than deadlock. The upsert takes the lock
        itself, so a prune elsewhere cannot delete a row between finding it
        and locking it.
        """
        rows = []
        for kind, key in keys:
            fresh = insert(AuthAttempt).values(
                kind=kind,
                key=key,
                attempts=0,
                window_started_at=now,
                locked_until=None,
                expires_at=now,
            )
            locked = fresh.on_conflict_do_update(
                index_elements=["kind", "key"], set_={"kind": fresh.excluded.kind}
            ).returning(AuthAttempt)
            result = await session.scalars(
                locked, execution_options={"populate_existing": True}
            )
            rows.append(result.one())
        return rows

    async def clear(self, session: AsyncSession, kind: str, key: str) -> None:
        await session.execute(
            delete(AuthAttempt).where(AuthAttempt.kind == kind, AuthAttempt.key == key)
        )

    async def prune(self, session: AsyncSession, now: datetime) -> None:
        """Delete rows that no longer mean anything, skipping any another
        attempt has locked, so a prune never waits on, or deadlocks with,
        the attempts around it."""
        expired = (
            select(AuthAttempt.kind, AuthAttempt.key)
            .where(AuthAttempt.expires_at < now)
            .limit(_PRUNE_BATCH)
            .with_for_update(skip_locked=True)
        )
        await session.execute(
            delete(AuthAttempt).where(
                tuple_(AuthAttempt.kind, AuthAttempt.key).in_(expired)
            )
        )
