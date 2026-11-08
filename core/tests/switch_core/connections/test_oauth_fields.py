"""Stack-bound OAuth fields cannot select another origin or retain another stack's grants."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import yaml
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult
from pydantic import ValidationError

from switch_core.connections.adapters import ServiceAdapterError, oauth
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import (
    CATALOG,
    ConnectionDefinition,
    oauth_field_values,
    oauth_mcp_url,
)
from tests.switch_core.connections.test_loader import OAUTH_ENTRY


def definition():
    entry = yaml.safe_load(OAUTH_ENTRY)
    entry["auth"]["oauth"]["fields"] = [
        {
            "name": "stack",
            "label": "Stack",
            "help": "Use a Grafana Cloud hostname.",
            "pattern": r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.grafana\.net$",
        }
    ]
    entry["auth"]["identity"] = {
        "mcp_tool": "user_info",
        "account_id": ["connection.stack", "login"],
        "label": "login",
    }
    entry["mcp"]["servers"][0]["url"] = "https://mcp.example.test/mcp/{stack}"
    return ConnectionDefinition.model_validate(entry)


@pytest.mark.parametrize(
    "value",
    [
        "https://example.grafana.net",
        "example.grafana.net/else",
        "example.grafana.net?x=1",
        "example.grafana.net#x",
        "example.grafana.net.attacker.test",
        "example.grafana.net:443",
        "example@grafana.net",
        "..",
        "%2e%2e",
        "example\\grafana.net",
        "example.grafana.net\n",
        "EXAMPLE.grafana.net",
        "é.grafana.net",
        "example..grafana.net",
        "-example.grafana.net",
        "a" * 64 + ".grafana.net",
    ],
)
def test_stack_rejects_unsafe_input(value):
    with pytest.raises(ValueError):
        oauth_field_values(definition().auth.oauth.fields, {"stack": value})


@pytest.mark.parametrize(
    "values", [{}, {"stack": "example.grafana.net", "other": "value"}]
)
def test_stack_fields_must_match_catalog_exactly(values):
    with pytest.raises(ValueError):
        oauth_field_values(definition().auth.oauth.fields, values)


@pytest.mark.parametrize(
    "url",
    [
        "https://{stack}/mcp",
        "https://mcp.example.test/mcp/prefix-{stack}",
        "https://mcp.example.test/mcp/{stack}.suffix",
        "https://mcp.example.test/mcp?stack={stack}",
        "https://mcp.example.test/mcp#{stack}",
        "https://{stack}.test/mcp",
    ],
)
def test_stack_cannot_rewrite_url_structure(url):
    entry = definition().model_dump()
    entry["mcp"]["servers"][0]["url"] = url
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(entry)


def test_stack_must_be_in_account_identity():
    entry = definition().model_dump()
    entry["auth"]["identity"]["account_id"] = "login"
    with pytest.raises(ValidationError, match="lists every connection field"):
        ConnectionDefinition.model_validate(entry)


def test_stack_url_stays_on_vendor_origin():
    d = definition()
    values = oauth_field_values(
        d.auth.oauth.fields, {"stack": "example-stack.grafana.net"}
    )
    assert (
        oauth_mcp_url(d.mcp.servers[0].url, values)
        == "https://mcp.example.test/mcp/example-stack.grafana.net"
    )
    with pytest.raises(ValueError, match="dots"):
        oauth_mcp_url("https://{stack}.example.test/mcp", values)


async def test_same_login_on_different_stacks_has_different_identity(monkeypatch):
    server = FastMCP("stack-test")

    @server.tool(annotations={"readOnlyHint": True})
    def user_info() -> ToolResult:
        return ToolResult(
            content=[],
            structured_content={
                "login": "example-user",
                "connection": {"stack": "forged.grafana.net"},
                "orgs": [{"orgId": 1}, {"orgId": 2}],
            },
        )

    urls = []

    def transport(url, **kwargs):
        urls.append(url)
        return server

    monkeypatch.setattr(oauth, "StreamableHttpTransport", transport)
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            definition(),
            StaticClient(
                OAuthClientCredentials("example-client", None, authentication=None)
            ),
            http,
        )
        first = await adapter.with_fields({"stack": "first.grafana.net"}).identify(
            "example-bearer-value"
        )
        second = await adapter.with_fields({"stack": "second.grafana.net"}).identify(
            "example-bearer-value"
        )
    assert first.account_id == "first.grafana.net:example-user"
    assert second.account_id == "second.grafana.net:example-user"
    assert urls == [
        "https://mcp.example.test/mcp/first.grafana.net",
        "https://mcp.example.test/mcp/second.grafana.net",
    ]
    assert adapter._mcp_url == "https://mcp.example.test/mcp/{stack}"


async def test_stack_is_preserved_across_exchange_and_refresh(monkeypatch):
    async def request(self, fields):
        assert self._mcp_url == "https://mcp.example.test/mcp/example.grafana.net"
        return oauth.TokenAnswer(
            {
                "access_token": "example-access",
                "refresh_token": "example-refresh",
                "expires_in": 3600,
                "scope": "example:read",
            },
            "example-client",
        )

    monkeypatch.setattr(OAuthAdapter, "_token_request", request)
    async with httpx.AsyncClient() as http:
        base = OAuthAdapter(
            definition(),
            StaticClient(
                OAuthClientCredentials("example-client", None, authentication=None)
            ),
            http,
        )
        adapter = base.with_fields({"stack": "example.grafana.net"})
        answer = await adapter.exchange_code(
            code="example-code",
            verifier="example-verifier",
            redirect_uri="http://127.0.0.1:12345/callback",
            scopes=["example:read"],
        )
        renewed = await base.refresh(answer.secret)
    assert renewed.values["connection_fields"] == {"stack": "example.grafana.net"}


def test_grafana_complete_and_skill_is_safe():
    entry = CATALOG["grafana"]
    assert entry.definition.enabled
    assert entry.definition.auth.refresh in ("rotating", "reusable")
    assert entry.definition.auth.identity.account_id == ["connection.stack", "login"]
    assert "SKILL.md" in entry.skill_files


@pytest.mark.parametrize(
    "url",
    [
        "https://prefix{stack}.example.test/mcp/{stack}",
        "https://mcp.example.test/{stack}/prefix{stack}",
        "https://mcp.example.test/{stack}?stack={stack}",
    ],
)
def test_every_stack_occurrence_must_be_a_whole_segment(url):
    entry = definition().model_dump()
    entry["mcp"]["servers"][0]["url"] = url
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(entry)


@pytest.mark.parametrize("field", ["authorization_url", "token_url", "revocation_url"])
def test_oauth_endpoints_do_not_accept_connection_fields(field):
    entry = definition().model_dump()
    entry["auth"]["oauth"][field] = "https://auth.example.test/{stack}"
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(entry)


async def test_authorization_preserves_vendor_stack_query(monkeypatch):
    async def endpoints(self):
        return oauth.AuthorizationEndpoints(
            authorization="https://auth.example.test/authorize?grafana_url=https%3A%2F%2Fexample.grafana.net",
            token="https://auth.example.test/token",
            registration=None,
            revocation=None,
            resource="https://mcp.example.test/mcp",
            client_authentication="client_secret_post",
        )

    monkeypatch.setattr(OAuthAdapter, "endpoints", endpoints)
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            definition(),
            StaticClient(
                OAuthClientCredentials("example-client", None, authentication=None)
            ),
            http,
        ).with_fields({"stack": "example.grafana.net"})
        url = await adapter.authorization_url(
            redirect_uri="http://127.0.0.1:12345/callback",
            state="example-state",
            code_challenge="example-challenge",
            scopes=["example:read"],
        )
    query = parse_qs(urlsplit(url).query)
    assert query["grafana_url"] == ["https://example.grafana.net"]
    assert query["response_type"] == ["code"]
    assert query["state"] == ["example-state"]
    assert query["code_challenge_method"] == ["S256"]


async def test_unbound_adapter_does_not_discover_a_template_url():
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            definition(),
            StaticClient(
                OAuthClientCredentials("example-client", None, authentication=None)
            ),
            http,
        )
        with pytest.raises(ServiceAdapterError, match="connection fields"):
            await adapter.endpoints()


async def test_field_free_identity_keeps_vendor_connection_object():
    entry = yaml.safe_load(OAUTH_ENTRY)
    entry["auth"]["identity"] = {
        "url": "https://example.test/me",
        "account_id": "connection.id",
        "label": "connection.name",
    }
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"connection": {"id": "original-id", "name": "Original account"}}
        )
    )
    async with httpx.AsyncClient(transport=transport) as http:
        adapter = OAuthAdapter(
            ConnectionDefinition.model_validate(entry),
            StaticClient(
                OAuthClientCredentials("example-client", None, authentication=None)
            ),
            http,
        )
        result = await adapter.identify("example-access")
    assert result.account_id == "original-id"
    assert result.label == "Original account"
