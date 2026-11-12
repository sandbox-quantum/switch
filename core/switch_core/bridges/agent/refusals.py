"""Refused controller credentials: one warning each, and a lockout per address.

Before this, a controller token Core refused left no trace at all: a test
once saw a refused, rotated token produce no log line in three hours. Each
refusal now logs one WARN with the address the server saw, the kind of route,
the method and a fixed reason code. Never any part of the token, and never
text the client chose: the address is the one the ASGI server resolved
(uvicorn honours forwarded headers only from the proxies it is told to
trust), and the path is reduced to the kind of route it is.

An address that keeps being refused is locked out for a while: further
refusals from it are answered at once with a 429, and are counted rather
than logged one by one, so a client retrying a dead token can neither fill
the log nor keep Core reading the database for it. The lockout only ever
answers requests that would be refused anyway (no credential, or one whose
signature or expiry fails): a valid token is still checked as usual from a
locked address, so controllers sharing an address behind one proxy are never
locked out by another client's bad token. Enrollment and token exchange,
whose secrets are long and random, log their refusals and count toward an
address's lockout, but are never answered with a 429 themselves. Nothing here sleeps: a refusal is
answered straight away, so a flood cannot tie up workers.

Three things to know when reading the logs:

- The counts live in each Core process. With several workers behind one
  port, a lockout takes up to 20 refusals for each worker.
- "Lockout ended" is logged on that address's next request after the lockout
  runs out, not at the moment it does: nothing here runs on a timer.
- IPv6 clients are counted by their /64, since one client can rotate through
  addresses inside it; IPv4 is counted per address. A request with no IP
  address the server could resolve (`unknown`) is logged but never locked,
  since there is nothing to key it on.
"""

from __future__ import annotations

import ipaddress
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field

from starlette.types import Scope

# One `route_kind` for the log line and the metric alike, so the two can't
# drift: the observability module's.
from switch_core.observability.hosted import record_credential_refusal
from switch_core.observability.hosted import route_kind as route_kind

logger = logging.getLogger(__name__)

#: Refusals from one address within `WINDOW_S` that start a lockout.
LOCKOUT_AFTER = 20
WINDOW_S = 60.0
#: How long a lockout lasts.
LOCKOUT_S = 300.0
#: Addresses tracked at once; the oldest is forgotten past this.
MAX_ADDRESSES = 4096

UNKNOWN_ADDRESS = "unknown"


def lockout_key(address: str) -> str | None:
    """What refusals from `address` are counted under: an IPv4 address itself,
    an IPv6 address's /64, or None for an address that isn't an IP."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return None
    if ip.version == 6:
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def client_address(scope: Scope) -> str:
    """The client address the ASGI server resolved for this request, if it is
    an IP address; otherwise `unknown`. Never a header the client sent."""
    client = scope.get("client")
    host = client[0] if client else None
    if not isinstance(host, str):
        return UNKNOWN_ADDRESS
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return UNKNOWN_ADDRESS


def method_of(scope: Scope) -> str:
    if scope.get("type") == "websocket":
        return "WEBSOCKET"
    method = scope.get("method")
    return (
        method
        if method in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
        else "OTHER"
    )


@dataclass
class _Address:
    refusals: list[float] = field(default_factory=list)
    locked_until: float = 0.0
    suppressed: int = 0


class RefusalGuard:
    """Counts refused controller credentials per client address, logs each
    one once, and locks out an address that keeps being refused."""

    def __init__(
        self,
        *,
        lockout_after: int = LOCKOUT_AFTER,
        window_s: float = WINDOW_S,
        lockout_s: float = LOCKOUT_S,
        max_addresses: int = MAX_ADDRESSES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._lockout_after = lockout_after
        self._window_s = window_s
        self._lockout_s = lockout_s
        self._max = max_addresses
        self._clock = clock
        self._addresses: OrderedDict[str, _Address] = OrderedDict()

    def _entry(self, address: str) -> _Address:
        entry = self._addresses.get(address)
        if entry is None:
            entry = self._addresses[address] = _Address()
            while len(self._addresses) > self._max:
                self._addresses.popitem(last=False)
        else:
            self._addresses.move_to_end(address)
        return entry

    def _end_lockout_if_over(self, address: str, entry: _Address, now: float) -> None:
        if entry.locked_until and now >= entry.locked_until:
            logger.warning(
                "Controller credential lockout ended: client=%s refusals_while_locked=%d",
                address,
                entry.suppressed,
            )
            entry.locked_until = 0.0
            entry.suppressed = 0
            entry.refusals.clear()

    def locked(self, address: str) -> bool:
        """True while `address` (its /64 for IPv6) is locked out."""
        key = lockout_key(address)
        entry = self._addresses.get(key) if key is not None else None
        if key is None or entry is None:
            return False
        self._end_lockout_if_over(key, entry, self._clock())
        return entry.locked_until > 0.0

    def retry_after_s(self, address: str) -> int:
        key = lockout_key(address)
        entry = self._addresses.get(key) if key is not None else None
        if entry is None or not entry.locked_until:
            return 0
        return max(1, int(entry.locked_until - self._clock()) + 1)

    def refused(
        self,
        address: str,
        *,
        reason: str,
        route: str,
        method: str,
        count: bool = True,
    ) -> None:
        """Record one refusal: one WARN, unless the address is locked out, in
        which case it is counted and reported when the lockout ends. With
        `count` false the refusal metric is left to the caller's response,
        which counts every 401 it sends; a lockout starting is counted here
        either way."""
        logger_args = (reason, route, method, address)
        if count:
            # Counted by reason only: never the address, a box id or the token.
            record_credential_refusal(reason, route)
        key = lockout_key(address)
        if key is None:
            logger.warning(
                "Refused a controller credential: reason=%s route=%s method=%s client=%s",
                *logger_args,
            )
            return
        now = self._clock()
        entry = self._entry(key)
        self._end_lockout_if_over(key, entry, now)
        if entry.locked_until:
            entry.suppressed += 1
            return
        logger.warning(
            "Refused a controller credential: reason=%s route=%s method=%s client=%s",
            *logger_args,
        )
        entry.refusals = [t for t in entry.refusals if now - t < self._window_s]
        entry.refusals.append(now)
        if len(entry.refusals) >= self._lockout_after:
            entry.locked_until = now + self._lockout_s
            record_credential_refusal("lockout_started", route)
            logger.warning(
                "Controller credential lockout started: client=%s refusals=%d window_s=%d lockout_s=%d",
                key,
                len(entry.refusals),
                int(self._window_s),
                int(self._lockout_s),
            )


_DEFAULT: RefusalGuard | None = None


def refusal_guard() -> RefusalGuard:
    """The process's one guard, shared by the bearer middleware and the hosted
    controller routes, so an address has one budget across both."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = RefusalGuard()
    return _DEFAULT
