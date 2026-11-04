"""The api_key adapter on its own: fields, the identity call, the token."""

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
)
from switch_core.connections.adapters.api_key import (
    ApiKeyAdapter,
    InvalidKeyError,
    key_token,
    render,
)
from switch_core.connections.loader import ConnectionDefinition

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


def _pattern_adapter() -> ApiKeyAdapter:
    url = "https://{account}.snowflakecomputing.com/api/v2/databases/{database}"
    ident = {
        **ENTRY["auth"]["api_key"]["identity"],
        "url": url,
        "headers": {"Authorization": "Bearer {pat}"},
    }
    acc_pat = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
    db_pat = "^[A-Za-z_][A-Za-z0-9_]{0,254}$"
    fields = [
        {"name": "pat", "label": "Personal access token", "secret": True},
        {"name": "account", "label": "Account", "secret": False, "pattern": acc_pat},
        {"name": "database", "label": "Database", "secret": False, "pattern": db_pat},
    ]
    entry = {
        **ENTRY,
        "auth": {
            **ENTRY["auth"],
            "api_key": {
                **ENTRY["auth"]["api_key"],
                "fields": fields,
                "identity": ident,
            },
        },
        "mcp": {
            "servers": [
                {"name": "example", "url": url, "headers": {"API-Key": "{pat}"}}
            ]
        },
    }
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(200))
    )
    return ApiKeyAdapter(ConnectionDefinition.model_validate(entry), client)


def test_checked_fields_accepts_valid_pattern_and_secret():
    valid = {
        "pat": "secret-pat-123456",
        "account": "xy12345-us-east-1",
        "database": "MY_DATABASE_1",
    }
    assert _pattern_adapter().checked_fields(valid) == valid


INVALID_ACCOUNTS = ["", "   ", "a" * 64, "-myaccount", "myaccount-", "MyAccount"] + [
    f"my{s}account" for s in [".", "/", "..", "@", ":", "%2f", " ", "\n", "—"]
]


@pytest.mark.parametrize(
    ("fields", "match"),
    [
        (
            {"pat": "", "account": "valid-account", "database": "DB"},
            "Personal access token is required",
        ),
        *(
            [
                (
                    {"pat": "secret", "account": acc, "database": "DB"},
                    "Account is required"
                    if not acc.strip()
                    else "Account must match the required pattern",
                )
                for acc in INVALID_ACCOUNTS
            ]
        ),
        (
            {"pat": "secret", "account": "valid-account", "database": "bad-db;name"},
            "Database must match the required pattern",
        ),
        (
            {
                "pat": "secret",
                "account": "valid-account",
                "database": "1_leading_digit",
            },
            "Database must match the required pattern",
        ),
    ],
)
def test_checked_fields_rejects_invalid_values(
    fields: dict[str, str], match: str
) -> None:
    with pytest.raises(InvalidKeyError, match=match):
        _pattern_adapter().checked_fields(fields)
