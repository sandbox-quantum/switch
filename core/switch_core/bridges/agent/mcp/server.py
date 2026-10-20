"""MCP front door onto the agent operations (CHOO-1857 / CHOO-490).

This module owns no operations. It registers every operation from the registry
as an MCP tool and serves them over streamable HTTP at `/mcp`, so the MCP
surface is exactly the operation surface — automatically, with nothing to keep
in step by hand.

Switch hosting an MCP server is the legacy path: the supported direction is a
local runtime that serves the tool surface next to the agent and translates
each call onto its own connection. Because operations live in the registry
rather than here, retiring this door is removing a file, not a refactor.

It holds no session in memory, so any switch-core process can answer any
request of a client's. The MCP transport runs stateless, and `SessionIds`
gives the client a session id of Switch's own on its first request, which the
client sends back on every later one (the transport's `Mcp-Session-Id`). That
id is all an operation needs to find the room the client connected to, and
the binding it names is in Postgres (`operations/context.py`), not here.
"""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING, Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_request
from fastmcp.server.middleware import Middleware, MiddlewareContext
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.bridges.agent.auth import BearerAuthMiddleware, OIDCTokenValidator
from switch_core.bridges.agent.operations import (
    all_operations,
    declared_operations,
    get_operation,
)
from switch_core.bridges.agent.operations.callctx import CallContext, call_context
from switch_core.bridges.agent.operations.context import init_operations_protocol

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_core import AgentCore
    from switch_core.config import SwitchConfig
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.api_key_store import ApiKeyStore

logger = logging.getLogger(__name__)


def init_mcp_protocol(protocol: AgentCore) -> None:
    """Give the operations layer its protocol service.

    Kept under the old name because callers wire it at startup; the state it
    sets now belongs to the operations layer, not to this door.
    """
    init_operations_protocol(protocol)


class CallContextMiddleware(Middleware):
    """Establish who is calling before an operation runs.

    Operations resolve the caller from the call context and nothing else, so
    each front door is responsible for binding it. Here that means the agent
    from the authenticated request scope and the MCP transport session as the
    key that owns the room binding.

    The session id comes from the client (`SessionIds`), so the key is the
    agent's id and the session's together: an agent naming another's session
    id reaches only a binding of its own.
    """

    async def on_call_tool(self, context: MiddlewareContext, call_next):  # type: ignore[no-untyped-def]
        request = get_http_request()
        agent_id = request.scope.get("agent_id")
        if not isinstance(agent_id, str):
            raise ValueError("No agent_id in request — authentication failed")

        fastmcp_context = context.fastmcp_context
        with call_context(
            CallContext(
                agent_id=agent_id,
                session_key=(
                    session_key(agent_id, fastmcp_context.session_id)
                    if fastmcp_context is not None
                    else None
                ),
                # An MCP transport session is not an SDK session: there is no
                # host lease behind it, so it has no fenced room binding of its
                # own and resolves its room from the transport as it always has.
                session=None,
            )
        ):
            return await call_next(context)


def session_key(agent_id: str, session_id: str) -> str:
    """The key an MCP session's room binding is kept under."""
    return f"{agent_id}/{session_id}"


SESSION_HEADER = b"mcp-session-id"


class SessionIds:
    """Give each MCP client a session id that any switch-core process honours.

    The transport runs stateless, so it issues no `Mcp-Session-Id` and checks
    none. A request that arrives without one is given a fresh id here, both on
    the request (where the call context reads it) and on the response, and a
    client following the transport sends it on every later request, whichever
    process those reach. A request that brings one keeps it.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or any(
            name == SESSION_HEADER for name, _ in scope["headers"]
        ):
            await self.app(scope, receive, send)
            return
        minted = uuid.uuid4().hex
        scope = {
            **scope,
            "headers": [*scope["headers"], (SESSION_HEADER, minted.encode())],
        }

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).append("Mcp-Session-Id", minted)
            await send(message)

        await self.app(scope, receive, send_with_id)


class ExistingOperationsOnly(Middleware):
    """Serve only the operations that exist now.

    Every declared operation is registered as a tool, including those of a
    group that is off (an optional module's, enabled when the module runs).
    Which of them exist is the registry's answer at the time of the request,
    so a tool is listed and callable exactly when `/ops` offers it, however
    late in startup its group was enabled.
    """

    async def on_list_tools(self, context: MiddlewareContext, call_next):  # type: ignore[no-untyped-def]
        tools = await call_next(context)
        existing = all_operations()
        return [tool for tool in tools if tool.name in existing]

    async def on_call_tool(self, context: MiddlewareContext, call_next):  # type: ignore[no-untyped-def]
        name = context.message.name
        if get_operation(name) is None:
            raise ToolError(f"Unknown tool: {name}")
        return await call_next(context)


mcp = FastMCP("Switch")
mcp.add_middleware(ExistingOperationsOnly())
mcp.add_middleware(CallContextMiddleware())

# Every declared operation, registered as a tool. This loop is the only thing
# that makes an operation an MCP tool, and `ExistingOperationsOnly` hides the
# ones whose group is off, so the two surfaces cannot diverge.
for _op in declared_operations().values():
    mcp.tool(_op.fn, description=_op.description)

logger.debug("Registered %d operations as MCP tools", len(declared_operations()))


def mcp_http_app() -> Any:
    """The MCP transport, stateless: no session lives in this process, so no
    keepalive ping either, since there is no long-lived stream to keep."""
    return mcp.http_app(path="/", stateless_http=True)


def create_mcp_app(
    *,
    agent_store: AgentStore,
    api_key_store: ApiKeyStore,
    protocol: AgentCore,
    config: SwitchConfig,
) -> tuple[ASGIApp, Any]:
    """Returns (asgi_app, lifespan). The lifespan must be wired into the parent app."""
    init_mcp_protocol(protocol)

    oidc_validator = None
    if config.oauth_issuer_url:
        assert config.oauth_audience is not None  # enforced by SwitchConfig
        oidc_validator = OIDCTokenValidator(
            issuer_url=config.oauth_issuer_url,
            audience=config.oauth_audience,
            verify_issuer=config.oauth_verify_issuer,
        )
        logger.info("OIDC auth enabled for MCP (issuer: %s)", config.oauth_issuer_url)

    starlette_app = mcp_http_app()
    app = BearerAuthMiddleware(
        SessionIds(starlette_app),
        agent_store=agent_store,
        api_key_store=api_key_store,
        api_key_cache=protocol.api_key_cache,
        session_factory=protocol.session_factory,
        oidc_validator=oidc_validator,
    )
    return app, starlette_app.lifespan
