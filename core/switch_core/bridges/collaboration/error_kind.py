"""What kind of error a bridge operation raised, for `switch.bridge.errors`.

A revoked token and a rate limit both arrive as "the call raised", and they
ask different people to act: an operator to reconnect the app, or nobody but
the platform's clock. `classify_bridge_error` reads which one it was into the
closed set `BridgeErrorKind`.

It walks the exception and the causes it was raised `from`, outermost first,
because adapters wrap their SDK's errors (`RichContentFailed` carries the
`SlackApiError` as its cause). For each one it asks the bridge's adapter
(`PlatformAdapter.classify_error`, for that platform's SDK), then the shared
rules here. The first answer wins; an exception nobody recognises is `other`.

Never the exception's message as a value: it routinely carries a workspace
name or a token fragment, and metric values come from a fixed set.
"""

from __future__ import annotations

import logging

import aiohttp
import httpx

from switch_core.bridges.collaboration.adapter import (
    DirectorySearchBusy,
    PlatformAdapter,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeErrorKind,
    error_kind_for_status,
)

logger = logging.getLogger(__name__)

# Reaching the platform failed outright, in the transports Switch itself
# depends on: aiohttp (Slack's Socket Mode, Teams' inbound listener) and httpx
# (Teams' token exchange and Graph calls, and most platforms' REST clients). A
# platform whose SDK has a transport of its own names those exceptions in its
# adapter's `classify_failure` and `classify_error`.
#
# Each library's own base class for "the transport failed", not the individual
# leaves. A timeout is the case that makes this worth stating: `ConnectTimeout`
# is a `TimeoutException` rather than a `ConnectError` in httpx, and
# `ServerTimeoutError` is not a `ClientOSError` in aiohttp — so a list of
# leaves classifies a refusal as `network` and the timeout beside it as
# `unknown`, which are the two outcomes an operator most needs to tell apart.
NETWORK_EXCEPTIONS = (
    aiohttp.ClientConnectionError,
    httpx.TransportError,
    # The two builtins, for a failure that reaches here without a library's
    # name on it: `asyncio.wait_for` raises the first, and a raw socket
    # connect the second.
    TimeoutError,
    ConnectionError,
)

# How far down a chain of causes to look. Adapters wrap once or twice; a
# chain longer than this is not one anybody built on purpose.
_MAX_CHAIN = 8


def classify_bridge_error(
    exc: BaseException, adapter_cls: type[PlatformAdapter] | None
) -> BridgeErrorKind:
    """The kind of error `exc` is. `adapter_cls` is None where no platform
    adapter is involved (the agent bridge): only the shared rules apply."""
    seen: set[int] = set()
    link: BaseException | None = exc
    while link is not None and id(link) not in seen and len(seen) < _MAX_CHAIN:
        seen.add(id(link))
        kind = _adapter_kind(link, adapter_cls) or _shared_kind(link)
        if kind is not None:
            return kind
        link = link.__cause__
    return "other"


def _adapter_kind(
    exc: BaseException, adapter_cls: type[PlatformAdapter] | None
) -> BridgeErrorKind | None:
    if adapter_cls is None:
        return None
    # Guarded because this runs while an error is being counted on its way
    # out: a classifier that raised would replace the bridge's own exception.
    try:
        return adapter_cls.classify_error(exc)
    except Exception:
        logger.exception(
            "%s.classify_error raised; classifying with the shared rules",
            adapter_cls.__name__,
        )
        return None


def _shared_kind(exc: BaseException) -> BridgeErrorKind | None:
    if isinstance(exc, BridgeCredentialError):
        return "auth"
    if isinstance(exc, RichContentThrottled | DirectorySearchBusy):
        return "rate_limited"
    if isinstance(exc, httpx.HTTPStatusError):
        return error_kind_for_status(exc.response.status_code)
    if isinstance(exc, aiohttp.ClientResponseError):
        return error_kind_for_status(exc.status)
    if isinstance(exc, NETWORK_EXCEPTIONS):
        return "network"
    return None
