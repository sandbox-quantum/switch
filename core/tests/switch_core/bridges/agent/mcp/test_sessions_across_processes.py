"""The MCP door holds no session in memory, so a client that initialized on
one switch-core process carries on through another.

Two transports stand in for two processes: each is its own stateless
`http_app`, with nothing shared between them but the client's session id.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import httpx
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.bridges.agent.mcp import server as mcp_server

AGENT = "agent-1"
HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
}
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0"},
    },
}


def _as_agent(app: ASGIApp) -> ASGIApp:
    """What the bearer middleware leaves on the scope of an agent's request."""

    async def wrapped(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            scope = {**scope, "agent_id": AGENT}
        await app(scope, receive, send)

    return wrapped


@asynccontextmanager
async def _process() -> AsyncIterator[httpx.AsyncClient]:
    starlette_app: Any = mcp_server.mcp_http_app()
    async with (
        starlette_app.router.lifespan_context(starlette_app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(
                app=_as_agent(mcp_server.SessionIds(starlette_app))
            ),
            base_url="http://switch.test",
        ) as client,
    ):
        yield client


async def test_a_session_started_on_one_process_goes_on_on_another() -> None:
    async with AsyncExitStack() as stack:
        first = await stack.enter_async_context(_process())
        second = await stack.enter_async_context(_process())

        initialized = await first.post("/", json=INITIALIZE, headers=HEADERS)
        assert initialized.status_code == 200, initialized.text
        session_id = initialized.headers["mcp-session-id"]

        listed = await second.post(
            "/",
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            headers={**HEADERS, "mcp-session-id": session_id},
        )
        assert listed.status_code == 200, listed.text
        # A session id the other process never issued is not refused, and is
        # not replaced: the client keeps the one it has.
        assert "mcp-session-id" not in listed.headers


def test_the_binding_key_belongs_to_the_agent() -> None:
    """A session id comes from the client; the agent's own id comes from its
    credential. Together they keep one agent off another's room binding."""
    assert mcp_server.session_key("agent-1", "s") != mcp_server.session_key(
        "agent-2", "s"
    )
