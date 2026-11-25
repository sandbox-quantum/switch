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
background task asks WorkOS for the active sessions of the WorkOS user the
row names (`provider_user_id`). A session WorkOS no longer lists ended there:
revoked, its password reset, timed out, or signed out of elsewhere; so did
every session of a user WorkOS no longer has. Its row is marked ended and the
next request on that cookie gets 401. WorkOS being unreachable or busy never
ends a session: it is kept, logged and counted, and asked again later. Nor
does WorkOS refusing the API key, which is logged as an error. Following a
session means asking WorkOS with the application's API key, never
refreshing anything.

The session's refresh token is kept too, encrypted with the row, for what an
organization's account service takes only from the person themselves
(`organization_token`): renewed for that one organization when it is needed,
and replaced with the token WorkOS rotates it to.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import NoReturn

import httpx
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import HTTPConnection

from switch_core.config import SwitchConfig
from switch_core.db.stores.identity_session_store import (
    IdentitySessionRow,
    IdentitySessionStore,
)
from switch_core.keys import Keyring
from switch_core.observability.catalogue import AUTH_IDENTITY_SESSION_CHECKS
from switch_core.observability.metrics import metrics
from switch_core.workos_authkit import (
    AuthKit,
    AuthKitError,
    AuthKitRefused,
    AuthKitUnavailable,
)

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

# What WorkOS answers a renewal for an organization whose policy the session
# does not meet as it stands: signing in again, through the organization's
# own methods, gets one. (`invalid_grant`, a refresh token that is no longer
# good, is told apart by whether the session itself is still alive.)
_SIGN_IN_AGAIN_FOR = frozenset(
    {
        "sso_required",
        "mfa_enrollment",
        "mfa_challenge",
        "organization_authentication_methods_required",
    }
)


class SignInEnded(Exception):
    """The identity session a request stands on has ended, here or at
    WorkOS: the person signs in again."""


class OrganizationSignInRequired(Exception):
    """The identity session is alive, but WorkOS won't renew the person's
    access for the organization from what is kept of it: the organization
    wants a sign-in its own way (single sign-on, MFA), or the refresh token
    kept was spent by a renewal whose answer was lost. Signing in again gets
    one."""


def authkit_for(config: SwitchConfig, http: httpx.AsyncClient) -> AuthKit | None:
    """The WorkOS AuthKit client people sign in through, or None when the
    gateway does not sign in through AuthKit."""
    if not config.gateway_workos_sign_in:
        return None
    # Checked present with the provider (`_validate_gateway_sign_in_provider`).
    assert config.workos_api_key is not None
    assert config.workos_client_id is not None
    return AuthKit(
        http, config.workos_api_key, config.workos_api_url, config.workos_client_id
    )


def _spread(row_id: str) -> timedelta:
    digest = hashlib.sha256(row_id.encode()).digest()
    return timedelta(seconds=int.from_bytes(digest[:2], "big") % _SPREAD_SECONDS)


