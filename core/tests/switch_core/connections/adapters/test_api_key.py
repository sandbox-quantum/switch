"""The api_key adapter on its own: fields, the identity call, the token."""

from __future__ import annotations

import base64
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


# ── A field checked by a pattern ──────────────────────────────────────────────


def _ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200)


def _subdomain_adapter(pattern: str, handler=_ok) -> ApiKeyAdapter:
    entry = {
        **ENTRY,
        "auth": {
            **ENTRY["auth"],
            "api_key": {
                "fields": [
                    {"name": "api_key", "label": "API key", "secret": True},
                    {
                        "name": "subdomain",
                        "label": "Subdomain",
                        "secret": False,
                        "pattern": pattern,
                    },
                ],
                "identity": {
                    "method": "GET",
                    "url": "https://{subdomain}.example.test/api/me",
                    "headers": {"X-Key": "{api_key}"},
                },
            },
        },
        "mcp": {
            "servers": [
                {
                    "name": "example",
                    "url": "https://mcp.example.test/v1/{subdomain}/mcp",
                    "headers": {"X-Key": "{api_key}"},
                }
            ]
        },
    }
    definition = ConnectionDefinition.model_validate(entry)
    return ApiKeyAdapter(
        definition,
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_a_typed_field_that_matches_its_pattern_is_kept() -> None:
    adapter = _subdomain_adapter("^[a-z0-9][a-z0-9-]{0,62}$")
    assert adapter.checked_fields(
        {"api_key": "SYNTHETIC-KEY", "subdomain": " acme-support "}
    ) == {"api_key": "SYNTHETIC-KEY", "subdomain": "acme-support"}


@pytest.mark.parametrize(
    "value",
    ["acme.evil.test", "acme/evil", "acme@evil", "acme:443", "-acme", "acmé", "a" * 64],
)
def test_a_typed_field_that_breaks_its_pattern_is_refused(value: str) -> None:
    adapter = _subdomain_adapter("^[a-z0-9][a-z0-9-]{0,62}$")
    with pytest.raises(InvalidKeyError, match="Subdomain is not in the form"):
        adapter.checked_fields({"api_key": "SYNTHETIC-KEY", "subdomain": value})


@pytest.mark.parametrize("value", ["acme.evil.test", "..", "acme?x", "acme#x"])
def test_a_loose_pattern_still_cannot_move_the_request(value: str) -> None:
    """Where the value goes decides what it may be, whatever the entry allows."""
    adapter = _subdomain_adapter("^.+$")
    with pytest.raises(InvalidKeyError, match="Subdomain is not in the form"):
        adapter.checked_fields({"api_key": "SYNTHETIC-KEY", "subdomain": value})


async def test_a_typed_field_reaches_the_identity_call_as_its_host() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={})

    adapter = _subdomain_adapter("^[a-z0-9][a-z0-9-]{0,62}$", handler)
    values = adapter.checked_fields({"api_key": "SYNTHETIC-KEY", "subdomain": "acme"})
    await adapter.identify(values)
    assert seen == ["https://acme.example.test/api/me"]


# ── Basic credentials ─────────────────────────────────────────────────────────


def _basic_adapter(handler) -> ApiKeyAdapter:
    entry = {
        **ENTRY,
        "enabled": False,
        "auth": {
            **ENTRY["auth"],
            "api_key": {
                "fields": [
                    {"name": "api_token", "label": "API token", "secret": True},
                    {
                        "name": "subdomain",
                        "label": "Subdomain",
                        "secret": False,
                        "pattern": "^[a-z0-9][a-z0-9-]{0,62}$",
                    },
                    {
                        "name": "email",
                        "label": "Email",
                        "secret": False,
                        "pattern": r"^[^@\s]+@[^@\s]+$",
                    },
                ],
                "identity": {
                    "method": "GET",
                    "url": "https://{subdomain}.example.test/api/v2/users/me.json",
                    "basic": {"username": "{email}/token", "password": "{api_token}"},
                    "account_id": "user.id",
                    "label": "user.email",
                },
            },
        },
    }
    entry.pop("mcp")
    definition = ConnectionDefinition.model_validate(entry)
    return ApiKeyAdapter(
        definition, httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


BASIC_FIELDS = {
    "api_token": "SYNTHETIC-TOKEN",
    "subdomain": "acme",
    "email": "agent@example.test",
}


async def test_basic_credentials_reach_the_identity_call_encoded() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"user": {"id": 1234, "email": "agent@example.test"}}
        )

    adapter = _basic_adapter(handler)
    identity = await adapter.identify(adapter.checked_fields(BASIC_FIELDS))

    assert identity.account_id == "1234"
    assert identity.label == "agent@example.test"
    (request,) = seen
    assert str(request.url) == "https://acme.example.test/api/v2/users/me.json"
    assert (
        request.headers["Authorization"]
        == "Basic "
        + base64.b64encode(b"agent@example.test/token:SYNTHETIC-TOKEN").decode()
    )


async def test_a_basic_user_with_a_colon_is_refused_before_any_call() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={})

    adapter = _basic_adapter(handler)
    values = adapter.checked_fields({**BASIC_FIELDS, "email": "a:b@example.test"})
    with pytest.raises(InvalidKeyError, match="no colon"):
        await adapter.identify(values)
    assert calls == []


async def test_a_refused_basic_key_says_which_fields_to_check() -> None:
    adapter = _basic_adapter(lambda request: httpx.Response(401))
    with pytest.raises(InvalidKeyError, match="refused the key"):
        await adapter.identify(adapter.checked_fields(BASIC_FIELDS))
