"""How agents are connected, and why a connection was refused.

The rollout question is which clients are still connecting the old way, so the
connected gauge carries the transport and the client, and the refusals carry a
reason. Both labels come from fixed sets: a client's own string never reaches a
metric.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect

from switch_core.bridges.agent.api import handlers
from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.bridges.agent.dependencies import get_config, get_protocol
from switch_core.bridges.agent.protocol.agent_connections import (
    CONTROLLER_LABEL,
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
    client_label,
)
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.observability.bootstrap import RuntimeProbes, _state_readings
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.transport.room_cache import RoomCacheStats

AGENT_ID = "agent-1"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _counts(registry: MetricsRegistry, name: str) -> dict[tuple, float]:
    payload = next((p for p in registry.collect() if p.name == name), None)
    if payload is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): point.value
        for point in payload.numbers
    }


def _open(
    connections: AgentConnectionRegistry,
    agent_id: str,
    connection_id: str,
    artifact: str | None,
    version: str | None = None,
) -> Any:
    return connections.open(
        agent_id=agent_id,
        connection_id=connection_id,
        scope="all",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(
            speaks=PROTOCOL_VERSION, artifact=artifact, version=version
        ),
        expected_generation=None,
    )


# ── Connected, by transport and client ───────────────────────────────────────


@pytest.mark.parametrize(
    ("artifact", "label"),
    [
        ("agent-runtime", "agent-runtime"),
        ("switch-console", "switch-console"),
        (None, "unknown"),
        ("", "unknown"),
        ("my-homemade-runtime/9.9", "other"),
    ],
)
def test_the_client_label_is_a_registered_name_or_a_bucket(
    artifact: str | None, label: str
) -> None:
    assert client_label(ClientDeclaration(artifact=artifact)) == label


def test_agents_are_counted_per_transport_and_client() -> None:
    connections = AgentConnectionRegistry()
    _open(connections, "a1", "c1", "agent-runtime", version="0.7.2")
    # One agent, two sockets from the same client: still one agent.
    _open(connections, "a1", "c2", "agent-runtime", version="0.7.3")
    _open(connections, "a2", "c3", None)
    _open(connections, "a3", "c4", "something-else")
    detached = _open(connections, "a4", "c5", "agent-runtime")
    connections.detach_stream(detached, detached.stream_generation)

    assert connections.live_agents_by_transport() == {
        ("websocket", "agent-runtime"): 1,
        ("websocket", "unknown"): 1,
        ("websocket", "other"): 1,
        ("detached", "agent-runtime"): 1,
    }


def test_agents_run_by_a_live_controller_count_under_the_controller() -> None:
    connections = AgentConnectionRegistry()
    _open(connections, "a1", "c1", "agent-runtime")
    controllers = connections.controllers
    for agent_id in ("m1", "m2"):
        controllers.bind(
            Binding(
                agent_id=agent_id,
                controller_id="ctl",
                tenant_id="t",
                controller_name="the machine",
                running=True,
            )
        )
    conn = controllers.open(controller_id="ctl", tenant_id="t", resume_cursors={})
    controllers.attach_stream(conn)

    assert connections.live_agents_by_transport() == {
        ("websocket", "agent-runtime"): 1,
        CONTROLLER_LABEL: 2,
    }


def test_an_agent_connected_two_ways_counts_under_each() -> None:
    connections = AgentConnectionRegistry()
    _open(connections, "a1", "c1", "agent-runtime")
    _open(connections, "a1", "c2", None)

    assert connections.live_agents_by_transport() == {
        ("websocket", "agent-runtime"): 1,
        ("websocket", "unknown"): 1,
    }


def _probes(agents_connected: Any) -> RuntimeProbes:
    return RuntimeProbes(
        listener_connected=lambda: True,
        session_activity_listener_connected=lambda: True,
        bridges_running=lambda: 0,
        bridges_running_by_platform=lambda: {},
        bridges_configured=lambda: 0,
        consumers_running=lambda: 0,
        connectors_running=lambda: 0,
        connectors_configured=lambda: 0,
        agents_connected=agents_connected,
        pool_stats=lambda: None,
        room_cache_stats=lambda: RoomCacheStats(bytes=0, rooms=0, rows=0),
    )


def _connected_readings(probes: RuntimeProbes) -> dict[tuple, float]:
    return {
        tuple(sorted(reading.attributes.items())): reading.value
        for reading in _state_readings(probes)()
        if reading.spec.name == "switch.agents.connected"
    }


def test_the_gauge_carries_transport_and_client_but_never_the_version() -> None:
    connections = AgentConnectionRegistry()
    _open(connections, "a1", "c1", "agent-runtime", version="0.7.2")
    _open(connections, "a2", "c2", "agent-runtime", version="0.0.1-dirty")

    readings = _connected_readings(_probes(connections.live_agents_by_transport))

    # The zero baseline is always there; no series carries a version.
    assert readings == {
        (("client", "agent-runtime"), ("transport", "websocket")): 2.0,
        (("client", "unknown"), ("transport", "websocket")): 0.0,
    }


def test_the_gauge_still_reports_zero_with_nobody_connected() -> None:
    """A panel over no series reads "no data", which is not the same as none."""
    readings = _connected_readings(_probes(lambda: {}))

    assert list(readings.values()) == [0.0]


# ── Refused ──────────────────────────────────────────────────────────────────


async def test_a_request_for_the_old_event_stream_is_counted(registry) -> None:
    with pytest.raises(HTTPException):
        await handlers.poll_events(
            agent_id=AGENT_ID,
            agent=Agent(id=AGENT_ID, name="agent"),
            protocol=None,  # type: ignore[arg-type]
            accept="text/event-stream",
        )

    assert _counts(registry, "switch.agent.connections_refused") == {
        (("reason", "transport_removed"),): 1.0
    }


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer(sequence_base=0)
        self.connections = AgentConnectionRegistry()
        self.approval_outcomes = None
        self.sessions = SessionReporter(None)

    async def record_client_declaration(self, *args: Any) -> None:
        return None

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None


class _AuthenticatedAs:
    def __init__(self, app: ASGIApp, agent: Agent) -> None:
        self.app = app
        self.agent = agent

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope["agent"] = self.agent
        await self.app(scope, receive, send)


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(handlers.router, prefix="/agents")
    protocol = _Protocol()
    app.dependency_overrides[get_protocol] = lambda: protocol
    app.dependency_overrides[get_config] = lambda: None
    agent = Agent(id=AGENT_ID, name="agent")
    with TestClient(_AuthenticatedAs(app, agent)) as client:  # type: ignore[arg-type]
        yield client


def _refused_on_socket(client: TestClient, query: str) -> int:
    with client.websocket_connect(f"/agents/{AGENT_ID}/connection/ws?{query}") as ws:
        assert ws.receive_json()["event"] == "refused"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    return closed.value.code


def test_a_protocol_mismatch_on_the_socket_is_counted_as_protocol(
    registry, client: TestClient
) -> None:
    code = _refused_on_socket(
        client, f"connection_id=c1&protocol={PROTOCOL_VERSION + 1}"
    )

    assert code == 4409
    assert _counts(registry, "switch.agent.connections_refused") == {
        (("reason", "protocol"),): 1.0
    }


def test_any_other_refusal_on_the_socket_is_counted_as_other(
    registry, client: TestClient
) -> None:
    code = _refused_on_socket(client, "connection_id=c1&scope=everywhere")

    assert code == 4400
    assert _counts(registry, "switch.agent.connections_refused") == {
        (("reason", "other"),): 1.0
    }


async def _unauthenticated_socket(path: str) -> None:
    async def app(scope: Any, receive: Any, send: Any) -> None:
        raise AssertionError("an unauthenticated socket reached the app")

    middleware = BearerAuthMiddleware(
        app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=None,  # type: ignore[arg-type]
    )
    inbox = [{"type": "websocket.connect"}]

    async def receive() -> dict:
        return inbox.pop(0)

    async def send(message: dict) -> None:
        return None

    await middleware(
        {"type": "websocket", "path": path, "headers": [], "query_string": b""},
        receive,
        send,
    )


async def test_an_unauthenticated_connection_socket_is_counted(registry) -> None:
    await _unauthenticated_socket(f"/agents/{AGENT_ID}/connection/ws")

    assert _counts(registry, "switch.agent.connections_refused") == {
        (("reason", "unauthorized"),): 1.0
    }


async def test_an_unauthenticated_socket_elsewhere_is_not(registry) -> None:
    await _unauthenticated_socket("/mcp")

    assert _counts(registry, "switch.agent.connections_refused") == {}
