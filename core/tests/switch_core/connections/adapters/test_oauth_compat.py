"""OAuth resource identifiers and optional scopes follow vendor metadata."""

from urllib.parse import parse_qs, urlsplit

import pytest
import yaml

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import _https
from tests.switch_core.connections.adapters.test_oauth import (
    REDIRECT,
    STATIC,
    _adapter,
    _sign_in,
)
from tests.switch_core.connections.fake_vendor import ISSUER, MCP_URL, FakeOAuthServer


async def test_explicitly_unscoped_authorization_omits_scope():
    definition = yaml.safe_load(STATIC)
    definition["access"] = {
        "unscoped": True,
        "read": {"scopes": []},
        "write": {"scopes": []},
    }
    adapter, http = _adapter(FakeOAuthServer(), yaml.safe_dump(definition))
    async with http:
        url = await adapter.authorization_url(
            redirect_uri=REDIRECT, state="state", code_challenge="challenge", scopes=[]
        )
    query = parse_qs(urlsplit(url).query, keep_blank_values=True)
    assert "scope" not in query
    assert query["code_challenge"] == ["challenge"]
    assert query["code_challenge_method"] == ["S256"]


async def test_advertised_resource_is_used_for_authorization_and_both_token_flows():
    vendor = FakeOAuthServer()
    resource = "https://resource.example.test/oauth-audience"
    vendor.fail[f"https://mcp.example.test{vendor.resource_metadata_path}"] = (
        200,
        {"resource": resource, "authorization_servers": [ISSUER]},
    )
    adapter, http = _adapter(vendor)
    async with http:
        secret = await _sign_in(adapter, vendor)
        await adapter.refresh(secret)
    assert vendor.authorizations[-1]["resource"] == resource
    assert [form["resource"] for form in vendor.token_requests] == [resource, resource]
    assert vendor.mcp_urls == [MCP_URL]


@pytest.mark.parametrize(
    "url",
    [
        "https://[",
        "https:///no-host",
        "https://user:private@example.test/path",
        "http://example.test",
    ],
)
def test_https_validation_refuses_invalid_authorities_without_echoing_them(url):
    with pytest.raises(ServiceAdapterError) as raised:
        _https(url, "token endpoint")
    assert str(raised.value) == "The vendor's token endpoint is not an https URL."


@pytest.mark.parametrize("url", ["https://example.test/path", "https://[::1]:443/path"])
def test_https_validation_accepts_valid_https(url):
    assert _https(url, "token endpoint") == url


@pytest.mark.parametrize(
    "resource",
    [
        "https://[",
        "https:///no-host",
        "https://user:private@example.test",
        "http://example.test",
        123,
    ],
)
async def test_invalid_advertised_resource_is_a_sanitized_adapter_error(resource):
    vendor = FakeOAuthServer()
    vendor.fail[f"https://mcp.example.test{vendor.resource_metadata_path}"] = (
        200,
        {"resource": resource, "authorization_servers": [ISSUER]},
    )
    adapter, http = _adapter(vendor)
    async with http:
        with pytest.raises(ServiceAdapterError) as raised:
            await adapter.endpoints()
    assert str(raised.value) == "The vendor's resource is not an https URL."


async def test_missing_advertised_resource_uses_the_configured_tenant_url():
    from tests.switch_core.connections.adapters.test_oauth_sign_in_fields import (
        _adapter as field_adapter,
    )
    from tests.switch_core.connections.test_loader import FIELDS_ENTRY

    vendor = FakeOAuthServer()
    vendor.per_path = True
    vendor.fail[
        "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp/team-a"
    ] = (200, {"authorization_servers": [ISSUER]})
    async with vendor.client() as http:
        adapter = field_adapter(http, FIELDS_ENTRY).for_fields({"tenant": "team-a"})
        secret = await _sign_in(adapter, vendor)
        await adapter.refresh(secret)
    expected = MCP_URL + "/team-a"
    assert vendor.authorizations[-1]["resource"] == expected
    assert [form["resource"] for form in vendor.token_requests] == [expected, expected]
