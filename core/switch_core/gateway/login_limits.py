"""How many password sign-ins, and sign-ups, the gateway takes before it waits.

Failed password sign-ins are counted against the email address typed and
against the client's address. A few failures against one email are free, for
typing; past them each makes the next attempt wait, twice as long each time,
and `gateway_login_max_failures` within the window locks the email out for
`gateway_login_lock_minutes`. A client address is allowed more
(`gateway_login_max_failures_per_address`), as many people can share one, and
locks out at its limit with no waits before. A success clears the email's
count, and takes its own attempt back off the address's, so the address
counts only failures. Sign-ups are counted per client address too
(`gateway_signup_max_per_hour_per_address`), in front of the deployment-wide
cap `auth_routes._refuse_signup` keeps.

An attempt is counted before its password is checked, under a row lock, so a
burst sent in parallel is counted exactly and none of it passes on a count
the rest have not added to yet. A locked-out attempt is answered 429 with
`Retry-After`, without the password being checked.

**Why 429 tells nobody whether an email has an account.** The count is keyed
by the email typed, whether or not an account has it, so an email nobody
registered locks out after exactly as many failures, for exactly as long, as
one somebody did. The lock says how many guesses were made, and nothing about
who they were made against.

**The client's address is the one uvicorn resolved** (`request.client`): its
peer, or, from a proxy named in `FORWARDED_ALLOW_IPS`, the client that proxy
says it forwarded for in `X-Forwarded-For`. That is uvicorn's rule, and this
module adds no other. An address in a private, loopback or link-local range is
not counted, as it is a proxy's, a container network's or this computer's,
standing for every client behind it: counting it would let one person's
failures lock out everyone signing in through the same proxy. A warning says
so, once a process, naming the setting that makes the client's own address
visible. IPv6 addresses are counted by their /64, which one subscriber
usually holds whole.
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import AuthAttempt
from switch_core.db.stores.auth_attempt_store import AuthAttemptStore
from switch_core.gateway.dependencies import current_telemetry
from switch_core.telemetry import emit_safely

logger = logging.getLogger(__name__)

STORE = AuthAttemptStore()

LOGIN_EMAIL = "login_email"
LOGIN_ADDRESS = "login_address"
SIGNUP_ADDRESS = "signup_address"

# Failures against one email that cost nothing: a person mistyping. Each one
# after makes the next attempt wait, from `_FIRST_WAIT` and doubling.
_FREE_FAILURES = 3
_FIRST_WAIT = timedelta(seconds=1)

_SIGNUP_WINDOW = timedelta(hours=1)

# What a reverse proxy, a container network or the server's own computer
# reaches switch-core from. Behind one, every client arrives with its address.
_SHARED_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)

_warned_uncounted = False


@dataclass(frozen=True)
class Limit:
    kind: str
    # What is counted, for the warning a lock-out logs.
    counts: str
    most: int
    window: timedelta
    lock: timedelta
    waits: bool


def _login_email(config: SwitchConfig) -> Limit:
    return Limit(
        kind=LOGIN_EMAIL,
        counts="failed password sign-ins with one email address",
        most=config.gateway_login_max_failures,
        window=timedelta(minutes=config.gateway_login_failure_window_minutes),
        lock=timedelta(minutes=config.gateway_login_lock_minutes),
        waits=True,
    )


def _login_address(config: SwitchConfig) -> Limit:
    return Limit(
        kind=LOGIN_ADDRESS,
        counts="failed password sign-ins from one client address",
        most=config.gateway_login_max_failures_per_address,
        window=timedelta(minutes=config.gateway_login_failure_window_minutes),
        lock=timedelta(minutes=config.gateway_login_lock_minutes),
        waits=False,
    )


def _signup_address(config: SwitchConfig) -> Limit:
    return Limit(
        kind=SIGNUP_ADDRESS,
        counts="sign-ups from one client address",
        most=config.gateway_signup_max_per_hour_per_address,
        window=_SIGNUP_WINDOW,
        lock=_SIGNUP_WINDOW,
        waits=False,
    )


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def email_key(email: str) -> str:
    """The key an email's failures are counted under: case-insensitive, as
    `UserStore.get_by_email` matches an account."""
    return digest(email.lower())


def counted_address(request: Request) -> str | None:
    """The client address to count `request` against, or None when there is
    none to count: no address at all, or one a proxy in front stands for
    every client behind."""
    global _warned_uncounted
    host = request.client.host if request.client is not None else None
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        address = None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if address is not None and not any(address in n for n in _SHARED_NETWORKS):
        if isinstance(address, ipaddress.IPv6Address):
            return str(ipaddress.ip_network(f"{address}/64", strict=False))
        return str(address)
    if not _warned_uncounted:
        _warned_uncounted = True
        logger.warning(
            "Sign-in and sign-up limits per client address are not applied to "
            "requests from %s: it is not a client's own internet address, so it "
            "likely stands for every client behind a proxy. Only the per-account "
            "sign-in limit and the deployment-wide sign-up cap apply to them. "
            "Set FORWARDED_ALLOW_IPS to the proxy's address, and have the proxy "
            "send X-Forwarded-For, for switch-core to see each client's address.",
            host or "an unknown address",
        )
    return None


def _refused_for(row: AuthAttempt | None, now: datetime) -> timedelta | None:
    if row is None or row.locked_until is None or row.locked_until <= now:
        return None
    return row.locked_until - now


def _charge(row: AuthAttempt, limit: Limit, now: datetime) -> None:
    if row.window_started_at + limit.window <= now:
        row.attempts = 0
        row.window_started_at = now
    row.attempts += 1
    if row.attempts >= limit.most:
        row.locked_until = now + limit.lock
        logger.warning(
            "%d %s within %s: refusing more from it for %s",
            row.attempts,
            limit.counts,
            limit.window,
            limit.lock,
        )
    elif limit.waits and row.attempts > _FREE_FAILURES:
        wait = _FIRST_WAIT * 2 ** (row.attempts - _FREE_FAILURES - 1)
        row.locked_until = now + min(wait, limit.lock)
    else:
        row.locked_until = None
    row.expires_at = max(row.window_started_at + limit.window, row.locked_until or now)


def _refund(row: AuthAttempt, limit: Limit) -> None:
    row.attempts = max(row.attempts - 1, 0)
    if row.attempts < limit.most:
        row.locked_until = None


def _in_words(wait: timedelta) -> str:
    seconds = math.ceil(wait.total_seconds())
    if seconds < 60:
        return "1 second" if seconds == 1 else f"{seconds} seconds"
    minutes = math.ceil(seconds / 60)
    return "1 minute" if minutes == 1 else f"{minutes} minutes"


def _too_many(what: str, wait: timedelta) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail=f"Too many {what}. Try again in {_in_words(wait)}.",
        headers={"Retry-After": str(math.ceil(wait.total_seconds()))},
    )


@dataclass(frozen=True)
class LoginAttempt:
    """A password sign-in counted as failed until `succeeded` says not."""

    email_key: str
    address: str | None
    address_limit: Limit

    async def succeeded(self, session: AsyncSession) -> None:
        """Clear the email's failures, and take this attempt back off the
        client address's count. Commits."""
        await STORE.clear(session, LOGIN_EMAIL, self.email_key)
        if self.address is not None:
            [row] = await STORE.lock(
                session, [(LOGIN_ADDRESS, digest(self.address))], datetime.now(UTC)
            )
            _refund(row, self.address_limit)
        await session.commit()


