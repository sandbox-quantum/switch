"""The api_key adapter on its own: fields, the identity call, the token."""

from __future__ import annotations

import hashlib
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
    ApiKeyAdapter,
    InvalidKeyError,
    key_token,
    render,
)
from switch_core.connections.loader import CATALOG, ConnectionDefinition

ENTRY = {
    "slug": "example",
    "name": "Example",
    "category": "Observability",
    "description": "Query Example telemetry.",
    "enabled": True,
    "adapter": "api_key",
    "auth": {
        "type": "api_key",
        "refresh": "none",
        "api_key": {
            "fields": [
                {"name": "api_key", "label": "User key", "secret": True},
                {
                    "name": "region",
                    "label": "Region",
                    "secret": False,
                    "choices": ["us.example.test", "eu.example.test"],
                },
            ],
            "identity": {
                "method": "POST",
                "url": "https://api.{region}/graphql",
                "headers": {"API-Key": "{api_key}"},
                "body": {"query": "{ actor { user { id email } } }"},
                "account_id": "data.actor.user.id",
                "label": "data.actor.user.email",
            },
        },
    },
    "token": {"kind": "pass_through", "max_lifetime": None},
    "mcp": {
        "servers": [
            {
                "name": "example",
                "url": "https://mcp.{region}/mcp",
                "headers": {"API-Key": "{api_key}"},
            }
        ]
    },
    "tools": {"mode": "pass_through"},
}
FIELDS = {"api_key": "SYNTHETIC-USER-KEY", "region": "eu.example.test"}


def _adapter(handler) -> ApiKeyAdapter:
    definition = ConnectionDefinition.model_validate(ENTRY)
    return ApiKeyAdapter(
        definition, httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


async def test_a_post_identity_call_names_the_account() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"data": {"actor": {"user": {"id": 42, "email": "ada@example.test"}}}},
        )

    identity = await _adapter(handler).identify(FIELDS)

    assert (identity.account_id, identity.label) == ("42", "ada@example.test")
    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == "https://api.eu.example.test/graphql"
    assert request.headers["API-Key"] == "SYNTHETIC-USER-KEY"
    assert json.loads(request.content) == {"query": "{ actor { user { id email } } }"}


async def test_an_answer_that_names_no_account_is_refused() -> None:
    adapter = _adapter(lambda request: httpx.Response(200, json={"data": {}}))
    with pytest.raises(InvalidKeyError, match="did not name"):
        await adapter.identify(FIELDS)


async def test_a_vendor_outage_is_not_blamed_on_the_key() -> None:
    adapter = _adapter(lambda request: httpx.Response(503))
    with pytest.raises(Exception, match="unavailable") as raised:
        await adapter.identify(FIELDS)
    assert not isinstance(raised.value, InvalidKeyError)


def test_the_token_splits_secret_from_public_fields_and_templates_fill_in() -> None:
    sign_in = ConnectionDefinition.model_validate(ENTRY).auth.api_key
    assert sign_in is not None
    token = key_token(sign_in, FIELDS)
    assert " " not in token
    assert json.loads(token) == {
        "secret": {"api_key": "SYNTHETIC-USER-KEY"},
        "public": {"region": "eu.example.test"},
    }
    assert (
        render("https://mcp.{region}/mcp", FIELDS) == "https://mcp.eu.example.test/mcp"
    )


async def test_disconnecting_says_only_the_vendor_can_revoke_a_key() -> None:
    adapter = _adapter(lambda request: httpx.Response(200))
    with pytest.raises(ConnectionNotRevocable, match="Revoke it in Example"):
        await adapter.revoke_connection(adapter.secret(FIELDS))


async def test_a_key_is_never_issued_to_an_agent() -> None:
    adapter = _adapter(lambda request: httpx.Response(200))
    assert adapter.can_issue is False
    key = adapter.secret(FIELDS).access_token
    assert key is not None
    with pytest.raises(ServiceAdapterError, match="never handed to an agent"):
        await adapter.issue(
            AccessToken(key, datetime.now(UTC) + timedelta(hours=1)),
            IssueRequest(service="example", access="write", reach={}, resources={}),
        )


SNOWFLAKE_FIELDS = {
    "account": "myorg-myaccount",
    "database": "ANALYTICS_DB",
    "schema": "PUBLIC",
    "server": "CORTEX_MCP",
    "pat": "snt-synthetic-pat-secret-12345",
}


