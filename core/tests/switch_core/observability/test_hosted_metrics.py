"""Hosted agents' cloud machine metrics: counts and fixed words only.

What matters most here is what can't leave. A status report carries text a
machine chose and ids; none of it may reach a metric, so a canary is put in
every text field a report has and looked for in everything the metrics see.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from switch_core.observability.hosted import (
    MAX_COUNT,
    HostedSampler,
    MachineRow,
    ReconcilerWatch,
    box_summary,
    record_box_report,
    record_credential_refusal,
    record_machine_event,
    route_kind,
    snapshot_of,
    snapshot_readings,
)
from switch_core.observability.metrics import (
    MetricsRegistry,
    install,
    metrics,
    uninstall,
)

CANARY = "CANARY-7f3c-do-not-export"
NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _points(registry: MetricsRegistry) -> dict[str, list[tuple[dict, float]]]:
    out: dict[str, list[tuple[dict, float]]] = {}
    for payload in registry.collect():
        for point in payload.numbers:
            out.setdefault(payload.name, []).append(
                (dict(point.attributes), point.value)
            )
        for hist in payload.histograms:
            out.setdefault(payload.name, []).append((dict(hist.attributes), hist.total))
    return out


def _machine(**overrides: Any) -> dict[str, Any]:
    return {
        "platform": {"os": CANARY, "arch": CANARY, "os_version": CANARY},
        "disk_free_bytes": 10,
        "disk_total_bytes": 20,
        "mem_free_bytes": 1024,
        "mem_total_bytes": 4096,
        "sessions_running": 2,
        "sessions_max": 6,
        "workspaces_dir": f"/home/{CANARY}/workspaces",
        **overrides,
    }


def _agent(**overrides: Any) -> dict[str, Any]:
    return {
        "agent_id": CANARY,
        "applied_revision": 1,
        "process": "running",
        "attached": True,
        "sessions": {"active": 1, "ids": [CANARY]},
        "directory": f"/work/{CANARY}",
        "since": "2026-11-10T11:00:00Z",
        **overrides,
    }


class TestBoxSummary:
    def test_no_id_or_text_from_a_report_reaches_the_summary(self) -> None:
        summary = box_summary(
            _machine(note=CANARY),
            [
                _agent(),
                _agent(process="crashed", reason=CANARY, detail=CANARY),
                _agent(process=CANARY, session=CANARY),
                {CANARY: CANARY},
                CANARY,
            ],
        )
        assert CANARY not in json.dumps(summary)

    def test_states_map_onto_the_fixed_sets(self) -> None:
        summary = box_summary(
            _machine(),
            [
                _agent(),
                _agent(session="parked"),
                _agent(process="pending"),
                _agent(session="something-new"),
                _agent(process="something-new"),
            ],
        )
        assert summary["agents"] == {
            "running:none": 2,
            "running:parked": 1,
            "pending:none": 1,
        }

    def test_stopped_agents_by_reason(self) -> None:
        summary = box_summary(
            _machine(),
            [
                _agent(process="stopped", reason="out_of_memory"),
                _agent(process="stopped"),
                _agent(process="failed", reason="crash_loop"),
                _agent(process="crashed", reason="internal"),
            ],
        )
        assert summary["stopped"] == {"out_of_memory": 1, "crash_loop": 1, "other": 1}

    def test_counts_are_bounded_ints(self) -> None:
        summary = box_summary(_machine(sessions_max=10**12, sessions_running="7"), [])
        assert summary["sessions_max"] == MAX_COUNT
        assert summary["sessions_running"] == 0


def _row(
    machine_id: str = "m1",
    *,
    state: str = "ready",
    desired: str = "running",
    reported: timedelta | None = timedelta(seconds=30),
    summary: dict[str, Any] | None = None,
    at: timedelta | None = timedelta(seconds=30),
    backend: str = "vm",
) -> MachineRow:
    controllers = {}
    if at is not None:
        controllers["w1"] = {
            "at": (NOW - at).isoformat(),
            "sessions_running": 1,
            "metrics": summary
            if summary is not None
            else box_summary(_machine(), [_agent()]),
        }
    return MachineRow(
        id=machine_id,
        state=state,
        desired_state=desired,
        heartbeat={"disk": None, "memory": None, "controllers": controllers},
        heartbeat_at=None if reported is None else NOW - reported,
        backend=backend,
    )


class TestSnapshot:
    def test_a_stale_report_drops_out(self) -> None:
        snap = snapshot_of([_row("fresh"), _row("stale", at=timedelta(minutes=4))], NOW)
        assert snap.agents == {("vm", "running", "none"): 1}
        assert snap.sessions_running == {"vm": 2}

    def test_only_machines_that_should_run_are_expected(self) -> None:
        """Machines stopped by their owner or for idleness must not set off
        the silent-machine alert."""
        snap = snapshot_of(
            [
                _row("up"),
                _row("silent", reported=timedelta(minutes=10)),
                _row("never", reported=None),
                _row("owner-stopped", desired="stopped"),
                _row("stopping", state="stopping", desired="stopped"),
                _row("stopped", state="stopped", desired="stopped"),
                _row("starting", state="provisioning"),
            ],
            NOW,
        )
        assert snap.boxes_expected == {"vm": 3}
        assert snap.boxes_reporting == {"vm": 1}

    def test_a_woken_machine_is_not_expected_until_it_reports(self) -> None:
        """Waking a ready machine makes it prove itself again
        (`provisioning`), and it turns ready only when a report arrives, so a
        booting machine never counts as expected but silent."""
        from switch_core.db.models import CloudMachine
        from switch_core.db.stores.hosted_machine_store import CloudMachineStore

        machine = CloudMachine(
            id="m1",
            owner_id="u1",
            state="ready",
            desired_state="stopped",
            stop_reason="idle",
            revision=3,
        )
        CloudMachineStore().start(machine, NOW)
        row = MachineRow(
            id="m1",
            state=machine.state,
            desired_state=machine.desired_state,
            heartbeat=None,
            heartbeat_at=NOW - timedelta(hours=1),
        )
        snap = snapshot_of([row], NOW)
        assert (machine.state, machine.desired_state) == ("provisioning", "running")
        assert snap.boxes_expected == {"vm": 0}

    def test_a_machine_of_an_unknown_kind_is_left_out(self) -> None:
        snap = snapshot_of([_row(backend=CANARY)], NOW)
        assert snap.agents == {}
        assert snap.boxes_expected == {"vm": 0}

    def test_every_reading_obeys_the_catalogue_and_carries_no_text(
        self, registry: MetricsRegistry
    ) -> None:
        summary = box_summary(
            _machine(),
            [_agent(), _agent(process="crashed", reason="crash_loop", detail=CANARY)],
        )
        snap = snapshot_of([_row(summary=summary)], NOW)
        registry.register_observer(lambda: snapshot_readings(snap))
        # Collecting validates every name and attribute set against the catalogue.
        points = _points(registry)
        assert ({"reason": "crash_loop", "backend": "vm"}, 1.0) in points[
            "switch.hosted.agents_stopped"
        ]
        assert ({"backend": "vm"}, 1.0) in points["switch.hosted.boxes_expected"]
        assert ({"kind": "max", "backend": "vm"}, 6.0) in points[
            "switch.hosted.sessions"
        ]
        assert CANARY not in json.dumps(points)

    def test_an_emptied_series_reads_zero(self, registry: MetricsRegistry) -> None:
        snap = snapshot_of([], NOW)
        registry.register_observer(lambda: snapshot_readings(snap))
        points = _points(registry)
        assert len(points["switch.hosted.agents"]) == 7 * 4
        assert all(value == 0.0 for _a, value in points["switch.hosted.agents"])


class TestRecordedWhereTheyArrive:
    def test_memory_used(self, registry: MetricsRegistry) -> None:
        record_box_report(_machine())
        record_box_report(_machine(mem_total_bytes=0))
        record_box_report(_machine(mem_free_bytes=True))
        record_box_report(_machine(), CANARY)
        points = _points(registry)["switch.hosted.box_memory_used"]
        assert sorted((a["backend"], v) for a, v in points) == [
            ("other", 75.0),
            ("vm", 75.0),
        ]

    def test_memory_is_counted_once_per_machine(self) -> None:
        from switch_core.observability.hosted import reports_memory

        fresh = (NOW - timedelta(seconds=30)).isoformat()
        stale = (NOW - timedelta(minutes=10)).isoformat()
        reports = {"w1": {"at": fresh}, "w2": {"at": fresh}}
        assert reports_memory(reports, "w1", NOW)
        assert not reports_memory(reports, "w2", NOW)
        # The first workspace's controller went quiet: the next takes over.
        assert reports_memory({"w1": {"at": stale}, "w2": {"at": fresh}}, "w2", NOW)
        # A machine with one workspace always counts.
        assert reports_memory({"w1": {"at": fresh}}, "w1", NOW)

    def test_a_refusal_is_by_reason_and_route_only(
        self, registry: MetricsRegistry
    ) -> None:
        record_credential_refusal("token_expired", "controller")
        record_credential_refusal("wrong", "hosted_controller")
        record_credential_refusal(CANARY, CANARY)
        points = _points(registry)["switch.controller.credential_refusals"]
        assert sorted((a["reason"], a["route"]) for a, _ in points) == [
            ("other", "other"),
            ("token_expired", "controller"),
            ("wrong", "hosted_controller"),
        ]

    def test_the_route_kind_is_never_the_path(self) -> None:
        assert route_kind("/v1/management/controllers/x/token") == "management"
        assert route_kind("/v1/controllers/ctl-1/status") == "controller"
        assert route_kind(f"/v1/agents/{CANARY}") == "agent"

    def test_nothing_is_recorded_without_an_otlp_endpoint(self) -> None:
        """No registry is installed then, and every call is a no-op."""
        uninstall()
        record_box_report(_machine())
        record_credential_refusal("wrong", "hosted_controller")
        assert metrics().enabled is False
        assert metrics().collect() == []


class TestMachineEvents:
    """`record_machine_event` listens on the async session's sync session, so
    a plain one stands in for it here, on an in-memory database."""

    def test_counted_once_committed_with_fixed_words(
        self, registry: MetricsRegistry
    ) -> None:
        session = Session(create_engine("sqlite://"))
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "failed", "never_connected")
            record_machine_event(wrapper, "woken", CANARY)
            record_machine_event(wrapper, CANARY, "idle", CANARY)
            assert "switch.hosted.machine_events" not in _points(registry)
            session.commit()
        finally:
            session.close()
        points = _points(registry)["switch.hosted.machine_events"]
        assert sorted((a["event"], a["reason"], a["backend"]) for a, _ in points) == [
            ("failed", "never_connected", "vm"),
            ("other", "other", "other"),
            ("woken", "other", "vm"),
        ]
        assert CANARY not in json.dumps(points)

    def test_never_counted_when_rolled_back(self, registry: MetricsRegistry) -> None:
        session = Session(create_engine("sqlite://"))
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "stopped", "owner")
            session.rollback()
        finally:
            session.close()
        assert "switch.hosted.machine_events" not in _points(registry)

    def test_a_savepoint_committing_does_not_count_when_the_transaction_rolls_back(
        self, registry: MetricsRegistry
    ) -> None:
        """As `emit_after_commit`: only the outermost commit counts."""
        session = Session(create_engine("sqlite://"))
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "stopped", "owner")
            nested = session.begin_nested()
            session.execute(text("SELECT 1"))
            nested.commit()
            session.rollback()
        finally:
            session.close()
        assert "switch.hosted.machine_events" not in _points(registry)

    def test_a_savepoint_committing_inside_a_committed_transaction_counts_once(
        self, registry: MetricsRegistry
    ) -> None:
        session = Session(create_engine("sqlite://"))
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "stopped", "owner")
            nested = session.begin_nested()
            nested.commit()
            session.commit()
        finally:
            session.close()
        assert _points(registry)["switch.hosted.machine_events"] == [
            ({"event": "stopped", "reason": "owner", "backend": "vm"}, 1.0)
        ]


class TestReconcilerWatch:
    def test_absent_until_heard_then_the_seconds_since(
        self, registry: MetricsRegistry
    ) -> None:
        now = [100.0]
        watch = ReconcilerWatch(clock=lambda: now[0])
        registry.register_observer(watch.readings)
        assert "switch.hosted.reconciler_silence" not in _points(registry)
        watch.heard()
        now[0] = 145.0
        assert _points(registry)["switch.hosted.reconciler_silence"] == [({}, 45.0)]

    def test_a_process_started_with_the_reconciler_down_shows_rising_silence(
        self, registry: MetricsRegistry
    ) -> None:
        """Started at boot, so a reconciler that never calls
        still reads as silent, and the alert can fire."""
        now = [100.0]
        watch = ReconcilerWatch(clock=lambda: now[0])
        registry.register_observer(watch.readings)
        watch.start()
        now[0] = 160.0
        assert _points(registry)["switch.hosted.reconciler_silence"] == [({}, 60.0)]
        now[0] = 760.0
        assert _points(registry)["switch.hosted.reconciler_silence"] == [({}, 660.0)]

    def test_starting_again_never_hides_silence_already_counted(
        self, registry: MetricsRegistry
    ) -> None:
        now = [100.0]
        watch = ReconcilerWatch(clock=lambda: now[0])
        registry.register_observer(watch.readings)
        watch.heard()
        now[0] = 400.0
        watch.start()
        assert _points(registry)["switch.hosted.reconciler_silence"] == [({}, 300.0)]


def _unpooled(url: str) -> AsyncEngine:
    return create_async_engine(url, poolclass=NullPool)


class TestSamplerWithoutTheLock:
    async def test_a_process_without_the_lock_reports_nothing(self) -> None:
        sampler = HostedSampler(
            lambda: _unpooled("postgresql+asyncpg://u:p@127.0.0.1:1/x")
        )

        async def not_held() -> None:
            return None

        sampler._read = not_held  # type: ignore[method-assign]
        try:
            assert await sampler.sample_once() is None
            assert list(sampler.readings()) == []
        finally:
            await sampler.aclose()


# ── Against a real Postgres ──────────────────────────────────────────────────


async def _seed_machine(session_factory, *, summary: dict[str, Any]) -> str:
    """A cloud machine with one fresh controller report carrying `summary`.
    The table is global, so no tenant is involved."""
    from uuid import uuid4

    from switch_core.db.models import CloudMachine, User

    now = datetime.now(UTC)
    async with session_factory() as session:
        user = User(name="owner", email=f"{uuid4()}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        machine = CloudMachine(
            id=str(uuid4()),
            owner_id=user.id,
            state="ready",
            desired_state="running",
            revision=1,
            active_at=now,
            created_at=now,
            updated_at=now,
            heartbeat={
                "disk": None,
                "memory": None,
                "controllers": {
                    "w1": {
                        "at": now.isoformat(),
                        "sessions_running": 1,
                        "metrics": summary,
                    }
                },
            },
            heartbeat_at=now,
        )
        session.add(machine)
        await session.commit()
        return machine.id


class TestOneProcessReports:
    async def test_only_the_lock_holder_reports_and_another_takes_over(
        self, session_factory, postgres_schema: str
    ) -> None:
        await _seed_machine(
            session_factory, summary=box_summary(_machine(), [_agent()])
        )
        first = HostedSampler(lambda: _unpooled(postgres_schema))
        second = HostedSampler(lambda: _unpooled(postgres_schema))
        try:
            snap = await first.sample_once()
            assert snap is not None
            assert snap.agents == {("vm", "running", "none"): 1}
            assert snap.boxes_expected == snap.boxes_reporting == {"vm": 1}
            assert await second.sample_once() is None
            assert list(second.readings()) == []

            # The holder goes away; its lock goes with its connection.
            await first.aclose()
            assert await second.sample_once() is not None
            assert list(second.readings())
        finally:
            await first.aclose()
            await second.aclose()

    async def test_the_restricted_runtime_role_can_read_the_machines(
        self, rls_harness
    ) -> None:
        """The deployment runs as a role row-level security applies to."""
        url = rls_harness.restricted_engine.url.render_as_string(hide_password=False)
        await _seed_machine(
            rls_harness.owner, summary=box_summary(_machine(), [_agent()])
        )
        sampler = HostedSampler(lambda: _unpooled(url))
        try:
            snap = await sampler.sample_once()
        finally:
            await sampler.aclose()
        assert snap is not None
        assert snap.boxes_expected == {"vm": 1}
        assert snap.agents == {("vm", "running", "none"): 1}


class TestCatalogueAdditions:
    """Provider login problems, disk, provisioning time, sampler failures, and
    the finer failure reasons (`wake_failed`, `stop_failed`, `launch_refused`)."""

    def test_login_problems_are_counted_by_provider_and_reason_only(self) -> None:
        summary = box_summary(
            _machine(),
            [],
            [
                {"provider": "claude", "installed": True, "auth": "missing"},
                {"provider": "codex", "installed": True, "auth": "expired"},
                {"provider": "codex", "installed": True, "auth": "ok"},
                {"provider": "cursor", "installed": True, "auth": "unknown"},
                {"provider": "opencode", "installed": False, "auth": "missing"},
                {"provider": CANARY, "installed": True, "auth": "missing"},
                {"provider": "claude", "installed": True, "auth": CANARY},
                CANARY,
            ],
        )
        assert summary["login_problems"] == {
            "claude:missing": 1,
            "codex:expired": 1,
            "other:missing": 1,
        }
        assert CANARY not in json.dumps(summary)

    def test_login_problem_gauges_obey_the_catalogue(
        self, registry: MetricsRegistry
    ) -> None:
        summary = box_summary(
            _machine(), [], [{"provider": "claude", "auth": "expired"}]
        )
        snap = snapshot_of([_row(summary=summary)], NOW)
        registry.register_observer(lambda: snapshot_readings(snap))
        points = _points(registry)["switch.hosted.provider_login_problems"]
        assert (
            {"provider": "claude", "reason": "expired", "backend": "vm"},
            1.0,
        ) in points
        assert sum(v for _a, v in points) == 1.0

    def test_disk_is_recorded_with_memory(self, registry: MetricsRegistry) -> None:
        record_box_report(_machine(disk_free_bytes=10, disk_total_bytes=40))
        record_box_report(_machine(disk_free_bytes=50, disk_total_bytes=40))
        points = _points(registry)["switch.hosted.disk_used"]
        assert points == [({"backend": "vm"}, 75.0)]

    def test_provisioning_time_is_bounded(self, registry: MetricsRegistry) -> None:
        from switch_core.observability.hosted import record_provisioned

        record_provisioned(240.0)
        record_provisioned(-5.0)
        record_provisioned(10**7)
        points = _points(registry)["switch.hosted.provision_seconds"]
        assert points == [({"backend": "vm"}, 240.0)]

    async def test_a_failed_sample_is_counted(self, registry: MetricsRegistry) -> None:
        sampler = HostedSampler(
            lambda: _unpooled("postgresql+asyncpg://u:p@127.0.0.1:1/x")
        )

        async def broken() -> None:
            raise ConnectionRefusedError("no database")

        sampler._read = broken  # type: ignore[method-assign]
        try:
            assert await sampler.sample_once() is None
        finally:
            await sampler.aclose()
        assert _points(registry)["switch.observability.sample_failures"] == [
            ({"sampler": "hosted"}, 1.0)
        ]

    def test_wake_and_stop_failures_are_fixed_words(
        self, registry: MetricsRegistry
    ) -> None:
        session = Session(create_engine("sqlite://"))
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "failed", "wake_failed")
            record_machine_event(wrapper, "failed", "stop_failed")
            record_machine_event(wrapper, "failed", "launch_refused")
            session.commit()
        finally:
            session.close()
        reasons = sorted(
            a["reason"] for a, _ in _points(registry)["switch.hosted.machine_events"]
        )
        assert reasons == ["launch_refused", "stop_failed", "wake_failed"]


class TestControllerErrorCounts:
    """The controller error and restart counts: fixed words only, whatever Core is
    handed."""

    def test_a_cloud_error_outside_the_fixed_words_counts_as_other(
        self, registry: MetricsRegistry
    ) -> None:
        from switch_core.observability.hosted import record_cloud_error

        record_cloud_error("launch", "capacity", 4)
        record_cloud_error("RunInstances", "InsufficientInstanceCapacity")
        record_cloud_error("stop", "throttled", 0)
        assert sorted(
            (attrs["call"], attrs["kind"], value)
            for attrs, value in _points(registry)["switch.hosted.cloud_errors"]
        ) == [("launch", "capacity", 4.0), ("other", "other", 1.0)]

    def test_controller_errors_count_by_kind_and_skip_zeros(
        self, registry: MetricsRegistry
    ) -> None:
        from switch_core.observability.hosted import record_controller_errors

        record_controller_errors({"cloud": 3, "core_api": 0, "surprise": 2})
        assert sorted(
            (attrs["kind"], value)
            for attrs, value in _points(registry)["switch.hosted.controller_errors"]
        ) == [("cloud", 3.0), ("other", 2.0)]

    def test_a_restart_is_counted_by_backend(self, registry: MetricsRegistry) -> None:
        from switch_core.observability.hosted import record_controller_restart

        record_controller_restart()
        assert _points(registry)["switch.hosted.controller_restarts"] == [
            ({"backend": "vm"}, 1.0)
        ]
