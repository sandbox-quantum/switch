"""The sessions at the identity provider that gateway sign-ins stand on.

`identity_sessions` is global, like `users`, so nothing here needs a tenant
bound. See `IdentitySession` in `db/models.py` for what a row is, and
`gateway/identity_sessions.py` for following and ending them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import IdentitySession

#: How long a row is kept after it ends, or after the latest sign-in on it
#: (`signed_in_at`): past the longest a session cookie can stand on it
#: (`gateway/auth.py`'s `SESSION_MAX_AGE`, 14 days from that sign-in) and then
#: retention's 30-day grace, so an operator asking about a sign-in can still
#: see it.
IDENTITY_SESSION_HORIZON = timedelta(days=44)


class IdentitySessionConflict(Exception):
    """The provider named a session that is live under another account."""


@dataclass(frozen=True)
class IdentitySessionRow:
    id: str
    user_id: str
    provider: str
    provider_user_id: str
    session_id: str
    checked_at: datetime
    ended_at: datetime | None


def _row(session: IdentitySession) -> IdentitySessionRow:
    return IdentitySessionRow(
        id=session.id,
        user_id=session.user_id,
        provider=session.provider,
        provider_user_id=session.provider_user_id,
        session_id=session.session_id,
        checked_at=session.checked_at,
        ended_at=session.ended_at,
    )


class IdentitySessionStore:
    async def record(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        provider: str,
        provider_user_id: str,
        session_id: str,
        encrypted_refresh_token: str,
        now: datetime,
    ) -> str:
        """The row for a sign-in the provider just made, as its id, keeping
        the refresh token the sign-in brought.

        A live row for the same provider session is reused when it is the same
        person's: the provider has just said the session is alive, so it is
        checked as of now, signed in on as of now (which keeps it from
        retention while the new cookie can stand on it), and given the new
        refresh token. A live row for someone else is refused: one provider
        session is one person. An ended row is never brought back, so a cookie
        from before a sign-out stays ended even when the provider hands the
        same session out again; a new row is made instead.
        """
        for attempt in range(2):
            live = await session.scalar(
                select(IdentitySession).where(
                    IdentitySession.provider == provider,
                    IdentitySession.session_id == session_id,
                    IdentitySession.ended_at.is_(None),
                )
            )
            if live is not None:
                if live.user_id != user_id or live.provider_user_id != provider_user_id:
                    raise IdentitySessionConflict(
                        f"{provider} session {session_id} is live under account "
                        f"{live.user_id} ({provider} user "
                        f"{live.provider_user_id}), not {user_id} "
                        f"({provider_user_id})"
                    )
                live.checked_at = now
                live.signed_in_at = now
                live.encrypted_refresh_token = encrypted_refresh_token
                await session.flush()
                return live.id
            row = IdentitySession(
                user_id=user_id,
                provider=provider,
                provider_user_id=provider_user_id,
                session_id=session_id,
                encrypted_refresh_token=encrypted_refresh_token,
                created_at=now,
                signed_in_at=now,
                checked_at=now,
            )
            try:
                async with session.begin_nested():
                    session.add(row)
                    await session.flush()
            except IntegrityError:
                # Another sign-in recorded the same session first; read it.
                if attempt == 1:
                    raise
                continue
            return row.id
        raise AssertionError("unreachable: the loop returns or raises")

    async def get(
        self, session: AsyncSession, row_id: str
    ) -> IdentitySessionRow | None:
        row = await session.get(IdentitySession, row_id)
        return None if row is None else _row(row)

    async def refresh_token(self, session: AsyncSession, row_id: str) -> str | None:
        """The encrypted refresh token of a live session, or None when it has
        ended or there is no such session."""
        token: str | None = await session.scalar(
            select(IdentitySession.encrypted_refresh_token).where(
                IdentitySession.id == row_id, IdentitySession.ended_at.is_(None)
            )
        )
        return token

    async def replace_refresh_token(
        self, session: AsyncSession, row_id: str, *, spent: str, renewed: str
    ) -> bool:
        """Keep `renewed` in place of `spent`, the encrypted refresh token a
        renewal used, unless the session has ended or another renewal already
        replaced it; answers whether this one did. Conditional, so of renewals
        made at once from the same token, across every process, the first to
        finish is kept."""
        result = cast(
            CursorResult[Any],
            await session.execute(
                update(IdentitySession)
                .where(
                    IdentitySession.id == row_id,
                    IdentitySession.ended_at.is_(None),
                    IdentitySession.encrypted_refresh_token == spent,
                )
                .values(encrypted_refresh_token=renewed)
            ),
        )
        return result.rowcount == 1

    async def claim_check(
        self,
        session: AsyncSession,
        row_id: str,
        *,
        checked_before: datetime,
        now: datetime,
    ) -> IdentitySessionRow | None:
        """Take the next check of a live session last checked before
        `checked_before`, moving its `checked_at` to `now` as it does, or None
        when it is not due or already ended. A conditional update, so of the
        requests that find it due at once, across every process, exactly one
        gets it."""
        result = await session.execute(
            update(IdentitySession)
            .where(
                IdentitySession.id == row_id,
                IdentitySession.ended_at.is_(None),
                IdentitySession.checked_at < checked_before,
            )
            .values(checked_at=now)
            .returning(IdentitySession)
        )
        claimed = result.scalar_one_or_none()
        return None if claimed is None else _row(claimed)

    async def end(
        self, session: AsyncSession, row_ids: list[str], now: datetime
    ) -> int:
        """Mark these sessions ended, if they are not already, dropping the
        refresh token each kept: nothing renews an ended session. Returns how
        many this ended."""
        if not row_ids:
            return 0
        result = cast(
            CursorResult[Any],
            await session.execute(
                update(IdentitySession)
                .where(
                    IdentitySession.id.in_(row_ids), IdentitySession.ended_at.is_(None)
                )
                .values(ended_at=now, encrypted_refresh_token="")
            ),
        )
        return result.rowcount

    async def live_for_user(
        self, session: AsyncSession, user_id: str
    ) -> list[IdentitySessionRow]:
        """Every session of this person's not yet ended, oldest first."""
        rows = await session.scalars(
            select(IdentitySession)
            .where(
                IdentitySession.user_id == user_id, IdentitySession.ended_at.is_(None)
            )
            .order_by(IdentitySession.created_at, IdentitySession.id)
        )
        return [_row(row) for row in rows]

    async def prune(self, session: AsyncSession, now: datetime) -> int:
        """Delete the rows past `IDENTITY_SESSION_HORIZON`: ended that long
        ago, or last signed in on that long ago, when no cookie can stand on
        them. Not by when a row was made: a sign-in that reuses a live row
        mints a cookie that stands on it for another 14 days."""
        horizon = now - IDENTITY_SESSION_HORIZON
        result = cast(
            CursorResult[Any],
            await session.execute(
                delete(IdentitySession).where(
                    or_(
                        IdentitySession.ended_at < horizon,
                        IdentitySession.signed_in_at < horizon,
                    )
                )
            ),
        )
        return result.rowcount
