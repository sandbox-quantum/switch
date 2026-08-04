"""MCP front door onto the agent operations (CHOO-1857 / CHOO-490).

This module owns no operations. It registers every operation from the registry
as an MCP tool and serves them over streamable HTTP at `/mcp`, so the MCP
surface is exactly the operation surface — automatically, with nothing to keep
in step by hand.

Switch hosting an MCP server is the legacy path: the supported direction is a
local runtime that serves the tool surface next to the agent and translates
each call onto its own connection. Because operations live in the registry
rather than here, retiring this door is removing a file, not a refactor.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_request
from fastmcp.server.middleware import Middleware, MiddlewareContext, PingMiddleware
from starlette.types import ASGIApp

from switch_core.bridges.agent.auth import BearerAuthMiddleware, OIDCTokenValidator
from switch_core.bridges.agent.operations import all_operations
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.context import init_operations_protocol

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.service import ProtocolService
    from switch_core.config import SwitchConfig
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.api_key_store import ApiKeyStore

logger = logging.getLogger(__name__)


def init_mcp_protocol(protocol: ProtocolService) -> None:
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
    """

    async def on_call_tool(self, context: MiddlewareContext, call_next):  # type: ignore[no-untyped-def]
        request = get_http_request()
        agent_id = request.scope.get("agent_id")
        if not isinstance(agent_id, str):
            raise ValueError("No agent_id in request — authentication failed")

        fastmcp_context = context.fastmcp_context
        token = set_call_context(
            CallContext(
                agent_id=agent_id,
                session_key=(
                    fastmcp_context.session_id if fastmcp_context is not None else None
                ),
            )
        )
        try:
            return await call_next(context)
        finally:
            reset_call_context(token)


mcp = FastMCP("Switch")
mcp.add_middleware(CallContextMiddleware())

# Every operation, registered as a tool. This loop is the only thing that makes
# an operation an MCP tool, so the two surfaces cannot diverge.
for _op in all_operations().values():
    mcp.tool(_op.fn)

logger.debug("Registered %d operations as MCP tools", len(all_operations()))


def create_mcp_app(
    *,
    agent_store: AgentStore,
    api_key_store: ApiKeyStore,
    protocol: ProtocolService,
    config: SwitchConfig,
) -> tuple[ASGIApp, Any]:
    """Returns (asgi_app, lifespan). The lifespan must be wired into the parent app."""
    init_mcp_protocol(protocol)

    mcp.add_middleware(PingMiddleware(interval_ms=30000))

    oidc_validator = None
    if config.oauth_issuer_url:
        oidc_validator = OIDCTokenValidator(
            issuer_url=config.oauth_issuer_url,
            audience=config.oauth_audience,
            verify_issuer=config.oauth_verify_issuer,
        )
        logger.info("OIDC auth enabled for MCP (issuer: %s)", config.oauth_issuer_url)

    starlette_app = mcp.http_app(path="/")
    app = BearerAuthMiddleware(
        starlette_app,
        agent_store=agent_store,
        api_key_store=api_key_store,
        session_factory=protocol.session_factory,
        oidc_validator=oidc_validator,
    )
    return app, starlette_app.lifespan
