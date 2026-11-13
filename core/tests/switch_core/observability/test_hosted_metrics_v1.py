"""Hosted metrics for v1 machines as well as v2 boxes.

v1 machines (`backend` `vm`) fill the gauges their status reports can: agents,
stopped agents, sessions, machines expected and reporting, and memory used.
The rest stay boxes' only. Machine changes and refused controller
credentials are counted with fixed words only, and the hosted controller
service's silence is measured per process. All of it with hosted agents v2
off too: counts only, and nothing without an OTLP endpoint.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from switch_core.observability.hosted import (
    MachineRow,
    ReconcilerWatch,
    box_summary,
    record_box_report,
    record_credential_refusal,
    record_machine_event,
    snapshot_of,
    snapshot_readings,
)
from switch_core.observability.metrics import MetricsRegistry, install, uninstall

CANARY = "CANARY-v1-obs-do-not-export"
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


def _v1_report() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """A v1 controller's report: no box fields, a canary in every text field."""
    machine = {
        "platform": {"os": CANARY, "arch": CANARY, "os_version": CANARY},
        "mem_total_bytes": 4000,
        "mem_free_bytes": 1000,
        "sessions_running": 2,
        "sessions_max": 8,
        "note": CANARY,
    }
    agents = [
        {"agent_id": CANARY, "process": "running", "directory": CANARY},
        {"agent_id": CANARY, "process": "crashed", "reason": "crash_loop"},
    ]
    return machine, agents


def _row(machine_id: str, backend: str, summary: dict[str, Any]) -> MachineRow:
    return MachineRow(
        id=machine_id,
        state="ready",
        desired_state="running",
        heartbeat={
            "controllers": {
                "w1": {
                    "at": (NOW - timedelta(seconds=20)).isoformat(),
                    "metrics": summary,
                }
            }
        },
        heartbeat_at=NOW - timedelta(seconds=20),
        backend=backend,
    )


class TestV1MachinesCount:
    def test_a_v1_machine_fills_its_gauges_by_backend(self) -> None:
        machine, agents = _v1_report()
        box = box_summary(
            {**machine, "gateway_agents": 3, "valve_memory": "failing"},
            [{"process": "running", "session": "parked", "restarts_10m": 4}],
            backend="box",
        )
        snap = snapshot_of(
            [_row("v1", "vm", box_summary(machine, agents)), _row("v2", "box", box)],
            NOW,
        )
        assert snap.agents == {
            ("vm", "running", "none"): 1,
            ("vm", "crashed", "none"): 1,
            ("box", "running", "parked"): 1,
        }
        assert snap.stopped[("vm", "crash_loop")] == 1
        assert snap.sessions_running == {"vm": 2, "box": 2}
        assert snap.sessions_max == {"vm": 8, "box": 8}
        assert snap.boxes_expected == snap.boxes_reporting == {"vm": 1, "box": 1}
        # The boxes-only gauges come from the box alone.
        assert (snap.restarts_10m, snap.gateway_agents) == (4, 3)
        assert snap.valve_memory["failing"] == 1
        assert list(snap.box_counts) == ["v2/w1"]

    @pytest.mark.parametrize("backend", ["vm", "box"])
    def test_a_woken_machine_is_not_expected_until_it_reports(
        self, backend: str
    ) -> None:
        """Waking a ready machine makes it prove itself again (`provisioning`),
        and it turns ready only when a status report arrives, in the same call
        that sets `heartbeat_at`. So a booting machine never counts as
        expected but silent."""
        from switch_core.db.models import CloudMachine
        from switch_core.db.stores.hosted_machine_store import CloudMachineStore

        machine = CloudMachine(
            id="m1",
            owner_id="u1",
            state="ready",
            desired_state="stopped",
            stop_reason="idle",
            revision=3,
            backend=backend,
        )
        CloudMachineStore().start(machine, NOW)
        row = MachineRow(
            id="m1",
            state=machine.state,
            desired_state=machine.desired_state,
            heartbeat=None,
            heartbeat_at=NOW - timedelta(hours=1),
            backend=backend,
        )
        snap = snapshot_of([row], NOW)
        assert (machine.state, machine.desired_state) == ("provisioning", "running")
        assert snap.boxes_expected == {"vm": 0, "box": 0}

    def test_a_machine_of_an_unknown_kind_is_left_out(self) -> None:
        machine, agents = _v1_report()
        snap = snapshot_of([_row("x", CANARY, box_summary(machine, agents))], NOW)
        assert snap.agents == {}
        assert snap.boxes_expected == {"vm": 0, "box": 0}

    def test_every_reading_obeys_the_catalogue_and_carries_no_text(
        self, registry: MetricsRegistry
    ) -> None:
        machine, agents = _v1_report()
        snap = snapshot_of([_row("v1", "vm", box_summary(machine, agents))], NOW)
        registry.register_observer(lambda: snapshot_readings(snap))
        points = _points(registry)
        assert ({"backend": "vm"}, 1.0) in points["switch.hosted.boxes_expected"]
        assert ({"kind": "running", "backend": "vm"}, 2.0) in points[
            "switch.hosted.sessions"
        ]
        # The boxes-only gauges carry no backend.
        assert all(a == {} for a, _ in points["switch.hosted.agent_restarts_10m"])
        assert CANARY not in json.dumps(points)