def _snowflake_adapter(handler) -> ApiKeyAdapter:
    definition = CATALOG["snowflake"].definition
    return ApiKeyAdapter(
        definition, httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


@pytest.mark.parametrize(
    "account",
    [
        "myorg-myaccount",
        "xy12345",
        "my_org-my_account",
        "xy12345-us-east-1",
        "ACCOUNT-1",
    ],
)
def test_snowflake_checked_fields_accepts_valid_accounts(account: str) -> None:
    adapter = _snowflake_adapter(lambda req: httpx.Response(200))
    fields = {**SNOWFLAKE_FIELDS, "account": account}
    checked = adapter.checked_fields(fields)
    assert checked["account"] == account


@pytest.mark.parametrize(
    "invalid_account",
    [
        "attacker.com",
        "http://myaccount",
        "https://myaccount",
        "myaccount:8080",
        "user@myaccount",
        "myaccount/path",
        "myaccount%2fpath",
        "..",
        "-myaccount",
        "myaccount-",
        "_myaccount",
        "myaccount_",
        "my--account",
        "my__account",
        "my account",
        "my\taccount",
        "myaccounté",
        "",
        "127.0.0.1",
        "myaccount.",
        ".myaccount",
    ],
)
def test_snowflake_checked_fields_rejects_hostile_or_malformed_accounts(
    invalid_account: str,
) -> None:
    adapter = _snowflake_adapter(lambda req: httpx.Response(200))
    fields = {**SNOWFLAKE_FIELDS, "account": invalid_account}
    with pytest.raises(InvalidKeyError, match="Account is (invalid|required)"):
        adapter.checked_fields(fields)


@pytest.mark.parametrize("field_name", ["database", "schema", "server"])
@pytest.mark.parametrize(
    "invalid_value",
    [
        "../traversal",
        "db/schema",
        "db%2fschema",
        "db.schema",
        "db;DROP TABLE users",
        "db name with spaces",
        "",
    ],
)
def test_snowflake_checked_fields_rejects_invalid_path_identifiers(
    field_name: str, invalid_value: str
) -> None:
    adapter = _snowflake_adapter(lambda req: httpx.Response(200))
    fields = {**SNOWFLAKE_FIELDS, field_name: invalid_value}
    with pytest.raises(InvalidKeyError):
        adapter.checked_fields(fields)


async def test_snowflake_identity_verifies_pat_against_rest_api() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"name": "PUBLIC", "database": "ANALYTICS_DB"},
        )

    adapter = _snowflake_adapter(handler)
    identity = await adapter.identify(SNOWFLAKE_FIELDS)

    [req] = seen
    assert req.method == "GET"
    assert (
        str(req.url)
        == "https://myorg-myaccount.snowflakecomputing.com/api/v2/databases/ANALYTICS_DB/schemas/PUBLIC"
    )
    assert req.headers["Authorization"] == "Bearer snt-synthetic-pat-secret-12345"
    assert (
        req.headers["X-Snowflake-Authorization-Token-Type"]
        == "PROGRAMMATIC_ACCESS_TOKEN"
    )
    expected_account_id = hashlib.sha256(b"snt-synthetic-pat-secret-12345").hexdigest()
    assert identity.account_id == expected_account_id
    assert (
        identity.label
        == "Snowflake key · myorg-myaccount · ANALYTICS_DB · PUBLIC · CORTEX_MCP"
    )


@pytest.mark.parametrize("status_code", [401, 403])
async def test_snowflake_identity_refuses_invalid_or_revoked_pat(
    status_code: int,
) -> None:
    adapter = _snowflake_adapter(lambda req: httpx.Response(status_code))
    with pytest.raises(InvalidKeyError) as exc_info:
        await adapter.identify(SNOWFLAKE_FIELDS)
    assert "refused the key" in str(exc_info.value)
    # Ensure the PAT secret is never exposed in the error message
    assert "snt-synthetic-pat-secret-12345" not in str(exc_info.value)


@pytest.mark.parametrize("status_code", [500, 502, 503])
async def test_snowflake_identity_handles_service_unavailable(
    status_code: int,
) -> None:
    adapter = _snowflake_adapter(lambda req: httpx.Response(status_code))
    with pytest.raises(ServiceUnavailableError) as exc_info:
        await adapter.identify(SNOWFLAKE_FIELDS)
    assert "unavailable" in str(exc_info.value)
    assert "snt-synthetic-pat-secret-12345" not in str(exc_info.value)


async def test_snowflake_identity_handles_network_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("Connection timed out")

    adapter = _snowflake_adapter(handler)
    with pytest.raises(
        ServiceUnavailableError, match="could not be reached"
    ) as exc_info:
        await adapter.identify(SNOWFLAKE_FIELDS)
    assert "snt-synthetic-pat-secret-12345" not in str(exc_info.value)
