"""The hosted agents' metrics: counts and fixed words only, from hosted boxes only.

What matters most here is what can't leave. A status report carries text a
box chose and ids; none of it may reach a metric, so a canary is put in every
text field a report has and looked for in everything the metrics see.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.refusals import RefusalGuard
from switch_core.observability.hosted import (
    MAX_COUNT,
    HostedSampler,
    MachineRow,
    box_summary,
    record_box_report,
    record_credential_refusal,
    record_evictions,
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
NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _sums(registry: MetricsRegistry) -> dict[str, list[tuple[dict, float]]]:
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
        "session": "active",
        "restarts_10m": 0,
        "oom_kills": 0,
        "directory": f"/work/{CANARY}",
        "since": "2026-10-29T11:00:00Z",
        **overrides,
    }


class TestBoxSummary:
    def test_no_id_or_text_from_a_report_reaches_the_summary(self) -> None:
        summary = box_summary(
            _machine(valve_memory=CANARY, gateway_capped=CANARY, guard_stops=CANARY),
            [
                _agent(),
                _agent(process="crashed", reason=CANARY, detail=CANARY),
                _agent(process=CANARY, session=CANARY),
                _agent(
                    session=CANARY,
                    waiting_for_room={"count": 2, "oldest_since": CANARY},
                ),
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
                _agent(session="parked", process="running"),
                _agent(session=None, process="pending"),
                _agent(session="something-new"),
                _agent(process="something-new"),
            ],
        )
        assert summary["agents"] == {
            "running:active": 1,
            "running:parked": 1,
            "pending:none": 1,
            "running:none": 1,
        }

    def test_a_memory_guard_stop_counts_as_out_of_memory(self) -> None:
        """The guard reports its stop as `stopped`, not as a crash."""
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
        summary = box_summary(
            _machine(
                sessions_max=10**12,
                gateway_agents=True,
                gateway_refused=-4,
                guard_stops=3,
                valve_parks=10**9,
            ),
            [
                _agent(restarts_10m=10**12, oom_kills="7"),
                _agent(restarts_10m=MAX_COUNT),
            ],
        )
        assert summary["sessions_max"] == MAX_COUNT
        assert summary["gateway_agents"] == 0
        assert summary["gateway_refused"] == 0
        assert summary["restarts_10m"] == MAX_COUNT
        assert summary["oom_kills"] == 0
        assert summary["guard_stops"] == 3
        assert summary["valve_parks"] == MAX_COUNT

    def test_missing_since_start_counts_stay_missing(self) -> None:
        summary = box_summary(_machine(), [])
        assert summary["guard_stops"] is None
        assert summary["valve_parks"] is None


def _row(
    machine_id: str = "m1",
    *,
    state: str = "ready",
    desired: str = "running",
    reported: timedelta | None = timedelta(seconds=30),
    summary: dict[str, Any] | None = None,
    at: timedelta | None = timedelta(seconds=30),
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
    )


class TestSnapshot:
    def test_a_stale_report_drops_out(self) -> None:
        snap, counts = snapshot_of(
            [_row("fresh"), _row("stale", at=timedelta(minutes=4))], NOW
        )
        assert snap.agents == {("running", "active"): 1}
        assert list(counts) == ["fresh/w1"]

    def test_the_expected_rule_is_one_function(self) -> None:
        """V3 adds paused and turned off to `expected_to_run`, and the count
        follows it with no other change."""
        from switch_core.observability import hosted

        rows = [_row("a"), _row("b")]
        original = hosted.expected_to_run
        try:
            hosted.expected_to_run = lambda row: row.id == "a"  # type: ignore[assignment]
            snap, _ = snapshot_of(rows, NOW)
        finally:
            hosted.expected_to_run = original  # type: ignore[assignment]
        assert snap.boxes_expected == 1

    def test_only_boxes_that_should_run_are_expected(self) -> None:
        """Paused, turned off or stopped boxes must not set off the silent-box alert."""
        snap, _ = snapshot_of(
            [
                _row("up"),
                _row("silent", reported=timedelta(minutes=10)),
                _row("never", reported=None),
                _row("paused", desired="stopped"),
                _row("stopping", state="stopping", desired="stopped"),
                _row("stopped", state="stopped", desired="stopped"),
                _row("starting", state="provisioning"),
            ],
            NOW,
        )
        assert snap.boxes_expected == 3
        assert snap.boxes_reporting == 1

    def test_every_reading_obeys_the_catalogue(self, registry: MetricsRegistry) -> None:
        summary = box_summary(
            _machine(valve_memory="unprotected", gateway_agents=2, gateway_capped=True),
            [_agent(), _agent(process="stopped", reason="out_of_memory")],
        )
        snap, _ = snapshot_of([_row(summary=summary)], NOW)
        registry.register_observer(lambda: snapshot_readings(snap))
        # Collecting validates every name and attribute set against the catalogue.
        gauges = _sums(registry)
        assert ({"kind": "capped_boxes"}, 1.0) in gauges["switch.hosted.gateway"]
        assert ({"state": "unprotected"}, 1.0) in gauges[
            "switch.hosted.boxes_valve_memory"
        ]
        assert ({"reason": "out_of_memory"}, 1.0) in gauges[
            "switch.hosted.agents_stopped"
        ]
        for points in gauges.values():
            for attributes, _value in points:
                assert CANARY not in json.dumps(attributes)

    def test_an_emptied_series_reads_zero(self, registry: MetricsRegistry) -> None:
        snap, _ = snapshot_of([], NOW)
        registry.register_observer(lambda: snapshot_readings(snap))
        gauges = _sums(registry)
        assert len(gauges["switch.hosted.agents"]) == 7 * 4
        assert all(value == 0.0 for _a, value in gauges["switch.hosted.agents"])


def _sampler() -> HostedSampler:
    return HostedSampler(lambda: create_async_engine("sqlite+aiosqlite://"))


class TestRises:
    def _rises(
        self, registry: MetricsRegistry, sampler: HostedSampler, **counts
    ) -> dict:
        sampler._record_rises(counts)
        sums = _sums(registry)
        return {
            "guard": sum(v for _a, v in sums.get("switch.hosted.guard_stops", [])),
            "parks": sum(v for _a, v in sums.get("switch.hosted.valve_parks", [])),
        }

    def test_the_first_sight_is_a_baseline(self, registry: MetricsRegistry) -> None:
        sampler = _sampler()
        assert self._rises(registry, sampler, a=(5, 9)) == {"guard": 0, "parks": 0}

    def test_a_rise_is_counted_once(self, registry: MetricsRegistry) -> None:
        sampler = _sampler()
        self._rises(registry, sampler, a=(5, 9))
        assert self._rises(registry, sampler, a=(7, 10)) == {"guard": 2, "parks": 1}
        assert self._rises(registry, sampler, a=(7, 10)) == {"guard": 0, "parks": 0}

    def test_a_controller_restart_reads_as_a_reset(
        self, registry: MetricsRegistry
    ) -> None:
        sampler = _sampler()
        self._rises(registry, sampler, a=(5, 9))
        assert self._rises(registry, sampler, a=(1, 0)) == {"guard": 1, "parks": 0}

    def test_a_box_that_went_silent_starts_again_from_a_baseline(
        self, registry: MetricsRegistry
    ) -> None:
        sampler = _sampler()
        self._rises(registry, sampler, a=(5, 9))
        self._rises(registry, sampler)
        assert self._rises(registry, sampler, a=(8, 9)) == {"guard": 0, "parks": 0}

    def test_a_box_without_the_counts_adds_nothing(
        self, registry: MetricsRegistry
    ) -> None:
        sampler = _sampler()
        self._rises(registry, sampler, a=(None, None))
        assert self._rises(registry, sampler, a=(None, None)) == {
            "guard": 0,
            "parks": 0,
        }


class TestRecordedWhereTheyArrive:
    def test_memory_histograms(self, registry: MetricsRegistry) -> None:
        record_box_report(_machine(mem_anon_bytes=2048))
        record_box_report(_machine(mem_total_bytes=0))
        record_box_report(_machine(mem_free_bytes=True))
        sums = _sums(registry)
        assert sums["switch.hosted.box_memory_used"] == [({}, 75.0)]
        assert sums["switch.hosted.box_anon_memory"] == [({}, 2048.0)]

    def test_evictions(self, registry: MetricsRegistry) -> None:
        record_evictions(3)
        record_evictions(0)
        record_evictions(None)
        assert _sums(registry)["switch.hosted.box_evictions"] == [({}, 3.0)]

    def test_a_refusal_is_counted_by_its_reason_only(
        self, registry: MetricsRegistry
    ) -> None:
        guard = RefusalGuard(lockout_after=2)
        guard.refused(
            "203.0.113.9", reason="invalid_credential", route="controller", method="GET"
        )
        guard.refused("203.0.113.9", reason=CANARY, route="controller", method="GET")
        guard.refused(
            "203.0.113.9", reason="token_expired", route="controller", method="GET"
        )
        guard.refused(
            "unknown", reason="missing_credential", route="agent", method="GET"
        )
        points = _sums(registry)["switch.controller.credential_refusals"]
        assert {a["reason"]: v for a, v in points} == {
            "invalid_credential": 1.0,
            "other": 1.0,
            "lockout_started": 1.0,
            # Counted while locked out too: one per refused credential.
            "token_expired": 1.0,
            "missing_credential": 1.0,
        }
        for attributes, _value in points:
            assert set(attributes) == {"reason"}
        assert "203.0.113" not in json.dumps(points)

    def test_nothing_is_recorded_without_an_otlp_endpoint(self) -> None:
        """No registry is installed then, and every call is a no-op."""
        uninstall()
        record_box_report(_machine(mem_anon_bytes=1))
        record_evictions(2)
        record_credential_refusal("wrong")
        assert metrics().enabled is False
        assert metrics().collect() == []


class TestSamplerWithoutTheLock:
    async def test_a_process_without_the_lock_reports_nothing(self) -> None:
        sampler = _sampler()

        async def not_held() -> None:
            return None

        sampler._engine = create_async_engine(
            "postgresql+asyncpg://u:p@127.0.0.1:1/x", poolclass=NullPool
        )
        sampler._read = not_held  # type: ignore[method-assign]
        try:
            assert await sampler.sample_once() is None
            assert list(sampler.readings()) == []
        finally:
            await sampler.aclose()


# ── Against a real Postgres ──────────────────────────────────────────────────


def _unpooled(url: str) -> AsyncEngine:
    return create_async_engine(url, poolclass=NullPool)


async def _seed_box(
    session_factory, *, summary: dict[str, Any], state: str = "ready"
) -> str:
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
            state=state,
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
        await _seed_box(session_factory, summary=box_summary(_machine(), [_agent()]))
        first = HostedSampler(lambda: _unpooled(postgres_schema))
        second = HostedSampler(lambda: _unpooled(postgres_schema))
        try:
            snap = await first.sample_once()
            assert snap is not None
            assert snap.agents == {("running", "active"): 1}
            assert snap.boxes_expected == snap.boxes_reporting == 1
            assert await second.sample_once() is None
            assert list(second.readings()) == []

            # The holder goes away; its lock goes with its connection.
            await first.aclose()
            assert await second.sample_once() is not None
            assert list(second.readings())
        finally:
            await first.aclose()
            await second.aclose()

    async def test_the_restricted_runtime_role_can_read_the_boxes(
        self, rls_harness
    ) -> None:
        """The deployment runs as a role row-level security applies to."""
        url = rls_harness.restricted_engine.url.render_as_string(hide_password=False)
        await _seed_box(rls_harness.owner, summary=box_summary(_machine(), [_agent()]))
        sampler = HostedSampler(lambda: _unpooled(url))
        try:
            snap = await sampler.sample_once()
        finally:
            await sampler.aclose()
        assert snap is not None
        assert snap.boxes_expected == 1
        assert snap.agents == {("running", "active"): 1}
