"""The Signal connection form: what parses, what is refused, and the credential check.

All daemon answers are the scrubbed captures in `signal_fixtures/` (a live
signal-cli 0.14.9), mocked at the HTTP transport — never the adapter's own
methods.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.bridges.collaboration.signal.adapter import (
    SignalAdapter,
    SignalConnectionConfig,
)

_VALID = {"daemon_url": "http://127.0.0.1:8080", "account": "+15555550100"}


class _Daemon:
    """A recording stand-in for the daemon's one JSON-RPC endpoint."""

    def __init__(
        self, response: httpx.Response | None, *, failing: bool = False
    ) -> None:
        self.response = response
        self.failing = failing
        self.requests: list[httpx.Request] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.failing:
            raise httpx.ConnectError("connection refused")
        assert self.response is not None
        return self.response

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def last_json(self) -> Any:
        return json.loads(self.requests[-1].content)


def _patch_daemon(monkeypatch: pytest.MonkeyPatch, daemon: _Daemon) -> None:
    """Route the adapter's own HTTP client at the stand-in daemon.

    The client is still a real `httpx.AsyncClient` on a `MockTransport` —
    only the bytes that would cross the network are faked.
    """

    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("base_url", None)
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(daemon.handler), **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.signal.adapter.httpx.AsyncClient", factory
    )


# ── The config is the form ────────────────────────────────────────────────────


def test_a_valid_config_parses() -> None:
    config = SignalConnectionConfig.model_validate(_VALID)
    assert config.daemon_url == "http://127.0.0.1:8080"
    assert config.account == "+15555550100"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://127.0.0.1:8080",
        "http://127.0.0.1:8080/api/v1/rpc",
        "127.0.0.1:8080",
        "",
    ],
)
def test_a_daemon_url_that_is_not_a_base_address_is_refused(url: str) -> None:
    with pytest.raises(ValidationError, match="daemon_url"):
        SignalConnectionConfig.model_validate({**_VALID, "daemon_url": url})


@pytest.mark.parametrize(
    "account",
    [
        "15555550100",  # no +
        "+15555550100x",  # not a digit
        "+155555",  # too short (6 digits)
        "+1555555010012345678",  # too long (16 digits)
        "+05555550100",  # leading zero
        "",  # empty
    ],
)
def test_a_number_that_is_not_e164_is_refused(account: str) -> None:
    with pytest.raises(ValidationError, match="account"):
        SignalConnectionConfig.model_validate({**_VALID, "account": account})


def test_outbound_urls_names_the_daemon_address_only() -> None:
    assert SignalAdapter.outbound_urls(_VALID) == ["http://127.0.0.1:8080"]
    assert SignalAdapter.outbound_urls({"account": "+15555550100"}) == []


# ── verify_credentials: the cheap authenticated call ──────────────────────────


def _list_accounts(*accounts: dict[str, str]) -> _Daemon:
    result = [{"number": number, "aci": aci} for number, aci in accounts]
    return _Daemon(
        httpx.Response(200, json={"jsonrpc": "2.0", "result": result, "id": 1})
    )


async def test_credentials_are_accepted_when_the_daemon_holds_the_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    daemon = _list_accounts(("+15555550100", "00000000-0000-4000-8000-000000000001"))
    _patch_daemon(monkeypatch, daemon)

    await SignalAdapter.verify_credentials(_VALID)
    assert daemon.last.url.path == "/api/v1/rpc"
    assert daemon.last_json()["method"] == "listAccounts"


async def test_a_daemon_that_holds_no_such_account_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    daemon = _list_accounts(("+15555550200", "00000000-0000-4000-8000-000000000002"))
    _patch_daemon(monkeypatch, daemon)

    with pytest.raises(BridgeCredentialError, match="does not hold the account"):
        await SignalAdapter.verify_credentials(_VALID)


async def test_the_daemons_own_rejection_is_a_credential_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    daemon = _Daemon(
        httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "error": {
                    "code": -32602,
                    "message": "Specified account does not exist",
                    "data": None,
                },
                "id": 1,
            },
        )
    )
    _patch_daemon(monkeypatch, daemon)

    with pytest.raises(BridgeCredentialError, match="No account"):
        await SignalAdapter.verify_credentials(_VALID)


async def test_an_unreachable_daemon_is_a_credential_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_daemon(monkeypatch, _Daemon(None, failing=True))

    with pytest.raises(BridgeCredentialError, match="Could not reach"):
        await SignalAdapter.verify_credentials(_VALID)


async def test_a_body_that_is_not_json_rpc_is_an_operation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    daemon = _Daemon(httpx.Response(200, content=b"not json"))
    _patch_daemon(monkeypatch, daemon)

    with pytest.raises(BridgeOperationError, match="without a JSON-RPC body"):
        await SignalAdapter.verify_credentials(_VALID)
