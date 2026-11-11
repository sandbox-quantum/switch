"""Disabled Zendesk groundwork, checked only against synthetic vendor responses."""

import base64
from copy import deepcopy

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.connections.adapters.api_key import ApiKeyAdapter, InvalidKeyError
from switch_core.connections.loader import (
    CATALOG,
    ApiKeyField,
    ConnectionDefinition,
    matches_pattern,
)
from switch_core.connections.registry import build_adapters
from tests.switch_core.connections.adapters.test_api_key import ENTRY
from tests.switch_core.connections.test_registry import HTTP, REG, _broker

FIELDS = {
    "subdomain": "example",
    "email": "agent@example.test",
    "api_token": "SYNTHETIC-TOKEN",
}


@pytest.fixture
async def check():
    requests = []
    replies = [httpx.Response(200, json={"user": {"id": 42, "email": FIELDS["email"]}})]

    def respond(request):
        requests.append(request)
        return replies[0]

    # Even a caller's redirect-following default must not forward credentials.
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(respond), follow_redirects=True
    ) as http:
        yield ApiKeyAdapter(CATALOG["zendesk"].definition, http), requests, replies


async def test_authenticated_show_self_uses_basic_auth(check):
    adapter, requests, _ = check
    identity = await adapter.identify(FIELDS)
    assert (identity.account_id, identity.label) == ("42", "agent@example.test")
    [request] = requests
    assert request.method == "GET"
    assert str(request.url) == "https://example.zendesk.com/api/v2/users/me.json"
    assert (
        request.headers["Authorization"]
        == "Basic "
        + base64.b64encode(b"agent@example.test/token:SYNTHETIC-TOKEN").decode()
    )


@pytest.mark.parametrize("identifier", [None, 0, -1, "", "0", "-1", "01", True, 1.5])
async def test_anonymous_or_invalid_user_id_is_not_a_connection(check, identifier):
    adapter, _, replies = check
    replies[0] = httpx.Response(
        200, json={"user": {"id": identifier, "name": "Anonymous user", "email": None}}
    )
    with pytest.raises(InvalidKeyError):
        await adapter.identify(FIELDS)


@pytest.mark.parametrize("status", [401, 403, 302, 307])
async def test_refusals_and_redirects_do_not_leak_credentials(check, status):
    adapter, requests, replies = check
    replies[0] = httpx.Response(
        status, headers={"Location": "https://other.example.test/"}
    )
    with pytest.raises(InvalidKeyError) as error:
        await adapter.identify(FIELDS)
    assert len(requests) == 1
    assert FIELDS["api_token"] not in str(error.value)
    assert FIELDS["email"] not in str(error.value)


async def test_malformed_identity_json_fails_closed(check):
    adapter, _, replies = check
    replies[0] = httpx.Response(200, text="not JSON")
    with pytest.raises(InvalidKeyError, match="not JSON"):
        await adapter.identify(FIELDS)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "other.test",
        "a/b",
        "a%2fb",
        "a@b",
        "a:443",
        "a?x",
        "a#x",
        "é",
        "xn--example",
        "a" * 64,
    ],
)
async def test_subdomain_is_checked_before_any_http(check, value):
    adapter, requests, _ = check
    # Host-component validation also refuses the reserved IDNA prefix.
    with pytest.raises(InvalidKeyError):
        await adapter.identify({**FIELDS, "subdomain": value})
    assert not requests


async def test_unknown_fields_fail_without_echoing_submitted_data(check):
    adapter, requests, _ = check
    with pytest.raises(InvalidKeyError) as error:
        await adapter.identify({**FIELDS, FIELDS["api_token"]: "extra"})
    assert FIELDS["api_token"] not in str(error.value)
    assert not requests


@pytest.mark.parametrize(
    "url",
    [
        "https://{subdomain}/me",
        "https://{subdomain}.com/me",
        "https://prefix-{subdomain}.example.test/me",
        "https://{subdomain}@example.test/me",
        "https://example.test:{subdomain}/me",
        "https://example.test:443/{subdomain}",
        "https://example.test/me?q={subdomain}",
        "https://example.test/me#{subdomain}",
        "https://example.test/accounts/prefix-{subdomain}",
    ],
)
def test_pattern_fields_cannot_select_arbitrary_destinations(url):
    entry = CATALOG["zendesk"].definition.model_dump()
    entry["auth"]["api_key"]["identity"]["url"] = url
    with pytest.raises(ValueError):
        ConnectionDefinition.model_validate(entry)


