"""BearerAuthMiddleware's log-context restore on the agent-authenticated path.

Mirrors `test_logging_context.py`'s finalisation case for the raw
`bind_log_context`/`unbind_log_context` pair the middleware used to carry in a
`try`/`finally`: a downstream app coroutine dropped while suspended and
finalised by the garbage collector runs its `finally` in whatever context the
collector happens to be in, not the one the token was bound in.

The agent token is resolved from the in-memory `ApiKeyCache` rather than a
database lookup, so the only suspension point left in the middleware's
coroutine is the downstream app — the one this test needs to control.
"""

from __future__ import annotations

import contextvars
import hashlib
from collections.abc import Coroutine, Generator
from typing import Any

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.models import Agent, ApiKey
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.logging_context import current_log_context, log_context

TOKEN = "agent-token"
AGENT_ID = "agent-1"


class _Suspend:
    """An await that suspends once, so a coroutine can be left mid-scope with
    no event loop in sight."""

    def __await__(self) -> Generator[None, None, None]:
        yield


def _drive_then_finalise_elsewhere(coro: Coroutine[Any, Any, None]) -> None:
    """Enter the scope inside its own context, then close from this one —
    what the garbage collector does to a coroutine dropped while suspended."""
    contextvars.copy_context().run(coro.send, None)
    coro.close()


def _middleware() -> tuple[BearerAuthMiddleware, dict]:
    called: dict[str, Any] = {}

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        called["scope"] = scope
        await _Suspend()

    cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
    cache.put(
        hashlib.sha256(TOKEN.encode()).hexdigest(),
        ApiKey(
            id="key-1",
            user_id="user-1",
            key_hash="unused",
            encrypted_key="enc",
            label="k",
            type="agent",
        ),
        Agent(
            id=AGENT_ID,
            name="agent",
            description="",
            agent_type="always_on",
            connector_type="claude_code",
            integration_profile={},
            client_id="client-1",
            api_key_id="key-1",
        ),
    )

    async def _never(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the cache hit should have made a DB lookup unnecessary")

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=cache,
        session_factory=_never,  # type: ignore[arg-type]
    )
    return mw, called


async def test_the_agent_log_context_survives_being_closed_from_another_context() -> (
    None
):
    mw, called = _middleware()

    async def receive() -> dict:
        return {"type": "http.request"}

    async def send(message: dict) -> None:
        return None

    scope = {
        "type": "http",
        "path": "/agents",
        "headers": [(b"authorization", f"Bearer {TOKEN}".encode())],
    }

    with log_context(request_id="caller"):
        _drive_then_finalise_elsewhere(mw(scope, receive, send))
        assert called["scope"]["agent_id"] == AGENT_ID, (
            "middleware never reached the app"
        )
        assert current_log_context().request_id == "caller", (
            "finalising a dropped downstream coroutine leaked the agent's log "
            "context into the collector's context"
        )
