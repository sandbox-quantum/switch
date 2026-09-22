"""The defects a third review found after 487 was merged with 491.

Each is the same shape: something that fails silently. A misdirected endpoint
that 404s once per event into a log nobody reads, an identity the relay drops
with a 200, a once-ever claim spent while nothing is listening, and a session
that ends with no event because the path that closed it was not one of the
three that reported.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api import session_reporter
from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord

VALID_UUID = "11111111-1111-1111-1111-111111111111"


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _config(**overrides: object) -> object:
    """A SwitchConfig with only what the validators need, plus overrides."""
    from switch_core.config import SwitchConfig

    base = {
        "db_host": "h",
        "db_port": "5432",
        "db_user": "u",
        "db_password": "p",
        "db_name": "d",
        "matrix_server_name": "test",
        "agent_registration_token": "t",
        "jwt_secret_key": "k",
        "gateway_admin_email": "a@b.test",
        "gateway_admin_password": "pw",
    }
    base.update(overrides)  # type: ignore[arg-type]
    return SwitchConfig(**base)  # type: ignore[arg-type]


class TestTheEndpointIsABaseUrl:
    """It changed meaning in the merge — the signal path is appended now — and
    the full logs URL is the form most people have seen written down."""

    def test_a_full_signal_url_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no path of its own"):
            _config(
                telemetry_enabled=True,
                telemetry_endpoint="https://telemetry.flintai.dev/v1/logs",
            )

    def test_whitespace_is_refused(self) -> None:
        """`urlsplit` puts a trailing space inside the host, so every other
        check passes and the failure names a connection problem instead."""
        with pytest.raises(ValueError, match="whitespace"):
            _config(
                telemetry_enabled=True,
                telemetry_endpoint="https://telemetry.flintai.dev ",
            )

    def test_a_query_string_is_refused(self) -> None:
        with pytest.raises(ValueError, match="query or"):
            _config(
                telemetry_enabled=True,
                telemetry_endpoint="https://relay.example?token=x",
            )

    def test_a_bare_base_url_is_accepted(self) -> None:
        _config(telemetry_enabled=True, telemetry_endpoint="https://relay.example")

    def test_the_shipped_default_is_valid(self) -> None:
        """The check is worth nothing if the value everyone gets fails it."""
        _config(telemetry_enabled=True)


class TestTheDeploymentIdIsCheckedWhereverItIsSet:
    """Both streams use it now, so the shape check cannot live only on the
    collector's validator — the relay drops a non-UUID with a 200."""

    def test_a_malformed_id_is_refused_with_no_collector(self) -> None:
        with pytest.raises(ValueError, match="must be a UUID"):
            _config(telemetry_enabled=True, deployment_id="acme-prod")

    def test_a_malformed_id_is_refused_even_with_telemetry_off(self) -> None:
        """It is wrong whenever it is set; nothing is gained by waiting until
        it is used."""
        with pytest.raises(ValueError, match="must be a UUID"):
            _config(deployment_id="acme-prod")

    def test_a_uuid_is_accepted(self) -> None:
        _config(telemetry_enabled=True, deployment_id=VALID_UUID)

    def test_an_unset_id_is_fine(self) -> None:
        """The database supplies one; the env var is an override."""
        _config(telemetry_enabled=True)


