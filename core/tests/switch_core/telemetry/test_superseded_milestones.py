"""Milestones added after deployments were already running.

`first_agent_connected` renames what `first_session_started` always measured,
and `first_agent_session` is the first real coding-agent session. A deployment
that passed either before it existed must not report it now, months in, as if
it were its first: at boot it claims them without reporting. A new deployment
has nothing to settle and reports each the first time it happens.

Against real Postgres, because the claims are rows and the guard is the
primary key.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.session_reporter import SessionReporter
from switch_core.bridges.agent.protocol.agent_connections import (
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import Agent
from switch_core.telemetry.deployment import (
    SESSION_START_CLAIM_PREFIX,
    claim_milestone,
    milestone_claimed,
    settle_superseded_milestones,
)
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.session_start import (
    default_session_start_limiter,
    report_session_started,
)
from switch_core.telemetry.sink import TelemetryRecord


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _service(
    sink: _RecordingSink,
    session_factory: async_sessionmaker[AsyncSession],
    *,
    enabled: bool = True,
) -> TelemetryService:
    return TelemetryService(
        sink=sink,  # type: ignore[arg-type]
        enabled=enabled,
        client_id="deployment-uuid",
        version="1.0.0",
        telemetry_environment="prod",
        telemetry_internal=False,
        deployment_kind="self_hosted",
        session_factory=session_factory,
        installed_at=datetime.now(UTC) - timedelta(days=1),
    )


def _agent() -> Agent:
    """The reporter reads only the agent's id and runtime, so it need not be a
    stored row."""
    return Agent(id=str(uuid.uuid4()), name="agent", metadata_={})


class TestSettling:
    async def test_a_new_deployment_has_nothing_to_settle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert await settle_superseded_milestones(session_factory) == []
        assert await milestone_claimed(session_factory, "first_agent_connected") == (
            "false"
        )
        assert await milestone_claimed(session_factory, "first_agent_session") == (
            "false"
        )

    async def test_a_deployment_that_came_online_before_settles_the_new_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(session_factory, "first_session_started")

        assert await settle_superseded_milestones(session_factory) == [
            "first_agent_connected"
        ]
        assert await milestone_claimed(session_factory, "first_agent_connected") == (
            "true"
        )

    async def test_a_room_used_with_an_agent_means_sessions_already_ran(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(session_factory, "first_room_active")

        assert await settle_superseded_milestones(session_factory) == [
            "first_agent_session"
        ]

    async def test_a_session_reported_this_week_means_sessions_already_ran(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(
            session_factory, f"{SESSION_START_CLAIM_PREFIX}agent-1:session-1"
        )

        assert await settle_superseded_milestones(session_factory) == [
            "first_agent_session"
        ]

    async def test_settling_twice_claims_nothing_the_second_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(session_factory, "first_session_started")
        await claim_milestone(session_factory, "first_room_active")

        assert sorted(await settle_superseded_milestones(session_factory)) == [
            "first_agent_connected",
            "first_agent_session",
        ]
        assert await settle_superseded_milestones(session_factory) == []

    async def test_evidence_written_after_the_first_settling_is_not_history(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A process booting while another takes the deployment's first
        session must not read that session's claim as history and claim the
        milestone before its report does."""
        assert await settle_superseded_milestones(session_factory) == []
        await claim_milestone(
            session_factory, f"{SESSION_START_CLAIM_PREFIX}agent-1:session-1"
        )

        assert await settle_superseded_milestones(session_factory) == []
        assert await milestone_claimed(session_factory, "first_agent_session") == (
            "false"
        )

    async def test_a_settled_milestone_is_never_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(session_factory, "first_session_started")
        sink = _RecordingSink()
        service = _service(sink, session_factory)

        await service.settle_superseded_milestones()
        await service.emit_milestone("first_agent_connected", known_agent_type="none")
        await service.aclose()

        assert sink.sent == []

    async def test_nothing_is_settled_while_telemetry_is_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """For the reason `emit_milestone` claims nothing while off: switching
        it on later must find the right claims, not ones taken in the dark."""
        await claim_milestone(session_factory, "first_session_started")
        off = _service(_RecordingSink(), session_factory, enabled=False)

        await off.settle_superseded_milestones()

        assert await milestone_claimed(session_factory, "first_agent_connected") == (
            "false"
        )


class TestTheFirstRealSession:
    async def test_the_first_reported_session_is_the_milestone_and_only_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        agent = _agent()
        sink = _RecordingSink()
        service = _service(sink, session_factory)
        limiter = default_session_start_limiter()

        for session_id in (str(uuid.uuid4()), str(uuid.uuid4())):
            await report_session_started(
                service, session_factory, limiter, agent, session_id, "room"
            )
        await service.aclose()

        names = [record.name for record in sink.sent]
        assert names == [
            "switch_core.session_started",
            "switch_core.first_agent_session",
            "switch_core.session_started",
        ]
        milestone = sink.sent[1]
        assert milestone.properties["start_source"] == "room"
        assert "seconds_since_install" in milestone.properties

    async def test_a_deployment_that_already_had_sessions_does_not_report_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await claim_milestone(session_factory, "first_room_active")
        agent = _agent()
        sink = _RecordingSink()
        service = _service(sink, session_factory)

        await service.settle_superseded_milestones()
        await report_session_started(
            service,
            session_factory,
            default_session_start_limiter(),
            agent,
            str(uuid.uuid4()),
            "user",
        )
        await service.aclose()

        assert [record.name for record in sink.sent] == ["switch_core.session_started"]


class TestComingOnline:
    async def test_the_first_connection_reports_both_names_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Until `first_session_started` is retired, a new deployment reports the
        moment under both names, and each only once."""
        registry = AgentConnectionRegistry()
        sink = _RecordingSink()
        service = _service(sink, session_factory)
        reporter = SessionReporter(service, registry)
        registry.set_close_listener(reporter.on_close)

        for agent_id in ("agent-1", "agent-2"):
            connection_id = uuid.uuid4().hex
            registry.open(
                agent_id=agent_id,
                connection_id=connection_id,
                scope="all",
                delivery_filter="all",
                spawn_capable=False,
                position={OWN_EVENTS: 0},
                declaration=ClientDeclaration(),
                expected_generation=None,
            )
            connection = registry.get(connection_id)
            assert connection is not None
            await reporter.started(
                SimpleNamespace(metadata_={"known_agent_type": "codex"}),  # type: ignore[arg-type]
                connection,
            )
        await service.aclose()

        milestones = [
            record.name.removeprefix("switch_core.")
            for record in sink.sent
            if record.name.removeprefix("switch_core.").startswith("first_")
        ]
        assert milestones == ["first_session_started", "first_agent_connected"]
