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


async def test_the_shipped_vercel_adapter_identifies_user() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "user": {
                    "id": "usr_synthetic123",
                    "email": "user@example.test",
                    "username": "exampleuser",
                }
            },
        )

    adapter = ApiKeyAdapter(
        CATALOG["vercel"].definition,
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    identity = await adapter.identify({"api_key": "VERCEL-TOKEN-SECRET"})

    assert (identity.account_id, identity.label) == (
        "usr_synthetic123",
        "user@example.test",
    )
    [request] = seen
    assert request.method == "GET"
    assert str(request.url) == "https://api.vercel.com/v2/user"
    assert request.headers["Authorization"] == "Bearer VERCEL-TOKEN-SECRET"


async def test_disconnecting_vercel_says_only_vercel_can_revoke_it() -> None:
    adapter = ApiKeyAdapter(
        CATALOG["vercel"].definition,
        httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))),
    )
    with pytest.raises(ConnectionNotRevocable, match="Revoke it in Vercel"):
        await adapter.revoke_connection(adapter.secret({"api_key": "VERCEL-SECRET"}))