class TestASessionIsTheAgentNotTheConnection:
    """What filled the first real dashboard, and why.

    Two ordinary things make an agent hold a succession of short connections
    while being, to anyone watching the product, continuously present: a stream
    rejected at the room claim and retried, and a stream whose heartbeat lapsed
    (the TTL is six seconds) closing itself so the client reopens. Reported per
    connection, both are a storm of session pairs seconds apart. Reported per
    agent, neither is a session at all.
    """

    def _reporter(
        self, sink: _RecordingSink, registry: ConnectionRegistry
    ) -> SessionReporter:
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id=VALID_UUID,
            service_name="switch-core",
            version="1.0.0",
            environment=None,
        )
        reporter = SessionReporter(service, registry)
        registry.set_close_listener(reporter.on_close)
        return reporter

    def _open(self, registry: ConnectionRegistry, agent: str = "agent-1") -> str:
        connection_id = uuid.uuid4().hex
        registry.open(
            agent_id=agent,
            connection_id=connection_id,
            scope="all",
            delivery_filter="all",
            spawn_capable=False,
            cursor=0,
            declaration=ClientDeclaration(),
        )
        return connection_id

    async def _stream(
        self, reporter: SessionReporter, registry: ConnectionRegistry, cid: str
    ) -> None:
        conn = registry.get(cid)
        assert conn is not None
        await reporter.started(
            SimpleNamespace(metadata_={"known_agent_type": "codex"}),  # type: ignore[arg-type]
            conn,
        )

    def _names(self, sink: _RecordingSink) -> list[str]:
        return [r.name.removeprefix("switch_core.") for r in sink.sent]

    async def test_a_rejected_stream_reports_nothing(self) -> None:
        """No stream was handed back, so no session began."""
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        self._reporter(sink, registry)

        cid = self._open(registry)
        registry.close(cid, "room already claimed")
        await _settle()

        assert sink.sent == []

    async def test_twenty_rejected_attempts_report_nothing(self) -> None:
        """The retry loop, as the dashboard actually saw it."""
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        self._reporter(sink, registry)

        for _ in range(20):
            cid = self._open(registry)
            registry.close(cid, "room already claimed")
        await _settle()

        assert sink.sent == []

    async def test_a_reconnect_within_the_grace_continues_the_session(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The heartbeat-lapse loop: one session, not one per six seconds."""
        monkeypatch.setattr(session_reporter, "_RECONNECT_GRACE_SECONDS", 0.05)
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        for _ in range(5):
            cid = self._open(registry)
            await self._stream(reporter, registry, cid)
            registry.close(cid, "heartbeat lapsed")
            await asyncio.sleep(0.01)  # well inside the grace period
        await _settle()

        assert self._names(sink) == ["agent_session_started"]

    async def test_the_session_ends_once_the_agent_stays_away(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(session_reporter, "_RECONNECT_GRACE_SECONDS", 0.05)
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        cid = self._open(registry)
        await self._stream(reporter, registry, cid)
        registry.close(cid, "heartbeat lapsed")
        await asyncio.sleep(0.15)
        await _settle()

        assert self._names(sink) == ["agent_session_started", "agent_session_ended"]
        assert sink.sent[1].properties["reason"] == "heartbeat_lapsed"

    async def test_the_duration_spans_the_whole_session(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Not the last connection's lifetime — the span the agent was present,
        across however many reconnects it took."""
        monkeypatch.setattr(session_reporter, "_RECONNECT_GRACE_SECONDS", 0.05)
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        cid = self._open(registry)
        await self._stream(reporter, registry, cid)
        reporter._sessions["agent-1"].started_at = time.monotonic() - 300.0
        registry.close(cid, "heartbeat lapsed")
        await asyncio.sleep(0.15)
        await _settle()

        ended = next(r for r in sink.sent if r.name.endswith("session_ended"))
        assert float(ended.properties["duration_seconds"]) > 299.0

    async def test_a_second_connection_does_not_start_a_second_session(
        self,
    ) -> None:
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        for _ in range(3):
            cid = self._open(registry)
            await self._stream(reporter, registry, cid)
        await _settle()

        assert self._names(sink) == ["agent_session_started"]

    async def test_closing_one_of_several_connections_ends_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(session_reporter, "_RECONNECT_GRACE_SECONDS", 0.05)
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        first = self._open(registry)
        second = self._open(registry)
        await self._stream(reporter, registry, first)
        await self._stream(reporter, registry, second)
        registry.close(first, "heartbeat lapsed")
        await asyncio.sleep(0.15)
        await _settle()

        assert self._names(sink) == ["agent_session_started"]

    async def test_two_agents_are_two_sessions(self) -> None:
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        for agent in ("agent-1", "agent-2"):
            cid = self._open(registry, agent)
            await self._stream(reporter, registry, cid)
        await _settle()

        assert self._names(sink) == [
            "agent_session_started",
            "agent_session_started",
        ]

    async def test_shutdown_reports_no_ends(self) -> None:
        """Every agent disconnects at once when the process stops; a burst of
        ends saying "the server stopped" is noise, not signal."""
        registry = ConnectionRegistry()
        sink = _RecordingSink()
        reporter = self._reporter(sink, registry)

        cid = self._open(registry)
        await self._stream(reporter, registry, cid)
        await reporter.aclose()
        await _settle()

        assert self._names(sink) == ["agent_session_started"]

    def test_a_listener_that_raises_does_not_break_the_close(self) -> None:
        """The registry's contract — the connection is closed and handed back —
        must not depend on whoever is watching."""
        registry = ConnectionRegistry()
        registry.set_close_listener(lambda conn: (_ for _ in ()).throw(RuntimeError()))
        cid = self._open(registry)

        assert registry.close(cid, "heartbeat lapsed") is not None
        assert registry.get(cid) is None


class TestTelemetryNeverPreventsBoot:
    """A missing identity row disabled reporting; it must not stop the server.

    The row is seeded by a migration boot runs first, so its absence means a
    schema older than the code or a row deleted by hand. Either way, refusing
    to serve over analytics is the one thing this subsystem must never do.
    """

    async def test_an_unreadable_identity_disables_rather_than_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        from sqlalchemy import delete

        from switch_core.db.models import DeploymentIdentity
        from switch_core.telemetry.setup import build_telemetry

        async with session_factory() as session:
            await session.execute(delete(DeploymentIdentity))
            await session.commit()

        service, installed_at, http = await build_telemetry(
            _config(telemetry_enabled=True),  # type: ignore[arg-type]
            session_factory,
            "1.0.0",
        )

        assert service.enabled is False
        assert installed_at is None
        assert http is None

    async def test_it_reports_nothing_rather_than_an_empty_deployment(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Off, not "on with a blank id" — the relay drops a payload it cannot
        attribute, silently and with a 200, so sending would look like working."""
        from sqlalchemy import delete

        from switch_core.db.models import DeploymentIdentity
        from switch_core.telemetry.setup import build_telemetry

        async with session_factory() as session:
            await session.execute(delete(DeploymentIdentity))
            await session.commit()

        service, _, _ = await build_telemetry(
            _config(telemetry_enabled=True),  # type: ignore[arg-type]
            session_factory,
            "1.0.0",
        )
        service.emit("deployment_started", tenant_count=1)
        await service.aclose()


async def _settle() -> None:
    """Let a fire-and-forget send run."""
    for _ in range(3):
        await asyncio.sleep(0)
