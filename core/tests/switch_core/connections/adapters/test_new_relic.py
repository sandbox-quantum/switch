"""Exercise the shipped New Relic configuration against its HTTP contracts."""

import json

import httpx
import pytest

from switch_core.connections.adapters.api_key import (
    ApiKeyAdapter,
    InvalidKeyError,
    render,
)
from switch_core.connections.loader import CATALOG


@pytest.mark.parametrize(
    "region", ["newrelic.com", "eu.newrelic.com", "jp.newrelic.com"]
)
async def test_regional_identity_and_mcp_headers(region):
    definition = CATALOG["new-relic"].definition
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "data": {"actor": {"user": {"id": 42, "email": "user@example.test"}}}
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        adapter = ApiKeyAdapter(definition, http)
        values = adapter.checked_fields(
            {"api_key": "SYNTHETIC-USER-KEY", "region": region}
        )
        identity = await adapter.identify(values)
        assert (identity.account_id, identity.label) == ("42", "user@example.test")
        assert adapter.can_issue is False
        [request] = seen
        assert str(request.url) == f"https://api.{region}/graphql"
        assert request.method == "POST"
        assert request.headers["API-Key"] == values["api_key"]
        assert json.loads(request.content) == {
            "query": "{ actor { user { id email } } }"
        }
        assert definition.mcp is not None
        [server] = definition.mcp.servers
        assert render(server.url, values) == f"https://mcp.{region}/mcp/"
        assert {
            name: render(value, values) for name, value in server.headers.items()
        } == {"api-key": values["api_key"]}
        assert definition.access is None
        assert definition.token is not None and definition.token.max_lifetime is None


@pytest.mark.parametrize(
    "body", [{"errors": [{"message": "refused"}]}, {"data": {"actor": {"user": None}}}]
)
async def test_graphql_refusal_cannot_create_a_connection(body):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))
    ) as http:
        adapter = ApiKeyAdapter(CATALOG["new-relic"].definition, http)
        with pytest.raises(InvalidKeyError, match="did not name"):
            await adapter.identify(
                {"api_key": "SYNTHETIC-USER-KEY", "region": "newrelic.com"}
            )


def test_region_cannot_redirect_credentials_to_an_arbitrary_host():
    adapter = ApiKeyAdapter(CATALOG["new-relic"].definition, httpx.AsyncClient())
    with pytest.raises(InvalidKeyError, match="must be one of"):
        adapter.checked_fields(
            {"api_key": "SYNTHETIC-USER-KEY", "region": "example.test"}
        )
