"""The shipped Monday entry uses different GraphQL and MCP auth headers."""

import json

import httpx
import pytest

from switch_core.connections.adapters.api_key import (
    ApiKeyAdapter,
    InvalidKeyError,
    render,
)
from switch_core.connections.loader import CATALOG


async def test_monday_identity_and_mcp_use_the_documented_headers():
    definition = CATALOG["monday"].definition
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(
            200, json={"data": {"me": {"id": 42, "name": "Example User"}}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        adapter = ApiKeyAdapter(definition, http)
        values = adapter.checked_fields({"api_key": "SYNTHETIC-PERSONAL-TOKEN"})
        identity = await adapter.identify(values)
        assert (identity.account_id, identity.label) == ("42", "Example User")
        assert adapter.can_issue is False
        [request] = seen
        assert request.method == "POST"
        assert str(request.url) == "https://api.monday.com/v2"
        assert request.headers["Authorization"] == values["api_key"]
        assert json.loads(request.content) == {"query": "query { me { id name } }"}
        assert definition.mcp is not None
        [server] = definition.mcp.servers
        assert server.name == "monday"
        assert server.url == "https://mcp.monday.com/mcp"
        assert (
            render(server.headers["Authorization"], values)
            == "Bearer SYNTHETIC-PERSONAL-TOKEN"
        )


@pytest.mark.parametrize(
    "body", [{"errors": [{"message": "refused"}]}, {"data": {"me": None}}]
)
async def test_graphql_errors_do_not_establish_a_connection(body):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))
    ) as http:
        adapter = ApiKeyAdapter(CATALOG["monday"].definition, http)
        with pytest.raises(InvalidKeyError, match="did not name"):
            await adapter.identify({"api_key": "SYNTHETIC-PERSONAL-TOKEN"})
