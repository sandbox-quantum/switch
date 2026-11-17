"""Following the identity-provider sessions that gateway sessions stand on.

A sign-in through WorkOS AuthKit stands on the person's AuthKit session,
which every application in the WorkOS environment shares. Its session cookie
names the `identity_sessions` row recorded at sign-in (`isid`), and every
authenticated request, socket and stream re-check asks `require_live` or
`still_live` whether that row has ended: one indexed read, on a connection
the check already holds.

The session is followed: when WorkOS was last asked about it more than
`CHECK_EVERY` ago, the request that notices claims the next check (a
conditional update, so one request across every process gets it) and a
background task asks WorkOS for the person's active sessions. A session
WorkOS no longer lists ended there: revoked, its password reset, timed out,
or signed out of elsewhere, so its row is marked ended and the next request
on that cookie gets 401. WorkOS being unreachable or busy never ends a
session: it is kept, logged and counted, and asked again later.

The gateway keeps no WorkOS token, so following a session means asking
WorkOS with the application's API key, never refreshing anything.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import HTTPConnection

from switch_core.db.stores.identity_session_store import (
    IdentitySessionRow,
    IdentitySessionStore,
)
from switch_core.observability.catalogue import AUTH_IDENTITY_SESSION_CHECKS
from switch_core.observability.metrics import metrics
from switch_core.workos_authkit import AuthKit, AuthKitError

logger = logging.getLogger(__name__)

#: How long a session goes unchecked before the next request on it asks WorkOS.
CHECK_EVERY = timedelta(minutes=5)
#: Spread across sessions, so the sessions signed in together (or all of them,
#: after a restart) do not come due together: each adds its own share of this,
#: from its id.
_SPREAD_SECONDS = 60
#: How many WorkOS checks one process makes at once. The rest wait. WorkOS's
#: read limit is per environment, shared with every other product in it.
_CONCURRENT_CHECKS = 4

SIGN_IN_ENDED = "Your sign-in has ended. Sign in again."


def _spread(row_id: str) -> timedelta:
    digest = hashlib.sha256(row_id.encode()).digest()
    return timedelta(seconds=int.from_bytes(digest[:2], "big") % _SPREAD_SECONDS)


class IdentitySessions:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        authkit: AuthKit | None,
    ) -> None:
        self._session_factory = session_factory
        self._authkit = authkit
        self._store = IdentitySessionStore()
        self._checks = asyncio.Semaphore(_CONCURRENT_CHECKS)
        self._tasks: set[asyncio.Task[None]] = set()
        # WorkOS asked for a pause (a 429's Retry-After): no check starts
        # before this.
        self._paused_until: datetime | None = None

    @property
    def authkit(self) -> AuthKit | None:
        return self._authkit

    async def require_live(
        self, db: AsyncSession, user_id: str, identity_session: str
    ) -> None:
        """401 unless the identity session a request's cookie names is live and
        the caller's. Starts a check of it with WorkOS when one is due."""
        row = await self._store.get(db, identity_session)
        if not self._live(row, user_id):
            raise HTTPException(status_code=401, detail=SIGN_IN_ENDED)
        assert row is not None
        self._follow(row)

    async def still_live(self, user_id: str, identity_session: str) -> bool:
        """`require_live` for a socket or stream asking again, on a short
        session of its own."""
        async with self._session_factory() as db:
            row = await self._store.get(db, identity_session)
        if not self._live(row, user_id):
            return False
        assert row is not None
        self._follow(row)
        return True

    @staticmethod
    def _live(row: IdentitySessionRow | None, user_id: str) -> bool:
        return row is not None and row.user_id == user_id and row.ended_at is None

    def _follow(self, row: IdentitySessionRow) -> None:
        if self._authkit is None or not row.followed:
            return
        now = datetime.now(UTC)
        if row.checked_at > now - CHECK_EVERY - _spread(row.id):
            return
        if self._paused_until is not None and now < self._paused_until:
            return
        task = asyncio.create_task(self._check(row.id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _check(self, row_id: str) -> None:
        authkit = self._authkit
        assert authkit is not None
        now = datetime.now(UTC)
        try:
            async with self._session_factory() as db, db.begin():
                row = await self._store.claim_check(
                    db, row_id, checked_before=now - CHECK_EVERY, now=now
                )
            if row is None:
                return
            async with self._checks:
                active = await authkit.active_session_ids(row.user_id)
        except AuthKitError as error:
            retry_after = getattr(error, "retry_after", None)
            if retry_after:
                self._paused_until = datetime.now(UTC) + timedelta(seconds=retry_after)
            logger.warning(
                "Could not check identity session %s with WorkOS; the session is "
                "kept and checked again later: %s",
                row_id,
                error.message,
            )
            metrics().increment(AUTH_IDENTITY_SESSION_CHECKS, {"outcome": "failed"})
            return
        except Exception:
            logger.exception("Checking identity session %s failed", row_id)
            metrics().increment(AUTH_IDENTITY_SESSION_CHECKS, {"outcome": "failed"})
            return
        if row.session_id in active:
            metrics().increment(AUTH_IDENTITY_SESSION_CHECKS, {"outcome": "alive"})
            return
        async with self._session_factory() as db, db.begin():
            await self._store.end(db, [row.id], datetime.now(UTC))
        logger.info(
            "Identity session %s of user %s ended at WorkOS; its Switch session "
            "ends with it",
            row.id,
            row.user_id,
        )
        metrics().increment(AUTH_IDENTITY_SESSION_CHECKS, {"outcome": "ended"})

    async def aclose(self) -> None:
        """Cancel the checks under way, at shutdown."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def identity_sessions_of(connection: HTTPConnection) -> IdentitySessions:
    """The app's `IdentitySessions`, for a request or socket whose cookie names
    an identity session. A server that mints such cookies always has one, so
    its absence is a wiring mistake, not a session to let through."""
    found = getattr(connection.app.state, "identity_sessions", None)
    if not isinstance(found, IdentitySessions):
        raise RuntimeError(
            "A session names an identity session, but this app has no "
            "IdentitySessions to check it with"
        )
    return found
