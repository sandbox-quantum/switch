"""Wiring: what actually starts, what it reports, and what it does when off."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.config import SwitchConfig
from switch_core.observability.bootstrap import RuntimeProbes, start_observability
from switch_core.observability.metrics import metrics, uninstall
from switch_core.observability.pool import PoolStats
from switch_core.transport.room_cache import RoomCacheStats

BASE_ENV = {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_USER": "postgres",
    "DB_PASSWORD": "secret",
    "DB_NAME": "switch",
    "MATRIX_SERVER_NAME": "switch.local",
    "AGENT_REGISTRATION_TOKEN": "token",
    "SECRET_KEYS": "test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "GATEWAY_ADMIN_EMAIL": "admin@example.com",
    "GATEWAY_ADMIN_PASSWORD": "pw",
}

DEPLOYMENT_ID = "0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10"

OBSERVABILITY_KEYS = (
    "OTLP_ENDPOINT",
    "OTLP_METRICS_ENABLED",
    "OTLP_LOGS_ENABLED",
    "OTLP_HEADERS",
    "OTLP_TIMEOUT_SECONDS",
    "OTLP_EXPORT_INTERVAL_SECONDS",
    "DEPLOYMENT_ID",
)


def _config(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> SwitchConfig:
    for key in (*BASE_ENV, *OBSERVABILITY_KEYS):
        monkeypatch.delenv(key, raising=False)
    for key, value in {**BASE_ENV, **overrides}.items():
        monkeypatch.setenv(key.upper(), value)
    return SwitchConfig()  # type: ignore[call-arg]


class _FakeSession:
    def __init__(self, fail: bool) -> None:
        self._fail = fail

    async def execute(self, statement: object) -> None:
        if self._fail:
            raise ConnectionRefusedError("the database is not there")


def _session_factory(fail: bool = False):
    @asynccontextmanager
    async def factory():
        yield _FakeSession(fail)

    return factory


def _probes(**overrides) -> RuntimeProbes:
    defaults = dict(
        listener_connected=lambda: True,
        session_activity_listener_connected=lambda: True,
        bridges_running=lambda: 2,
        bridges_running_by_platform=lambda: {"slack": 1, "mattermost": 1},
        bridges_configured=lambda: 2,
        consumers_running=lambda: 5,
        connectors_running=lambda: 2,
        connectors_configured=lambda: 2,
        agents_connected=lambda: {
            ("websocket", "agent-runtime"): 2,
            ("websocket", "unknown"): 1,
        },
        pool_stats=lambda: PoolStats(in_use=4, size=30, overflow=0),
        room_cache_stats=lambda: RoomCacheStats(bytes=0, rooms=0, rows=0),
    )
    return RuntimeProbes(**{**defaults, **overrides})


@pytest.fixture(autouse=True)
def _clean_registry():
    yield
    uninstall()


@pytest.mark.asyncio
async def test_health_runs_even_with_nothing_configured(monkeypatch):
    """Readiness is how Kubernetes routes traffic; it cannot be opt-in."""
    observability = start_observability(
        config=_config(monkeypatch),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(),
    )
    try:
        report = await observability.monitor.refresh()
        assert report.ready is True
        # ...but nothing is being reported anywhere.
        assert metrics().enabled is False
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_a_dead_database_fails_readiness(monkeypatch):
    observability = start_observability(
        config=_config(monkeypatch),
        version="1.0.0",
        session_factory=_session_factory(fail=True),
        probes=_probes(),
    )
    try:
        report = await observability.monitor.refresh()
        assert report.ready is False
        assert "ConnectionRefusedError" in str(report.as_response())
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_a_crashed_bridge_is_reported_without_taking_the_server_down(
    monkeypatch,
):
    observability = start_observability(
        config=_config(monkeypatch),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(bridges_running=lambda: 1, bridges_configured=lambda: 3),
    )
    try:
        report = await observability.monitor.refresh()
        # Single replica: failing readiness here would turn one dead adapter
        # into a total outage.
        assert report.ready is True
        assert report.as_response()["checks"]["bridges"]["healthy"] is False
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_an_endpoint_installs_the_registry_and_reports_state(monkeypatch):
    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="3600",
        ),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(),
    )
    try:
        await observability.monitor.refresh()
        payloads = {p.name: p for p in metrics().collect()}

        assert metrics().enabled is True
        values = {
            name: payload.numbers[0].value
            for name, payload in payloads.items()
            if payload.numbers and not payload.numbers[0].attributes
        }
        connected = {
            (point.attributes["transport"], point.attributes["client"]): point.value
            for point in payloads["switch.agents.connected"].numbers
        }
        assert connected == {
            ("websocket", "agent-runtime"): 2.0,
            ("websocket", "unknown"): 1.0,
        }
        assert values["switch.consumers.running"] == 5.0
        assert values["switch.connectors.running"] == 2.0
        assert values["switch.db.pool.in_use"] == 4.0
        assert values["switch.db.pool.size"] == 30.0

        # Bridges are reported per platform, so there is no unattributed
        # series to pick up above. Which platform is down is the first thing
        # anyone asks, and a bare total cannot answer it.
        running = {
            point.attributes["platform"]: point.value
            for point in payloads["switch.bridges.running"].numbers
        }
        assert running == {"slack": 1.0, "mattermost": 1.0}
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_the_room_cache_reports_what_it_holds(monkeypatch):
    config = _config(
        monkeypatch,
        OTLP_ENDPOINT="https://collector.example",
        DEPLOYMENT_ID=DEPLOYMENT_ID,
        OTLP_EXPORT_INTERVAL_SECONDS="3600",
    )
    observability = start_observability(
        config=config,
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(
            room_cache_stats=lambda: RoomCacheStats(bytes=4096, rooms=3, rows=12)
        ),
    )
    try:
        payloads = {p.name: p for p in metrics().collect()}
        assert payloads["switch.delivery_cache.bytes"].numbers[0].value == 4096.0
        assert payloads["switch.delivery_cache.rooms"].numbers[0].value == 3.0
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_a_start_is_counted_once_so_restarts_line_up(monkeypatch):
    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="3600",
        ),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(),
    )
    try:
        starts = next(
            p for p in metrics().collect() if p.name == "switch.runtime.starts"
        )
        assert [point.value for point in starts.numbers] == [1.0]
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_a_pool_that_reports_nothing_produces_no_reading(monkeypatch):
    """A zero would draw an idle pool; absence draws nothing, which is true."""
    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="3600",
        ),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(pool_stats=lambda: None),
    )
    try:
        names = {p.name for p in metrics().collect()}
        assert "switch.db.pool.in_use" not in names
        assert "switch.agents.connected" in names
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_metrics_reach_the_collector(monkeypatch):
    """End to end: a recorded measurement becomes a posted OTLP payload."""
    posted: list[dict] = []

    async def fake_post(self, signal: str, payload: dict) -> None:
        posted.append({"signal": signal, "payload": payload})

    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="0.05",
        ),
        version="9.9.9",
        session_factory=_session_factory(),
        probes=_probes(),
    )
    try:
        monkeypatch.setattr("switch_core.observability.otlp.OtlpClient.post", fake_post)
        await asyncio.sleep(0.2)
    finally:
        await observability.aclose()

    assert posted, "the exporter never posted anything"
    assert posted[0]["signal"] == "metrics"
    body = posted[0]["payload"]
    # It has to survive serialisation, and it has to name the deployment.
    json.dumps(body)
    attributes = {
        entry["key"]: entry["value"]
        for entry in body["resourceMetrics"][0]["resource"]["attributes"]
    }
    assert attributes["flint.client_id"] == {"stringValue": DEPLOYMENT_ID}
    assert attributes["service.version"] == {"stringValue": "9.9.9"}


@pytest.mark.asyncio
async def test_closing_stops_the_loops_and_uninstalls(monkeypatch):
    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="3600",
        ),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(),
    )
    monkeypatch.setattr(
        "switch_core.observability.otlp.OtlpClient.post",
        lambda self, signal, payload: asyncio.sleep(0),
    )
    await observability.aclose()

    assert metrics().enabled is False
    assert all(task.done() for task in observability._tasks)


@pytest.mark.asyncio
async def test_the_database_sampler_starts_with_the_metrics_exporter(monkeypatch):
    built: list[object] = []

    def engine():
        built.append(object())
        return create_async_engine(
            "postgresql+asyncpg://u:p@127.0.0.1:1/x", poolclass=NullPool
        )

    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="3600",
        ),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(),
        db_server_engine=engine,
    )
    try:
        await asyncio.sleep(0.05)
        names = {task.get_name() for task in observability._tasks}
        assert "db-server-sampler" in names
        assert built, "the sampler never built its engine"
    finally:
        await observability.aclose()


@pytest.mark.asyncio
async def test_a_connection_kind_that_empties_out_is_reported_as_zero(monkeypatch):
    """Otherwise the dashboard keeps drawing its last count, which is exactly
    the line that has to reach zero before an old transport can be removed."""
    connected = {("websocket", "agent-runtime"): 2, ("detached", "agent-runtime"): 1}
    observability = start_observability(
        config=_config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_EXPORT_INTERVAL_SECONDS="3600",
        ),
        version="1.0.0",
        session_factory=_session_factory(),
        probes=_probes(agents_connected=lambda: dict(connected)),
    )
    try:

        def reading() -> dict[tuple[str, str], float]:
            payload = {p.name: p for p in metrics().collect()}[
                "switch.agents.connected"
            ]
            return {
                (n.attributes["transport"], n.attributes["client"]): n.value
                for n in payload.numbers
            }

        assert reading()[("detached", "agent-runtime")] == 1.0
        del connected[("detached", "agent-runtime")]
        assert reading() == {
            ("websocket", "agent-runtime"): 2.0,
            ("detached", "agent-runtime"): 0.0,
            ("websocket", "unknown"): 0.0,
        }
    finally:
        await observability.aclose()
