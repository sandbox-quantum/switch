"""The Signal RPC client: one call at a time, errors raised by their code.

Transport-level: the daemon is an `httpx.MockTransport`, never the client's
own methods. Responses are the scrubbed `signal_fixtures/` captures.
"""

from __future__ import annotations

import json
from typing import Any, cast

import httpx
import pytest

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.bridges.collaboration.signal.rpc import SignalRpcClient, SignalRpcError

_VALID = {"daemon_url": "http://127.0.0.1:8080", "account": "+15555550100"}


class _Transport:
    """A queue of canned responses, recording every request it is given."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("more requests than canned responses")
        next_response = self.responses.pop(0)
        if isinstance(next_response, Exception):
            raise next_response
        return next_response

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def last_json(self) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.requests[-1].content))


def _client(transport: _Transport) -> SignalRpcClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(transport.handle))
    return SignalRpcClient(
        daemon_url=_VALID["daemon_url"], account=_VALID["account"], http=http
    )


def _result(body: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json=body)


# ── The request shape ─────────────────────────────────────────────────────────


async def test_a_call_carries_the_account_and_returns_the_result() -> None:
    transport = _Transport(
        _result({"jsonrpc": "2.0", "result": {"version": "0.14.9"}, "id": 1})
    )
    client = _client(transport)
    version = await client.call("version")
    await client.aclose()

    assert version == {"version": "0.14.9"}
    request = transport.last_json()
    assert request["jsonrpc"] == "2.0"
    assert request["method"] == "version"
    # The account rides every call, so one daemon serves several numbers.
    assert request["params"] == {"account": "+15555550100"}
    assert request["id"] == 1


async def test_call_ids_are_distinct_per_request() -> None:
    transport = _Transport(
        _result({"jsonrpc": "2.0", "result": {}, "id": 1}),
        _result({"jsonrpc": "2.0", "result": {}, "id": 2}),
    )
    client = _client(transport)
    await client.call("listGroups")
    await client.call("listGroups")
    await client.aclose()

    first = json.loads(transport.requests[0].content)["id"]
    second = json.loads(transport.requests[1].content)["id"]
    assert first != second


# ── Errors by code, never by message ────────────────────────────────────────


async def test_an_account_the_daemon_does_not_hold_is_a_credential_error() -> None:
    transport = _Transport(
        _result(
            {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32602,
                    "message": "Specified account does not exist",
                    "data": None,
                },
                "id": 1,
            }
        )
    )
    client = _client(transport)
    with pytest.raises(BridgeCredentialError, match="not on that daemon"):
        await client.call("listGroups")
    await client.aclose()


async def test_a_malformed_request_is_a_bug_not_a_platform_refusal() -> None:
    # -32600: the client built the request wrong.
    transport = _Transport(
        _result(
            {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32600,
                    "message": "method field must be set",
                    "data": None,
                },
                "id": None,
            }
        )
    )
    client = _client(transport)
    with pytest.raises(RuntimeError, match="-32600"):
        await client.call("listGroups")
    await client.aclose()


async def test_a_method_the_daemon_does_not_know_is_a_bug() -> None:
    # -32601 "Method not implemented": asking the daemon for something it does
    # not have is this client's mistake, in the same class as -32600.
    transport = _Transport(
        _result(
            {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32601,
                    "message": "Method not implemented",
                    "data": None,
                },
                "id": 1,
            }
        )
    )
    client = _client(transport)
    with pytest.raises(RuntimeError, match="-32601"):
        await client.call("noSuchMethod")
    await client.aclose()


async def test_another_refusal_carries_the_code_on_the_error() -> None:
    # -1: the platform's own rejection of a well-formed request.
    transport = _Transport(
        _result(
            {
                "jsonrpc": "2.0",
                "error": {
                    "code": -1,
                    "message": "Invalid phone number 'notanumber': No valid characters found.",
                    "data": None,
                },
                "id": 1,
            }
        )
    )
    client = _client(transport)
    with pytest.raises(SignalRpcError) as caught:
        await client.call("send", recipient=["notanumber"], message="x")
    assert caught.value.code == -1
    await client.aclose()


# ── Unreadable answers ────────────────────────────────────────────────────────


async def test_a_non_json_answer_is_refused_loudly() -> None:
    transport = _Transport(httpx.Response(200, content=b"not json"))
    client = _client(transport)
    with pytest.raises(BridgeOperationError, match="without a JSON-RPC body"):
        await client.call("version")
    await client.aclose()


async def test_a_json_answer_that_is_not_an_object_is_refused_loudly() -> None:
    transport = _Transport(httpx.Response(200, json=[1, 2, 3]))
    client = _client(transport)
    with pytest.raises(BridgeOperationError, match="not an object"):
        await client.call("version")
    await client.aclose()
