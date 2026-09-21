"""The defects a third review found after 487 was merged with 491.

Each is the same shape: something that fails silently. A misdirected endpoint
that 404s once per event into a log nobody reads, an identity the relay drops
with a 200, a once-ever claim spent while nothing is listening, and a session
that ends with no event because the path that closed it was not one of the
three that reported.
"""

from __future__ import annotations

import time
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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


class TestSessionEndsAreReportedFromEveryClosePath:
    """Five paths close a connection and three reported. The two that did not
    also remove it from the registry, so nothing downstream could recover it."""

    def _registry(self, sink: _RecordingSink) -> ConnectionRegistry:
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id=VALID_UUID,
            service_name="switch-core",
            version="1.0.0",
            environment=None,
        )
        registry = ConnectionRegistry()
        self.reporter = SessionReporter(service)
        registry.set_close_listener(self.reporter.on_close)
        return registry

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
        # The handler reports the start once the stream is handed back; these
        # tests are about the close, so mark it started directly.
        self.reporter._started.add(connection_id)
        return connection_id

    async def test_a_close_reports_the_session(self) -> None:
        sink = _RecordingSink()
        registry = self._registry(sink)
        connection_id = self._open(registry)

        registry.close(connection_id, "heartbeat lapsed")
        # The send is fire-and-forget; let it run.
        await _settle()

        assert [r.name for r in sink.sent] == ["switch_core.agent_session_ended"]
        assert sink.sent[0].properties["reason"] == "heartbeat_lapsed"

    async def test_a_room_claim_failure_reports_too(self) -> None:
        """One of the two paths that previously reported nothing."""
        sink = _RecordingSink()
        registry = self._registry(sink)
        connection_id = self._open(registry)

        registry.close(connection_id, "room already claimed")
        await _settle()

        assert sink.sent[0].properties["reason"] == "room_claimed"

    async def test_an_unknown_reason_degrades_rather_than_failing(self) -> None:
        """A reason added to the registry later must not make the event
        invalid at the moment a session drops."""
        sink = _RecordingSink()
        registry = self._registry(sink)
        connection_id = self._open(registry)

        registry.close(connection_id, "something nobody mapped")
        await _settle()

        assert sink.sent[0].properties["reason"] == "error"

    async def test_the_duration_is_the_session_length(self) -> None:
        sink = _RecordingSink()
        registry = self._registry(sink)
        connection_id = self._open(registry)
        conn = registry.get(connection_id)
        assert conn is not None
        conn.opened_at = time.monotonic() - 42.0

        registry.close(connection_id, "heartbeat lapsed")
        await _settle()

        assert 41.0 < float(sink.sent[0].properties["duration_seconds"]) < 43.0

    async def test_closing_an_unknown_connection_reports_nothing(self) -> None:
        sink = _RecordingSink()
        registry = self._registry(sink)

        registry.close("never-opened", "heartbeat lapsed")
        await _settle()

        assert sink.sent == []

    def test_a_listener_that_raises_does_not_break_the_close(self) -> None:
        """The registry's contract is that the connection is closed and handed
        back. An observer cannot be allowed to change that."""
        registry = ConnectionRegistry()
        self.reporter = SessionReporter(None)
        registry.set_close_listener(lambda conn: (_ for _ in ()).throw(RuntimeError()))
        connection_id = self._open(registry)

        assert registry.close(connection_id, "heartbeat lapsed") is not None
        assert registry.get(connection_id) is None


async def _settle() -> None:
    """Let a fire-and-forget send run."""
    import asyncio

    for _ in range(3):
        await asyncio.sleep(0)


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


class TestARejectedStreamIsNotASession:
    """The flood that reached the first real dashboard.

    Opening a stream creates a connection, then claims rooms on it, and a claim
    can fail — the room is held by another live session, or the agent is not a
    member. The connection is closed and the client retries. Reporting the
    start when the connection was created turned every rejected attempt into a
    session that began and ended in the same second, for as long as the client
    kept trying, which is forever.
    """

    def _reporter(self, sink: _RecordingSink) -> SessionReporter:
        return SessionReporter(
            TelemetryService(
                sink=sink,  # type: ignore[arg-type]
                enabled=True,
                client_id=VALID_UUID,
                service_name="switch-core",
                version="1.0.0",
                environment=None,
            )
        )

    def _conn(self, registry: ConnectionRegistry) -> str:
        connection_id = uuid.uuid4().hex
        registry.open(
            agent_id="agent-1",
            connection_id=connection_id,
            scope="all",
            delivery_filter="all",
            spawn_capable=False,
            cursor=0,
            declaration=ClientDeclaration(),
        )
        return connection_id

    async def test_a_connection_closed_before_the_stream_reports_nothing(
        self,
    ) -> None:
        """The room claim failed, so no session ever began — and reporting an
        end for it would be an end with no start."""
        sink = _RecordingSink()
        reporter = self._reporter(sink)
        registry = ConnectionRegistry()
        registry.set_close_listener(reporter.on_close)

        connection_id = self._conn(registry)
        registry.close(connection_id, "room already claimed")
        await _settle()

        assert sink.sent == []

    async def test_a_retry_loop_produces_no_events_at_all(self) -> None:
        """Twenty rejected attempts is what the dashboard actually saw."""
        sink = _RecordingSink()
        reporter = self._reporter(sink)
        registry = ConnectionRegistry()
        registry.set_close_listener(reporter.on_close)

        for _ in range(20):
            connection_id = self._conn(registry)
            registry.close(connection_id, "room already claimed")
        await _settle()

        assert sink.sent == []

    async def test_a_stream_that_was_handed_back_reports_both(self) -> None:
        sink = _RecordingSink()
        reporter = self._reporter(sink)
        registry = ConnectionRegistry()
        registry.set_close_listener(reporter.on_close)

        connection_id = self._conn(registry)
        conn = registry.get(connection_id)
        assert conn is not None
        await reporter.started(
            SimpleNamespace(metadata_={"known_agent_type": "codex"}),  # type: ignore[arg-type]
            conn,
        )
        registry.close(connection_id, "heartbeat lapsed")
        await _settle()

        assert [r.name for r in sink.sent] == [
            "switch_core.agent_session_started",
            "switch_core.agent_session_ended",
        ]

    async def test_the_started_set_does_not_grow(self) -> None:
        """It is bounded by the live connection count; the sweep reaps anything
        whose client went away, so every id is eventually discarded."""
        sink = _RecordingSink()
        reporter = self._reporter(sink)
        registry = ConnectionRegistry()
        registry.set_close_listener(reporter.on_close)

        for _ in range(50):
            connection_id = self._conn(registry)
            conn = registry.get(connection_id)
            assert conn is not None
            await reporter.started(
                SimpleNamespace(metadata_=None),  # type: ignore[arg-type]
                conn,
            )
            registry.close(connection_id, "heartbeat lapsed")
        await _settle()

        assert reporter._started == set()
