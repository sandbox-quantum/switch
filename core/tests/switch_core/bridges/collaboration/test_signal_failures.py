"""Why a failed Signal bridge reports what it does to telemetry.

Built through the real shared classifier (`lifecycle_service._failure_reason`
with the Signal adapter), not a copy of it, so the test fails if the
adapter ever starts raising an unclassified exception that would read as
`unknown`. Every exception is a real instance of the type the raise site
produces: `httpx` raises its own classes, the RPC client raises
`SignalRpcError`, and `verify_credentials` raises `BridgeCredentialError`.
"""

from __future__ import annotations

import httpx
import pytest

from switch_core.bridges.collaboration.lifecycle_service import _failure_reason
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.bridges.collaboration.signal.adapter import SignalAdapter
from switch_core.bridges.collaboration.signal.rpc import SignalRpcClient, SignalRpcError

_ADAPTER = SignalAdapter


def _reason(exc: BaseException) -> str:
    return _failure_reason(exc, _ADAPTER)


# ── The daemon unreachable: the stream and every call fail with httpx's own
# exceptions, and those read as `network` — never `auth_failed`. ────────────


@pytest.mark.parametrize(
    "make",
    [
        lambda: httpx.ConnectError("connection refused"),
        lambda: httpx.ReadTimeout("read timed out"),
        lambda: httpx.ConnectTimeout("connect timed out"),
        lambda: httpx.RemoteProtocolError("peer closed connection"),
    ],
)
def test_an_unreachable_daemon_is_a_network_failure(make: object) -> None:
    exc = make()
    assert isinstance(exc, httpx.TransportError)
    assert _reason(exc) == "network"


def test_a_lost_stream_is_the_one_the_reconnect_catches() -> None:
    # A dropped stream is a raw-socket reset: `asyncio` surfaces it as the
    # builtin `ConnectionError` (a subclass of `OSError`), the one the shared
    # classifier lists as a network fault — so a flaky tunnel reads as
    # `network`, not a bug in the bridge.
    assert _reason(ConnectionError("reset by peer")) == "network"
    assert _reason(TimeoutError("read timed out")) == "network"


# ── The daemon answers: its own refusals, by their code, never their words
# ─────────────────────────────────────────────────────────────────────────────


def test_an_account_the_daemon_does_not_hold_is_an_auth_failure() -> None:
    # `verify_credentials` and the RPC client both raise this for the
    # daemon's -32602: the operator's number is not on that daemon.
    exc = BridgeCredentialError(
        "The account '+15555550100' is not on that daemon: Specified "
        "account does not exist."
    )
    assert _reason(exc) == "auth_failed"


def test_a_platform_refusal_is_a_platform_error() -> None:
    # A well-formed request the daemon refused — the -1 errors the
    # outbound calls raise: a bad group id, an over-window edit, an
    # attachment it cannot find.
    exc = SignalRpcError(-1, "Invalid phone number 'notanumber'.")
    assert isinstance(exc, BridgeOperationError)
    assert exc.code == -1
    assert _reason(exc) == "platform_error"


def test_a_malformed_rpc_answer_is_a_platform_error_too() -> None:
    exc = BridgeOperationError("The daemon answered without a JSON-RPC body")
    assert _reason(exc) == "platform_error"


# ── Bugs stay bugs: a client request the daemon rejects as wrong ───────────


def test_a_client_built_request_is_not_a_platform_fault() -> None:
    # -32600 / -32601 are raised as plain RuntimeError on purpose: a request
    # the client should never build is a bug in Switch, and `unknown` in
    # telemetry says "look at the process", not "the platform is down".
    exc = RuntimeError(
        "Built a JSON-RPC request the daemon rejected (-32601): Method not implemented"
    )
    assert _reason(exc) == "unknown"


# ── The client's own wiring: what it raises, and that it classifies right
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("code", "expect"),
    [
        (-32602, "auth_failed"),  # the account is not on the daemon
        (-1, "platform_error"),  # the platform refused the operation
        (-32000, "platform_error"),  # anything else the daemon rejects
    ],
)
def test_the_error_code_is_the_only_thing_that_matters(code: int, expect: str) -> None:
    # The mapping is by `error.code`, never the daemon's free-text message
    # (which the fixtures show varies), so the same code with two wordings
    # must classify the same way.
    import asyncio

    def raised(message: str) -> BaseException:
        transport = _error_transport(code, message)
        client = SignalRpcClient(
            daemon_url="http://127.0.0.1:8080",
            account="+15555550100",
            http=httpx.AsyncClient(transport=httpx.MockTransport(transport.handle)),
        )
        with pytest.raises((BridgeCredentialError, SignalRpcError)) as caught:
            asyncio.run(client.call("send", recipient=["x"], message="y"))
        return caught.value

    first = raised("wording one")
    second = raised("wording two")
    assert _reason(first) == expect
    assert _reason(second) == expect


class _error_transport:
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        self.requests: list[httpx.Request] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "error": {"code": self.code, "message": self.message, "data": None},
                "id": 1,
            },
        )
