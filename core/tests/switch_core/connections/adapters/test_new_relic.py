"""The shipped New Relic contract exercised through the generic key adapter.

All credentials and identity responses here are synthetic; no vendor calls.
"""

import json
from collections.abc import Callable
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
    key_token,
    render,
)
from switch_core.connections.loader import CATALOG

DEFINITION = CATALOG["new-relic"].definition
USER_KEY = "SYNTHETIC-NEW-RELIC-USER-KEY"
FIELDS = {"user_key": USER_KEY, "region": "newrelic.com"}
REGIONS = [
    ("newrelic.com", "api.newrelic.com", "mcp.newrelic.com"),
    ("eu.newrelic.com", "api.eu.newrelic.com", "mcp.eu.newrelic.com"),
    ("jp.newrelic.com", "api.jp.newrelic.com", "mcp.jp.newrelic.com"),
]


@pytest.mark.parametrize(("region", "identity_host", "mcp_host"), REGIONS)
@pytest.mark.parametrize("user_id", [42, "synthetic-user"])
async def test_regional_identity_and_host_credential_templates(
    region: str, identity_host: str, mcp_host: str, user_id: int | str
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"data": {"requestContext": {"userId": user_id}}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        values = adapter.checked_fields({"user_key": USER_KEY, "region": region})
        identity = await adapter.identify(values)
        assert identity.account_id == str(user_id)
        assert identity.label == f"New Relic key · {region}"
        assert USER_KEY not in repr(identity)
        [request] = seen
        assert request.method == "POST"
        assert str(request.url) == f"https://{identity_host}/graphql"
        assert request.headers["API-Key"] == USER_KEY
        assert request.headers["Content-Type"] == "application/json"
        assert request.headers["Accept"] == "application/json"
        assert json.loads(request.content) == {"query": "{ requestContext { userId } }"}
        assert USER_KEY not in str(request.url)
        assert USER_KEY.encode() not in request.content

        # Exercise the exact envelope and templates the session host consumes;
        # this does not override the broker's refusal to issue non-expiring keys.
        sign_in = DEFINITION.auth.api_key
        assert sign_in is not None
        token = key_token(sign_in, values)
        assert adapter.secret(values).access_token == token
        envelope = json.loads(token)
        assert envelope == {
            "secret": {"user_key": USER_KEY},
            "public": {"region": region},
        }
        host_values = {**envelope["secret"], **envelope["public"]}
        assert DEFINITION.mcp is not None
        [server] = DEFINITION.mcp.servers
        assert render(server.url, host_values) == f"https://{mcp_host}/mcp/"
        assert {
            name: render(value, host_values) for name, value in server.headers.items()
        } == {"api-key": USER_KEY}


@pytest.mark.parametrize(
    "fields",
    [
        {**FIELDS, "region": "us"},
        {**FIELDS, "region": "https://newrelic.com"},
        {**FIELDS, "region": "newrelic.com.attacker.test"},
        {**FIELDS, "region": "newrelic.com/path"},
        {**FIELDS, "region": "newrelic.com?redirect=attacker.test"},
        {**FIELDS, "region": "NEWRELIC.COM"},
        {**FIELDS, "region": ""},
        {"user_key": USER_KEY},
        {"region": "newrelic.com"},
        {**FIELDS, "user_key": "bad\r\nInjected:header"},
        {**FIELDS, "endpoint": "https://attacker.test"},
    ],
)
async def test_invalid_fields_are_rejected_before_any_vendor_request(
    fields: dict[str, str],
) -> None:
    def unexpected(request: httpx.Request) -> httpx.Response:
        pytest.fail("invalid fields must not reach the vendor")

    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        with pytest.raises(InvalidKeyError) as raised:
            values = adapter.checked_fields(fields)
            await adapter.identify(values)
        assert USER_KEY not in str(raised.value)


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (400, InvalidKeyError),
        (401, InvalidKeyError),
        (403, InvalidKeyError),  # Wrong region or access refusal.
        (429, ServiceUnavailableError),
        (500, ServiceUnavailableError),
        (503, ServiceUnavailableError),
        (302, InvalidKeyError),  # Never forward a key to a redirect target.
    ],
)
async def test_http_failures_do_not_echo_vendor_response_or_follow_redirects(
    status: int, error: type[ServiceAdapterError]
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            status,
            text=f"vendor detail containing {USER_KEY}",
            headers={"Location": "https://attacker.test/collect"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        with pytest.raises(error) as raised:
            await adapter.identify(adapter.checked_fields(FIELDS))
        assert USER_KEY not in str(raised.value)
        assert "vendor detail" not in str(raised.value)
        assert len(seen) == 1


@pytest.mark.parametrize(
    "response",
    [
        lambda: httpx.Response(200, json={"errors": [{"message": USER_KEY}]}),
        lambda: httpx.Response(
            200, json={"data": {"requestContext": {"userId": None}}}
        ),
        lambda: httpx.Response(200, json={"data": {"requestContext": None}}),
        lambda: httpx.Response(200, json={"data": {}}),
        lambda: httpx.Response(200, json={"requestContext": {"userId": 42}}),
        lambda: httpx.Response(
            200, json={"data": {"requestContext": {"userId": True}}}
        ),
        lambda: httpx.Response(200, json={"data": {"requestContext": {"userId": ""}}}),
        lambda: httpx.Response(
            200, json={"data": {"requestContext": {"userId": {"id": 42}}}}
        ),
        lambda: httpx.Response(200, json=[]),
        lambda: httpx.Response(200, text=f"not JSON {USER_KEY}"),
        lambda: httpx.Response(200, content=b"x" * (MAX_IDENTITY_BYTES + 1)),
    ],
)
async def test_invalid_identity_responses_are_refused_without_secret_disclosure(
    response: Callable[[], httpx.Response],
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: response())
    ) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        with pytest.raises(InvalidKeyError) as raised:
            await adapter.identify(adapter.checked_fields(FIELDS))
        assert USER_KEY not in str(raised.value)


async def test_transport_failure_is_retryable_without_echoing_secrets() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"synthetic failure {USER_KEY}", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        with pytest.raises(
            ServiceUnavailableError, match="could not be reached"
        ) as raised:
            await adapter.identify(adapter.checked_fields(FIELDS))
        assert USER_KEY not in str(raised.value)


async def test_non_expiring_key_cannot_be_issued_or_revoked_by_switch() -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: pytest.fail("issuance and disconnect make no vendor calls")
        )
    ) as http:
        adapter = ApiKeyAdapter(DEFINITION, http)
        secret = adapter.secret(adapter.checked_fields(FIELDS))
        assert adapter.can_issue is False
        assert secret.access_token is not None
        with pytest.raises(ServiceAdapterError, match="never handed to an agent"):
            await adapter.issue(
                AccessToken(
                    secret.access_token, datetime.now(UTC) + timedelta(hours=1)
                ),
                IssueRequest(
                    service="new-relic", access="write", reach={}, resources={}
                ),
            )
        with pytest.raises(ConnectionNotRevocable, match="Revoke it in New Relic"):
            await adapter.revoke_connection(secret)