def test_pattern_validation_requires_a_full_match():
    field = ApiKeyField(
        name="account", label="Account", secret=False, pattern="^example|other$"
    )
    assert field.pattern is not None
    assert matches_pattern(field.pattern, "example")
    assert matches_pattern(field.pattern, "other")
    assert not matches_pattern(field.pattern, "example-suffix")
    assert not matches_pattern(field.pattern, "example\n")


@pytest.mark.parametrize(
    "change",
    [
        {"secret": True},
        {"choices": ["example"]},
        {"pattern": "[a-z]+"},
        {"pattern": "^[a-z$"},
        {"pattern": r"^(a)\1$"},
    ],
)
def test_pattern_field_kinds_and_linear_regex_are_checked(change):
    field = {
        "name": "account",
        "label": "Account",
        "secret": False,
        "pattern": "^[a-z]+$",
    }
    with pytest.raises(ValueError):
        ApiKeyField.model_validate({**field, **change})


@pytest.mark.parametrize("header", ["Authorization", "authorization", "AUTHORIZATION"])
def test_basic_auth_rejects_conflicting_headers(header):
    entry = CATALOG["zendesk"].definition.model_dump()
    entry["auth"]["api_key"]["identity"]["headers"] = {header: "Bearer {api_token}"}
    with pytest.raises(ValueError, match="conflict"):
        ConnectionDefinition.model_validate(entry)


def test_basic_templates_reject_unknown_fields_and_invalid_usernames():
    entry = CATALOG["zendesk"].definition.model_dump()
    basic = entry["auth"]["api_key"]["identity"]["basic"]
    basic["password"] = "{missing}"
    with pytest.raises(ValueError, match="unknown field"):
        ConnectionDefinition.model_validate(entry)
    basic["password"] = "{api_token}"
    basic["username"] = "prefix:{email}"
    with pytest.raises(ValueError, match="Basic username"):
        ConnectionDefinition.model_validate(entry)


async def test_basic_username_is_rechecked_after_substitution():
    entry = CATALOG["zendesk"].definition.model_dump()
    entry["auth"]["api_key"]["fields"][1]["pattern"] = "^.+$"
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        adapter = ApiKeyAdapter(ConnectionDefinition.model_validate(entry), http)
        with pytest.raises(InvalidKeyError, match="Basic username"):
            await adapter.identify({**FIELDS, "email": "bad:name@example.test"})
    assert not requests


async def test_a_loose_pattern_cannot_change_the_host_or_escape_a_path():
    entry = deepcopy(ENTRY)
    entry["auth"]["api_key"]["fields"][1] = {
        "name": "region",
        "label": "Region",
        "secret": False,
        "pattern": "^.+$",
    }
    entry["auth"]["api_key"]["identity"]["url"] = "https://{region}.example.test/me"
    entry["mcp"]["servers"][0]["url"] = "https://api.example.test/{region}/mcp"
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        adapter = ApiKeyAdapter(ConnectionDefinition.model_validate(entry), http)
        assert (
            adapter.checked_fields({"api_key": "SYNTHETIC", "region": "west-1"})[
                "region"
            ]
            == "west-1"
        )
        for value in ("other.test", "../x", "%2f", "-west", "west-", "west\n"):
            with pytest.raises(InvalidKeyError):
                await adapter.identify({"api_key": "SYNTHETIC", "region": value})
    assert not requests


async def test_disabled_zendesk_registration_and_coming_soon_need_no_database():
    adapters = build_adapters(
        CATALOG, github_app=None, oauth_clients={}, http=HTTP, registration=REG
    )
    assert "zendesk" not in adapters
    factory = async_sessionmaker()
    broker = _broker(CATALOG, factory, adapters, None)
    # An unbound session deliberately cannot execute SQL. The disabled-service
    # standing used by the gateway must be resolved entirely from the catalog.
    async with factory() as session:
        standing = await broker.standing(session, "zendesk")
    assert standing.unavailable is not None
    assert standing.unavailable.code == "coming_soon"
    assert standing.connectable is False
    assert broker.server_serves("zendesk") is False