class IdentitySessions:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        authkit: AuthKit | None,
        keyring: Keyring,
    ) -> None:
        self._session_factory = session_factory
        self._authkit = authkit
        self._keyring = keyring
        self._store = IdentitySessionStore()
        self._checks = asyncio.Semaphore(_CONCURRENT_CHECKS)
        self._tasks: set[asyncio.Task[None]] = set()
        # The rows a check is under way for in this process: the requests that
        # find one due while it runs start none of their own, rather than each
        # taking a connection to lose the claim (`claim_check`) across
        # processes.
        self._checking: set[str] = set()
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
        if self._authkit is None:
            return
        now = datetime.now(UTC)
        if row.checked_at > now - CHECK_EVERY - _spread(row.id):
            return
        if self._paused_until is not None and now < self._paused_until:
            return
        if row.id in self._checking:
            return
        self._checking.add(row.id)
        task = asyncio.create_task(self._check(row.id))
        self._tasks.add(task)

        def done(finished: asyncio.Task[None]) -> None:
            self._tasks.discard(finished)
            self._checking.discard(row.id)

        task.add_done_callback(done)

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
                active = await authkit.active_session_ids(row.provider_user_id)
        except AuthKitUnavailable as error:
            if error.retry_after:
                self._paused_until = datetime.now(UTC) + timedelta(
                    seconds=error.retry_after
                )
            logger.warning(
                "Could not check identity session %s with WorkOS; the session is "
                "kept and checked again later: %s",
                row_id,
                error.message,
            )
            metrics().increment(AUTH_IDENTITY_SESSION_CHECKS, {"outcome": "failed"})
            return
        except AuthKitRefused as error:
            # Not WorkOS being busy: the API key refused (401, 403) or a
            # request WorkOS won't answer. Kept, as it is no word on the
            # session, but loud, since every check fails until it is fixed.
            logger.error(
                "WorkOS refused the check of identity session %s; the session is "
                "kept, and every check fails until this is fixed: %s",
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

    # ── Acting for the person ────────────────────────────────────────────────

    async def organization_token(
        self, user_id: str, identity_session: str, workos_organization_id: str | None
    ) -> str:
        """An access token WorkOS issues this person for
        `workos_organization_id` (with None, for the person as the session
        stands, to act on no organization yet), good for minutes, renewed from
        the refresh token kept with the identity session their cookie stands
        on, which is replaced with the one WorkOS rotates it to.

        Raises `SignInEnded` when that session has ended, here or at WorkOS
        (whose refusal ends it here too), and `OrganizationSignInRequired`
        when it is alive but WorkOS won't renew it for the organization as it
        stands. Raises `AuthKitRefused` when WorkOS refuses for another
        reason, such as a person not in the organization, and
        `AuthKitUnavailable` when it can't be asked."""
        authkit = self._authkit
        if authkit is None:
            raise RuntimeError(
                "An organization token was asked for where nobody signs in "
                "through WorkOS AuthKit"
            )
        async with self._session_factory() as db:
            row = await self._store.get(db, identity_session)
            sealed = await self._store.refresh_token(db, identity_session)
        if not self._live(row, user_id) or sealed is None:
            raise SignInEnded(SIGN_IN_ENDED)
        assert row is not None
        for attempt in range(2):
            try:
                tokens = await authkit.refresh(
                    self._keyring.decrypt(sealed), workos_organization_id
                )
            except AuthKitRefused as refused:
                if refused.code in _SIGN_IN_AGAIN_FOR:
                    raise OrganizationSignInRequired(refused.message) from refused
                if refused.code != "invalid_grant":
                    raise
                # Another renewal may have spent this token first, and kept
                # the one WorkOS rotated it to: renew from that instead.
                async with self._session_factory() as db:
                    kept = await self._store.refresh_token(db, row.id)
                if attempt == 0 and kept is not None and kept != sealed:
                    sealed = kept
                    continue
                await self._refresh_token_refused(row, refused)
            async with self._session_factory() as db, db.begin():
                await self._store.replace_refresh_token(
                    db,
                    row.id,
                    spent=sealed,
                    renewed=self._keyring.encrypt(tokens.refresh_token),
                )
            return tokens.access_token
        raise AssertionError("unreachable: the loop returns or raises")

    async def _refresh_token_refused(
        self, row: IdentitySessionRow, refused: AuthKitRefused
    ) -> NoReturn:
        """WorkOS no longer takes the session's refresh token: the session
        has ended there, so end it here too and raise `SignInEnded`, or it is
        still alive and the token kept was spent, so raise
        `OrganizationSignInRequired`. Asking WorkOS which may raise
        `AuthKitError`."""
        authkit = self._authkit
        assert authkit is not None
        if row.session_id in await authkit.active_session_ids(row.provider_user_id):
            logger.warning(
                "WorkOS refused the kept refresh token of identity session %s, "
                "which is still alive there; its person signs in again to act "
                "in an organization: %s",
                row.id,
                refused.message,
            )
            raise OrganizationSignInRequired(refused.message) from refused
        async with self._session_factory() as db, db.begin():
            await self._store.end(db, [row.id], datetime.now(UTC))
        logger.info(
            "Identity session %s of user %s ended at WorkOS, found renewing it; "
            "its Switch session ends with it",
            row.id,
            row.user_id,
        )
        raise SignInEnded(SIGN_IN_ENDED) from refused

    # ── Ending them ──────────────────────────────────────────────────────────

    async def end_here(
        self, user_id: str, identity_session: str, return_to: str | None
    ) -> str | None:
        """Sign this browser out of the identity session its cookie stands on:
        mark it ended, so no copy of the cookie stands any more, and answer
        where the browser goes to end it at WorkOS (`return_to` after), or
        None with no AuthKit to end it at or no such session of this
        person's."""
        async with self._session_factory() as db, db.begin():
            row = await self._store.get(db, identity_session)
            if row is None or row.user_id != user_id:
                return None
            await self._store.end(db, [row.id], datetime.now(UTC))
        if self._authkit is None:
            return None
        return self._authkit.logout_url(row.session_id, return_to)

    async def live_sessions(self, user_id: str) -> list[IdentitySessionRow]:
        async with self._session_factory() as db:
            return await self._store.live_for_user(db, user_id)

    def logout_url(self, row: IdentitySessionRow, return_to: str | None) -> str | None:
        """Where a browser goes to end `row` at WorkOS, or None with no AuthKit."""
        if self._authkit is None:
            return None
        return self._authkit.logout_url(row.session_id, return_to)

    async def revoke_at_provider(
        self, user_id: str, rows: list[IdentitySessionRow]
    ) -> None:
        """Revoke these sessions at WorkOS, for an account already gone (its
        rows went with it), as `_revoke_active` does. One that could not be
        revoked is logged as an error: the account cannot be put back to try
        again."""
        if self._authkit is None or not rows:
            return
        _, failed = await self._revoke_active(rows)
        for row in failed:
            logger.error(
                "Could not revoke WorkOS session %s of deleted user %s",
                row.session_id,
                user_id,
            )

    async def end_all(self, user_id: str, *, keep: str | None) -> int:
        """End every live identity session of this person but `keep` (the one
        this browser signs out of through `end_here`): those WorkOS still
        lists as active are revoked there (`_revoke_active`), and all of them
        are marked ended. Answers how many could not be ended at WorkOS,
        because listing the person's sessions or revoking one failed; those
        are left live, so the caller can say so and try again. With no
        AuthKit they are only marked ended here."""
        async with self._session_factory() as db:
            rows = [
                row
                for row in await self._store.live_for_user(db, user_id)
                if row.id != keep
            ]
        if not rows:
            return 0
        ended: list[IdentitySessionRow]
        failed: list[IdentitySessionRow]
        if self._authkit is None:
            ended, failed = rows, []
        else:
            ended, failed = await self._revoke_active(rows)
        if ended:
            async with self._session_factory() as db, db.begin():
                await self._store.end(db, [row.id for row in ended], datetime.now(UTC))
        return len(failed)

    async def _revoke_active(
        self, rows: list[IdentitySessionRow]
    ) -> tuple[list[IdentitySessionRow], list[IdentitySessionRow]]:
        """Revoke at WorkOS the sessions among `rows` it still lists as
        active, asking once per WorkOS user rather than once per row: most of
        a person's rows are sessions that ran out there long ago. Answers the
        rows ended at WorkOS (revoked, or no longer listed) and those that
        could not be: their listing failed, which says nothing about them, or
        their revoke did."""
        authkit = self._authkit
        assert authkit is not None
        by_user: dict[str, list[IdentitySessionRow]] = {}
        for row in rows:
            by_user.setdefault(row.provider_user_id, []).append(row)
        ended: list[IdentitySessionRow] = []
        failed: list[IdentitySessionRow] = []
        for provider_user_id, theirs in by_user.items():
            try:
                active = await authkit.active_session_ids(provider_user_id)
            except AuthKitError as error:
                logger.warning(
                    "Could not list WorkOS user %s's sessions to end %d of them: %s",
                    provider_user_id,
                    len(theirs),
                    error.message,
                )
                failed.extend(theirs)
                continue
            for row in theirs:
                if row.session_id not in active:
                    ended.append(row)
                    continue
                try:
                    await authkit.revoke_session(row.session_id)
                except AuthKitError as error:
                    logger.warning(
                        "Could not revoke identity session %s at WorkOS: %s",
                        row.id,
                        error.message,
                    )
                    failed.append(row)
                    continue
                ended.append(row)
        return ended, failed

    async def aclose(self) -> None:
        """Cancel the checks under way, at shutdown."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def identity_sessions_of(connection: HTTPConnection) -> IdentitySessions:
    """The app's `IdentitySessions` (`main.py` sets it), for a session to be
    checked against or a sign-out to end. A server always has one, so its
    absence is a wiring mistake, not a session to let through."""
    found = getattr(connection.app.state, "identity_sessions", None)
    if not isinstance(found, IdentitySessions):
        raise RuntimeError(
            "This app has no IdentitySessions (app.state.identity_sessions) to "
            "check or end identity-provider sessions with"
        )
    return found
