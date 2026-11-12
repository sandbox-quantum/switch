"""The shipped Snowflake entry's key check, against Snowflake's own answers.

The check lists the MCP server's tools, the first call a session makes. The
answers below were recorded from a Snowflake account (names and ids changed):
the tool list for a good token, 401 for a wrong one, and 200 with a JSON-RPC
error for a server that does not exist or that the token's role may not use.
"""

from __future__ import annotations

import json

import httpx
import pytest

from switch_core.connections.adapters import ConnectionNotRevocable
from switch_core.connections.adapters.api_key import ApiKeyAdapter, InvalidKeyError
from switch_core.connections.loader import CATALOG

FIELDS = {
    "account": "exampleorg-example1",
    "database": "SALES",
    "schema": "MCP",
    "server": "ANALYTICS_MCP",
    "pat": "SYNTHETIC-SNOWFLAKE-TOKEN",
}
TOOLS = {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
        "tools": [
            {
                "name": "sql_exec_tool",
                "title": "SQL Execution Tool",
                "description": "Run SQL against the SALES database.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"sql": {"type": "string"}},
                },
                "annotations": {"readOnlyHint": True, "destructiveHint": False},
            }
        ]
    },
}
NO_SERVER = {
    "jsonrpc": "2.0",
    "id": 1,
    "error": {
        "code": -32603,
        "message": "MCP server SALES.MCP.NO_SUCH_SERVER does not exist or not "
        "authorized.\nrequest-id: 00000000-0000-0000-0000-000000000000",
    },
}


class SnowflakeStandIn:
    """Answers the MCP server's URL as Snowflake does."""

    def __init__(self, answer: httpx.Response) -> None:
        self.answer = answer
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answer


def _adapter(snowflake: SnowflakeStandIn) -> ApiKeyAdapter:
    return ApiKeyAdapter(
        CATALOG["snowflake"].definition,
        httpx.AsyncClient(transport=httpx.MockTransport(snowflake)),
    )


async def test_a_good_token_lists_the_servers_tools() -> None:
    snowflake = SnowflakeStandIn(httpx.Response(200, json=TOOLS))

    identity = await _adapter(snowflake).identify(FIELDS)

    # Snowflake names no user here, so the account is the token itself.
    assert len(identity.account_id) == 64
    assert identity.label == (
        "Snowflake key · exampleorg-example1 · SALES · MCP · ANALYTICS_MCP"
    )
    [request] = snowflake.requests
    assert request.method == "POST"
    assert str(request.url) == (
        "https://exampleorg-example1.snowflakecomputing.com/api/v2/databases/SALES"
        "/schemas/MCP/mcp-servers/ANALYTICS_MCP"
    )
    assert request.headers["Authorization"] == "Bearer SYNTHETIC-SNOWFLAKE-TOKEN"
    assert json.loads(request.content) == {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {},
    }


async def test_a_wrong_token_is_refused() -> None:
    snowflake = SnowflakeStandIn(
        httpx.Response(
            401,
            json={"code": "394400", "message": "Programmatic access token is invalid."},
        )
    )
    with pytest.raises(
        InvalidKeyError, match=r"Snowflake refused the key \(HTTP 401\)"
    ):
        await _adapter(snowflake).identify(FIELDS)


async def test_a_server_the_role_cannot_use_is_refused_in_snowflakes_words() -> None:
    snowflake = SnowflakeStandIn(httpx.Response(200, json=NO_SERVER))
    with pytest.raises(InvalidKeyError) as raised:
        await _adapter(snowflake).identify({**FIELDS, "server": "NO_SUCH_SERVER"})
    assert str(raised.value) == (
        "Snowflake did not accept the key and settings: MCP server "
        "SALES.MCP.NO_SUCH_SERVER does not exist or not authorized."
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("account", "exampleorg-example1.us-east-1"),  # a second host label
        ("account", "evil.test/x"),
        ("account", "org_account"),  # Snowflake hosts take hyphens
        ("account", "-exampleorg"),
        ("database", '"Sales DB"'),  # quoted identifiers are not supported
        ("database", ".."),
        ("schema", "MCP/../OTHER"),
        ("server", "1SERVER"),
        ("server", "SERVER$1"),
    ],
)
def test_names_stay_on_snowflakes_host_and_in_their_path_segment(
    field: str, value: str
) -> None:
    snowflake = SnowflakeStandIn(httpx.Response(200, json=TOOLS))
    with pytest.raises(InvalidKeyError, match="not in the form Snowflake uses"):
        _adapter(snowflake).checked_fields({**FIELDS, field: value})
    assert snowflake.requests == []


def test_lowercase_names_are_taken() -> None:
    snowflake = SnowflakeStandIn(httpx.Response(200, json=TOOLS))
    values = _adapter(snowflake).checked_fields(
        {**FIELDS, "database": "sales", "schema": "mcp", "server": "analytics_mcp"}
    )
    assert values["server"] == "analytics_mcp"


async def test_disconnecting_says_only_snowflake_can_revoke_the_token() -> None:
    snowflake = SnowflakeStandIn(httpx.Response(200, json=TOOLS))
    adapter = _adapter(snowflake)
    with pytest.raises(ConnectionNotRevocable, match="Revoke it in Snowflake"):
        await adapter.revoke_connection(adapter.secret(FIELDS), "keys")
    assert snowflake.requests == []
