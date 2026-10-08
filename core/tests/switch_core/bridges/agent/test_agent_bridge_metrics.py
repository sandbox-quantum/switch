"""The agent bridge reports the same `switch.bridge.*` metrics as a collaboration
bridge, tagged `bridge=agent`, and tags its log lines the same way.

Every agent operation goes through `call_operation`, so that is where an event
in is counted and a call is timed, and where a failure is counted before it is
raised again.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent import app as agent_app
from switch_core.bridges.agent.api import operations
from switch_core.logging_context import current_log_context
from switch_core.observability.metrics import MetricsRegistry, install, uninstall


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _collect(registry: MetricsRegistry) -> dict[str, list[dict[str, Any]]]:
    """Every point this interval, by metric name. One call: collecting resets."""
    return {
        payload.name: [
            dict(point.attributes) for point in [*payload.numbers, *payload.histograms]
        ]
        for payload in registry.collect()
    }


def _operation(fn: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        operations, "get_operation", lambda name: SimpleNamespace(fn=fn)
    )


async def _call(name: str) -> Any:
    return await operations.call_operation(
        operation=name,
        arguments={},
        agent_id="agent-1",
        connection_id=None,
        session=None,
    )


async def test_an_operation_is_an_event_in_and_a_timed_call(
    registry: MetricsRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def ok() -> str:
        return "done"

    _operation(ok, monkeypatch)

    assert await _call("post_message") == "done"

    points = _collect(registry)
    assert points["switch.bridge.events_in"] == [
        {"bridge": "agent", "platform": "switch", "event": "post_message"}
    ]
    assert "switch.bridge.call.duration" in points
    assert "switch.bridge.errors" not in points


async def test_a_failing_operation_is_counted_and_still_raises(
    registry: MetricsRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom() -> None:
        raise ValueError("no such room")

    _operation(boom, monkeypatch)

    with pytest.raises(ValueError, match="no such room"):
        await _call("post_message")

    points = _collect(registry)
    assert points["switch.bridge.errors"] == [
        {"bridge": "agent", "platform": "switch", "direction": "inbound"}
    ]


@pytest.mark.parametrize(
    ("path", "bridge"),
    [
        ("/agents/agent-1/events", "agent"),
        ("/mcp/", "agent"),
        ("/gateway/rooms", None),
        ("/health", None),
    ],
)
async def test_only_agent_paths_are_tagged_as_the_agent_bridge(
    path: str, bridge: str | None
) -> None:
    seen: list[str | None] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        seen.append(current_log_context().bridge)

    middleware = agent_app.AgentBridgeLogContextMiddleware(inner)
    await middleware({"type": "http", "path": path}, None, None)  # type: ignore[arg-type]

    assert seen == [bridge]
    assert current_log_context().bridge is None
