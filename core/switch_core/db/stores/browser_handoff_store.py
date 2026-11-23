"""One-time sign-ins Switch Console hands a browser (`browser_handoffs`).

A global table, read and written with no tenant bound. What a handoff lets a
browser do, and when it is refused, is `gateway/browser_handoff.py`'s; this
keeps the rows, and is the one place a code is turned into its hash.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, delete, func, insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import BrowserHandoff

# How long a code can be redeemed for after it is minted.
HANDOFF_TTL = timedelta(seconds=60)
# How many codes one person may mint in `MINT_WINDOW`.
MINT_LIMIT = 20
MINT_WINDOW = timedelta(seconds=60)
# How long after it expired a row that links no live session is kept.
_KEEP_EXPIRED = timedelta(hours=1)
# 256 bits.
_CODE_BYTES = 32


class BrowserHandoffRateLimited(Exception):
    """The person minted `MINT_LIMIT` codes or more in the last
    `MINT_WINDOW`, and may not mint another for `retry_after`: until enough
    of those mints have left the window."""

    def __init__(self, minted: int, retry_after: timedelta) -> None:
        super().__init__(
            f"{minted} codes minted in the last {MINT_WINDOW}, of {MINT_LIMIT}; "
            f"the next can be minted in {retry_after}"
        )
        self.retry_after = retry_after


@dataclass(frozen=True)
class MintedHandoff:
    """A code just minted, and when it stops being redeemable. The code is
    here and nowhere else: only its hash is stored."""

    code: str
    expires_at: datetime


@dataclass(frozen=True)
class OpenedSession:
    """A browser session a code was redeemed for, and when the person last
    signed in for it (the minting session's `auth_time`)."""

    session_id: str
    signed_in_at: datetime


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


class BrowserHandoffStore:
    def __init__(self, session_max_age: timedelta) -> None:
        # How long a session lives after its sign-in, however often it is
        # refreshed: how long a row linking two sessions has to be kept.
        self._session_max_age = session_max_age

    async def mint(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        workspace_claim: str | None,
        next_path: str,
        auth_time: datetime,
        session_version: int,
        console_sid: str | None,
        identity_session: str | None,
    ) -> MintedHandoff:
        """Mint a code for `user_id`, redeemable once for `HANDOFF_TTL`, or
        raise `BrowserHandoffRateLimited`. Deletes the rows nothing needs any
        more on the way. Does not commit.

        The count and the insert happen under a lock on the person, so a burst
        sent in parallel is counted exactly.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"browser-handoff:{user_id}"},
        )
        # How long until each mint in the window leaves it, oldest first, on
        # the database's clock, as the window is read.
        counted: list[timedelta] = list(
            await session.scalars(
                select(BrowserHandoff.created_at + MINT_WINDOW - func.now())
                .where(
                    BrowserHandoff.user_id == user_id,
                    BrowserHandoff.created_at > func.now() - MINT_WINDOW,
                )
                .order_by(BrowserHandoff.created_at)
            )
        )
        if len(counted) >= MINT_LIMIT:
            # The next mint is allowed once fewer than `MINT_LIMIT` are left
            # in the window.
            raise BrowserHandoffRateLimited(
                len(counted), counted[len(counted) - MINT_LIMIT]
            )
        await self._prune(session)
        code = secrets.token_urlsafe(_CODE_BYTES)
        inserted = await session.execute(
            insert(BrowserHandoff)
            .values(
                code_hash=_hash(code),
                user_id=user_id,
                workspace_claim=workspace_claim,
                next_path=next_path,
                auth_time=auth_time,
                session_version=session_version,
                console_sid=console_sid,
                identity_session=identity_session,
                expires_at=func.now() + HANDOFF_TTL,
            )
            .returning(BrowserHandoff.expires_at)
        )
        return MintedHandoff(code=code, expires_at=inserted.scalar_one())

    async def _prune(self, session: AsyncSession) -> None:
        """Delete rows an hour past their expiry, unless one links a browser
        session to the session that minted it and that browser session could
        still be live: signing out of the one has to find the other."""
        links_a_live_session = and_(
            BrowserHandoff.console_sid.is_not(None),
            BrowserHandoff.browser_sid.is_not(None),
            BrowserHandoff.auth_time > func.now() - self._session_max_age,
        )
        await session.execute(
            delete(BrowserHandoff).where(
                BrowserHandoff.expires_at < func.now() - _KEEP_EXPIRED,
                ~links_a_live_session,
            )
        )

    async def peek(self, session: AsyncSession, code: str) -> BrowserHandoff | None:
        """The row `code` names while it can still be redeemed: unexpired and
        unused. Spends nothing."""
        handoff: BrowserHandoff | None = await session.scalar(
            select(BrowserHandoff).where(
                BrowserHandoff.code_hash == _hash(code),
                BrowserHandoff.used_at.is_(None),
                BrowserHandoff.expires_at > func.now(),
            )
        )
        return handoff

    async def redeem(
        self, session: AsyncSession, code: str, *, browser_sid: str
    ) -> BrowserHandoff | None:
        """Spend `code`, recording the session it is redeemed for, and return
        its row; None if it was never minted, has expired or was spent.

        One conditional `UPDATE`, so of two redemptions racing for one code
        exactly one gets the row. Does not commit.
        """
        handoff: BrowserHandoff | None = await session.scalar(
            update(BrowserHandoff)
            .where(
                BrowserHandoff.code_hash == _hash(code),
                BrowserHandoff.used_at.is_(None),
                BrowserHandoff.expires_at > func.now(),
            )
            .values(used_at=func.now(), browser_sid=browser_sid)
            .returning(BrowserHandoff)
            .execution_options(populate_existing=True)
        )
        return handoff

    async def opened_by_link(self, session: AsyncSession, browser_sid: str) -> bool:
        """Whether `browser_sid` is a browser session a code was redeemed for.
        Rows that link a session which could still be live are kept past
        their expiry (`_prune`), so this holds for as long as it matters."""
        found = await session.scalar(
            select(BrowserHandoff.id)
            .where(BrowserHandoff.browser_sid == browser_sid)
            .limit(1)
        )
        return found is not None

    async def lock_sessions_opened_by(
        self, session: AsyncSession, console_sids: Sequence[str]
    ) -> list[OpenedSession]:
        """The browser sessions codes minted by `console_sids` were redeemed
        for.

        Locks every row those sessions minted, redeemed or not, so a code
        being redeemed meanwhile either lands first and is returned here, or
        waits for the caller to commit and then finds its session signed out.
        In id order, so two callers locking the same rows queue rather than
        deadlock.
        """
        rows = await session.execute(
            select(BrowserHandoff.browser_sid, BrowserHandoff.auth_time)
            .where(BrowserHandoff.console_sid.in_(console_sids))
            .order_by(BrowserHandoff.id)
            .with_for_update()
        )
        return [
            OpenedSession(session_id=browser_sid, signed_in_at=auth_time)
            for browser_sid, auth_time in rows
            if browser_sid is not None
        ]