async def admit_login(
    session: AsyncSession, config: SwitchConfig, email: str, request: Request
) -> LoginAttempt:
    """Count a password sign-in as failed before its password is checked, or
    raise 429 if its email or client address is locked out. Commits, so no
    lock is held across bcrypt."""
    now = datetime.now(UTC)
    address = counted_address(request)
    limits = [(_login_email(config), email_key(email))]
    if address is not None:
        # The address before the email, in every attempt: rows are locked in
        # this order, so two attempts sharing both queue rather than deadlock.
        limits.insert(0, (_login_address(config), digest(address)))
    await STORE.prune(session, now)
    rows = await STORE.lock(session, [(limit.kind, key) for limit, key in limits], now)
    waits = [wait for row in rows if (wait := _refused_for(row, now)) is not None]
    if waits:
        await session.commit()
        raise _too_many("sign-in attempts", max(waits))
    for row, (limit, _key) in zip(rows, limits, strict=True):
        _charge(row, limit, now)
    await session.commit()
    return LoginAttempt(
        email_key=email_key(email),
        address=address,
        address_limit=_login_address(config),
    )


async def clear_login_failures(session: AsyncSession, email: str) -> None:
    """Forget an email's failed sign-ins, lifting any lock on it. Does not
    commit."""
    await STORE.clear(session, LOGIN_EMAIL, email_key(email))


async def refuse_signup_from(session: AsyncSession, address: str | None) -> None:
    """Raise 429 if the client address has signed up as many accounts as it
    may this hour. Reads only; `count_signup` counts one."""
    if address is None:
        return
    row = await STORE.get(session, SIGNUP_ADDRESS, digest(address))
    wait = _refused_for(row, datetime.now(UTC))
    if wait is not None:
        logger.warning("Refused sign-up: the client address's hourly limit is reached")
        await session.rollback()
        emit_safely(current_telemetry(), "signup_refused", {"reason": "rate_limited"})
        raise _too_many("sign-ups from your network", wait)


async def count_signup(
    session: AsyncSession, config: SwitchConfig, address: str | None
) -> None:
    """Count an account signed up from the client address, in the caller's
    transaction, to commit with the account."""
    if address is None:
        return
    now = datetime.now(UTC)
    [row] = await STORE.lock(session, [(SIGNUP_ADDRESS, digest(address))], now)
    _charge(row, _signup_address(config), now)
