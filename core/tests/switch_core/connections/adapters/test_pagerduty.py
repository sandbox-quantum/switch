"""PagerDuty's shipped entry against deterministic HTTP fixtures, never live QA."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionNotRevocable,
    IssueRequest,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.adapters.api_key import (
    MAX_IDENTITY_BYTES,
    ApiKeyAdapter,
    InvalidKeyError,
    render,
)
from switch_core.connections.loader import CATALOG

DEFINITION = CATALOG["pagerduty"].definition
FIELDS = {"api_key": "SYNTHETIC-PAGERDUTY-USER-KEY", "region": "pagerduty.com"}


@pytest.mark.parametrize("region", ["pagerduty.com", "eu.pagerduty.com"])
async def test_regional_identity_and_mcp_authentication(region: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert str(request.url) == f"https://api.{region}/users/me"
        assert request.headers["Authorization"] == f"Token token={FIELDS['api_key']}"
        assert FIELDS["api_key"] not in str(request.url)
        assert not request.content
        return httpx.Response(
            200, json={"user": {"id": "SYNTHETIC-USER", "email": "oncall@example.test"}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        fields = adapter.checked_fields({**FIELDS, "region": region})
        identity = await adapter.identify(fields)
        assert (identity.account_id, identity.label) == (
            "SYNTHETIC-USER",
            "oncall@example.test",
        )
        assert DEFINITION.mcp is not None
        [server] = DEFINITION.mcp.servers
        assert render(server.url, fields) == f"https://mcp.{region}/mcp"
        assert {
            name: render(value, fields) for name, value in server.headers.items()
        } == {"Authorization": f"Token token={FIELDS['api_key']}"}
        # Use the framework's secret representation, not a second storage path.
        assert json.loads(adapter.secret(fields).access_token) == {
            "secret": {"api_key": FIELDS["api_key"]},
            "public": {"region": region},
        }


@pytest.mark.parametrize(
    "submitted",
    [
        {},
        {"region": "pagerduty.com"},
        {**FIELDS, "api_key": ""},
        {**FIELDS, "api_key": "contains spaces"},
        {**FIELDS, "api_key": "Token token=synthetic"},
        {**FIELDS, "api_key": "synthetic\r\nX-Injected:yes"},
        {**FIELDS, "api_key": "synthetic\x00"},
        {**FIELDS, "api_key": "non-ascii-☃"},
        {**FIELDS, "api_key": "x" * 1025},
        {**FIELDS, "region": ""},
        {**FIELDS, "region": "us"},
        {**FIELDS, "region": "https://pagerduty.com"},
        {**FIELDS, "region": "pagerduty.com.attacker.test"},
        {**FIELDS, "region": "pagerduty.com@attacker.test"},
        {**FIELDS, "region": "pagerduty.com/../../attacker.test"},
        {**FIELDS, "region": "pagerduty.com\r\nX-Injected:yes"},
        {**FIELDS, "url": "https://attacker.test/mcp"},
    ],
)
async def test_malformed_fields_are_rejected_before_any_http(submitted: dict) -> None:
    def unexpected(request: httpx.Request) -> httpx.Response:
        pytest.fail("Malformed fields must never make an HTTP request")

    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        with pytest.raises(InvalidKeyError) as raised:
            fields = adapter.checked_fields(submitted)
            await adapter.identify(fields)
        assert FIELDS["api_key"] not in str(raised.value)


@pytest.mark.parametrize(
    "document",
    [
        {},
        {"id": "SYNTHETIC-USER", "email": "oncall@example.test"},
        {"user": None},
        {"user": []},
        {"user": {"email": "oncall@example.test"}},
        {"user": {"id": ""}},
        {"user": {"id": False}},
        {"user": {"id": {"value": "SYNTHETIC-USER"}}},
    ],
)
async def test_identity_requires_the_documented_user_wrapper_and_id(document) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=document)
        )
    ) as http:
        with pytest.raises(InvalidKeyError, match="did not name"):
            await ApiKeyAdapter(DEFINITION, http).identify(FIELDS)


@pytest.mark.parametrize(
    "response,error,message",
    [
        (httpx.Response(401), InvalidKeyError, "refused"),
        (httpx.Response(403), InvalidKeyError, "refused"),
        (httpx.Response(404), InvalidKeyError, "would not check"),
        (
            httpx.Response(302, headers={"Location": "https://attacker.test/users/me"}),
            InvalidKeyError,
            "would not check",
        ),
        (httpx.Response(429), ServiceUnavailableError, "unavailable"),
        (httpx.Response(503), ServiceUnavailableError, "unavailable"),
        (httpx.Response(200, text="not JSON"), InvalidKeyError, "not JSON"),
        (
            httpx.Response(200, content=b"x" * (MAX_IDENTITY_BYTES + 1)),
            InvalidKeyError,
            "too large",
        ),
    ],
)
async def test_identity_errors_do_not_expose_secrets_or_follow_redirects(
    response: httpx.Response, error: type[Exception], message: str, caplog
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        # Even an upstream response echoing sensitive content must stay private.
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            content=response.content or FIELDS["api_key"].encode(),
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=True
    ) as http:
        with pytest.raises(error, match=message) as raised:
            await ApiKeyAdapter(DEFINITION, http).identify(FIELDS)
        assert len(requests) == 1
        assert FIELDS["api_key"] not in str(raised.value)
        assert FIELDS["api_key"] not in caplog.text


async def test_transport_errors_do_not_echo_authentication_material() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(FIELDS["api_key"], request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(
            ServiceUnavailableError, match="could not be reached"
        ) as raised:
            await ApiKeyAdapter(DEFINITION, http).identify(FIELDS)
        assert FIELDS["api_key"] not in str(raised.value)


async def test_permanent_key_cannot_be_issued_or_revoked_by_switch() -> None:
    async with httpx.AsyncClient() as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        assert adapter.can_issue is False
        secret = adapter.secret(FIELDS)
        assert secret.access_token is not None
        with pytest.raises(ServiceAdapterError, match="never handed to an agent"):
            await adapter.issue(
                AccessToken(
                    secret.access_token, datetime.now(UTC) + timedelta(hours=1)
                ),
                IssueRequest(
                    service="pagerduty", access="write", reach={}, resources={}
                ),
            )
        with pytest.raises(ConnectionNotRevocable, match="Revoke it in PagerDuty"):
            await adapter.revoke_connection(secret)