class TestRecorded:
    def test_memory_used_is_by_backend_and_a_strange_one_is_other(
        self, registry: MetricsRegistry
    ) -> None:
        machine, _ = _v1_report()
        record_box_report(machine, "vm")
        record_box_report(machine, CANARY)
        points = _points(registry)["switch.hosted.box_memory_used"]
        assert sorted(a["backend"] for a, _ in points) == ["other", "vm"]
        assert CANARY not in json.dumps(points)

    def test_a_refusal_is_by_reason_and_route_only(
        self, registry: MetricsRegistry
    ) -> None:
        record_credential_refusal("wrong", "hosted_controller")
        record_credential_refusal(CANARY, CANARY)
        points = _points(registry)["switch.controller.credential_refusals"]
        assert sorted((a["reason"], a["route"]) for a, _ in points) == [
            ("other", "other"),
            ("wrong", "hosted_controller"),
        ]


class TestMachineEvents:
    """`record_machine_event` listens on the async session's sync session, so
    a plain one stands in for it here, on an in-memory database."""

    def _session(self) -> Session:
        return Session(create_engine("sqlite://"))

    def test_counted_once_committed_with_fixed_words(
        self, registry: MetricsRegistry
    ) -> None:
        session = self._session()
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "failed", "never_connected", "vm")
            record_machine_event(wrapper, "woken", CANARY, "box")
            record_machine_event(wrapper, CANARY, "idle", CANARY)
            assert "switch.hosted.machine_events" not in _points(registry)
            session.commit()
        finally:
            session.close()
        points = _points(registry)["switch.hosted.machine_events"]
        assert sorted((a["event"], a["reason"], a["backend"]) for a, _ in points) == [
            ("failed", "never_connected", "vm"),
            ("other", "other", "other"),
            ("woken", "other", "box"),
        ]
        assert CANARY not in json.dumps(points)

    def test_never_counted_when_rolled_back(self, registry: MetricsRegistry) -> None:
        session = self._session()
        wrapper: Any = SimpleNamespace(sync_session=session)
        try:
            session.execute(text("SELECT 1"))
            record_machine_event(wrapper, "stopped", "owner", "vm")
            session.rollback()
        finally:
            session.close()
        assert "switch.hosted.machine_events" not in _points(registry)


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
        """Started at boot, so a reconciler that never calls still reads as
        silent, and the alert can fire."""
        now = [100.0]
        watch = ReconcilerWatch(clock=lambda: now[0])
        registry.register_observer(watch.readings)
        watch.start()
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


class TestMemoryOncePerMachine:
    def test_only_the_first_fresh_workspace_report_records_it(self) -> None:
        from switch_core.observability.hosted import reports_memory

        fresh = (NOW - timedelta(seconds=30)).isoformat()
        stale = (NOW - timedelta(minutes=10)).isoformat()
        reports = {"w1": {"at": fresh}, "w2": {"at": fresh}}
        assert reports_memory(reports, "w1", NOW)
        assert not reports_memory(reports, "w2", NOW)
        assert reports_memory({"w1": {"at": stale}, "w2": {"at": fresh}}, "w2", NOW)
        assert reports_memory({"w1": {"at": fresh}}, "w1", NOW)
