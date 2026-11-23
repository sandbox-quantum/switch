"""The operator overview's read views: the pure pieces (box state, memory band, restarts, node,
and the cluster report's shape). No database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from switch_core.visibility import cluster_report
from switch_core.visibility.read_views import (
    AwakeCount,
    agent_bucket,
    box_awake,
    box_disk,
    box_node,
    box_state,
    memory_band,
    memory_total_bytes,
    memory_used_bytes,
    restarts_today,
)

GIB = 1024**3


def _box(state="ready", stop_reason=None, heartbeat=None) -> SimpleNamespace:
    # A stopped box is one asked to stop; any other is asked to run.
    desired = "stopped" if state == "stopped" else "running"
    return SimpleNamespace(
        state=state, stop_reason=stop_reason, heartbeat=heartbeat, desired_state=desired
    )


def _memory(total: int, used: int) -> dict:
    return {"memory": {"total_bytes": total, "available_bytes": total - used}}


@pytest.mark.parametrize(
    ("state", "stop_reason", "shown"),
    [
        ("ready", None, "running"),
        ("queued", None, "starting"),
        ("provisioning", None, "starting"),
        ("stopping", None, "stopping"),
        ("stopped", "idle", "resting"),
        ("stopped", "owner", "stopped"),
        ("stopped", "paused", "paused"),
        ("error", None, "error"),
        ("retained", None, "retired"),
        ("deleting", None, "retired"),
    ],
)
def test_box_state_names_every_lifecycle_state(state, stop_reason, shown) -> None:
    assert box_state(_box(state, stop_reason)) == shown  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("used_pct", "band"),
    [
        (0, "low"),
        (49.9, "low"),
        (50, "medium"),
        (80, "medium"),
        (80.1, "high"),
        (100, "high"),
    ],
)
def test_memory_band_boundaries(used_pct, band) -> None:
    total = 1000 * GIB
    box = _box(heartbeat=_memory(total, int(total * used_pct / 100)))
    assert memory_band(box) == band  # type: ignore[arg-type]


def test_memory_band_is_a_dash_without_a_running_box_or_a_reading() -> None:
    assert memory_band(_box("stopped", "idle", _memory(GIB, GIB // 2))) is None  # type: ignore[arg-type]
    assert memory_band(_box(heartbeat=None)) is None  # type: ignore[arg-type]
    assert (
        memory_band(
            _box(heartbeat={"memory": {"total_bytes": 0, "available_bytes": 0}})
        )
        is None
    )  # type: ignore[arg-type]
    assert memory_band(_box(heartbeat={"memory": "nonsense"})) is None  # type: ignore[arg-type]


def test_memory_used_is_clamped_to_the_limit() -> None:
    box = _box(heartbeat={"memory": {"total_bytes": 10, "available_bytes": -5}})
    assert memory_used_bytes(box) == 10  # type: ignore[arg-type]


def test_restarts_today_counts_only_today_utc() -> None:
    now = datetime(2026, 10, 29, 12, tzinfo=UTC)
    today = {"box": {"day": "2026-10-29", "restarts_today": 3}}
    yesterday = {"box": {"day": "2026-10-28", "restarts_today": 7}}
    assert restarts_today(_box(heartbeat=today), now) == 3  # type: ignore[arg-type]
    assert restarts_today(_box(heartbeat=yesterday), now) == 0  # type: ignore[arg-type]
    assert restarts_today(_box(heartbeat={}), now) is None  # type: ignore[arg-type]
    bad = {"box": {"day": "2026-10-29", "restarts_today": "lots"}}
    assert restarts_today(_box(heartbeat=bad), now) is None  # type: ignore[arg-type]


def test_a_node_name_is_shown_only_when_it_is_a_kubernetes_name() -> None:
    assert box_node(
        _box(heartbeat={"box": {"node": "ip-10-0-2-107.eu-west-3.compute.internal"}})
    ) == (  # type: ignore[arg-type]
        "ip-10-0-2-107.eu-west-3.compute.internal"
    )
    for bad in ("Has Spaces", "x" * 300, "<script>", 7, None):
        assert box_node(_box(heartbeat={"box": {"node": bad}})) is None  # type: ignore[arg-type]


def _report(**node_fields) -> dict:
    node = {
        "name": "ip-10-0-0-1",
        "zone": "eu-west-3a",
        "gate": "passed",
        **node_fields,
    }
    return {"nodes": [node], "services": [{"name": "squid", "ready": 1, "wanted": 1}]}


def test_the_cluster_report_takes_fixed_fields_only() -> None:
    ok = cluster_report.ClusterReport.model_validate(
        _report(memory_used_pct=86.5, memory_booked_pct=84.0)
    )
    assert ok.nodes[0].memory_used_pct == 86.5
    for bad in (
        _report(memory_used_pct=101),
        _report(gate="maybe"),
        _report(name="Not A Node"),
        _report(note="free text from the cluster"),
        {**_report(), "extra": 1},
    ):
        with pytest.raises(ValidationError):
            cluster_report.ClusterReport.model_validate(bad)


UID = "0f6c2a1e-6c8b-4d4e-9a57-3b2f1d0c9e8a"


def test_a_node_uid_is_optional_and_only_in_kubernetes_form() -> None:
    """A drain is pinned to the node's uid. It's
    optional, so an operator that doesn't send it yet keeps reporting; when
    sent, only the API server's own form is accepted."""
    with_uid = cluster_report.ClusterReport.model_validate(_report(uid=UID))
    assert with_uid.nodes[0].uid == UID
    assert cluster_report.ClusterReport.model_validate(_report()).nodes[0].uid is None
    for bad in (
        UID.upper(),
        UID.replace("-", ""),
        UID + "0",
        "not-a-uid",
        "",
        "0f6c2a1e-6c8b-4d4e-9a57-3b2f1d0c9e8a\n",
        7,
    ):
        with pytest.raises(ValidationError):
            cluster_report.ClusterReport.model_validate(_report(uid=bad))


def test_the_latest_report_is_kept_and_can_be_forgotten() -> None:
    cluster_report.forget_cluster_report()
    assert cluster_report.latest_cluster_report() is None
    at = datetime.now(UTC) - timedelta(minutes=5)
    report = cluster_report.ClusterReport.model_validate(_report())
    cluster_report.keep_cluster_report(report, now=at)
    held = cluster_report.latest_cluster_report()
    assert held is not None and held.received_at == at and held.report == report
    cluster_report.forget_cluster_report()


def test_the_members_answer_carries_no_hosted_field() -> None:
    """`GET /tenants/{id}/members` is open to any member,
    so the hosted on/off value and box state live only in the admin-only
    `hosted-people` route, never in the members answer."""
    from switch_core.gateway.schemas import MemberDetail

    hosted = {"hosted", "agents", "box_state", "memory_band", "last_active_at"}
    assert hosted.isdisjoint(MemberDetail.model_fields)


@pytest.mark.parametrize(
    ("agent", "box_state_", "bucket"),
    [
        ({"process": "running", "session": "active"}, ("ready", None), "idle"),
        (
            {"process": "running", "session": "active", "busy": True},
            ("ready", None),
            "working",
        ),
        (
            {"process": "running", "session": "active", "busy": "yes"},
            ("ready", None),
            "idle",
        ),
        (
            {"process": "running", "session": "parked", "busy": True},
            ("ready", None),
            "resting",
        ),
        ({"process": "running", "session": "waking"}, ("ready", None), "idle"),
        ({"process": "running", "session": "parked"}, ("ready", None), "resting"),
        ({"process": "running", "session": "active"}, ("stopped", "idle"), "resting"),
        ({"process": "crashed", "reason": "x"}, ("ready", None), "unavailable"),
        ({"process": "failed", "reason": "x"}, ("stopped", "idle"), "unavailable"),
        ({}, ("ready", None), "idle"),
        (
            {"process": "running", "session": "parked"},
            ("stopped", "paused"),
            "unavailable",
        ),
    ],
)
def test_agent_buckets_for_the_overview(agent, box_state_, bucket) -> None:
    box = _box(*box_state_)
    assert agent_bucket(agent, box) == bucket  # type: ignore[arg-type]


def test_a_paused_owner_s_agents_are_unavailable_whatever_the_box_says() -> None:
    running = _box("ready")
    busy = {"process": "running", "session": "active", "busy": True}
    assert agent_bucket(busy, running) == "working"  # type: ignore[arg-type]
    assert agent_bucket(busy, running, owner_paused=True) == "unavailable"  # type: ignore[arg-type]
    resting = _box("stopped", "idle")
    assert agent_bucket({}, resting, owner_paused=True) == "unavailable"  # type: ignore[arg-type]


# --- each box's capacity on the operator's overview ---------------------------------------------


def test_memory_total_comes_from_the_same_reading_as_used() -> None:
    assert memory_total_bytes(_box(heartbeat=_memory(4 * GIB, GIB))) == 4 * GIB
    assert memory_total_bytes(_box(heartbeat=None)) is None
    # A reading memory_used_bytes refuses gives no total either.
    assert memory_total_bytes(_box(heartbeat={"memory": {"total_bytes": 0}})) is None


@pytest.mark.parametrize(
    "memory",
    [
        {"used_bytes": GIB, "available_bytes": GIB},
        {"total_bytes": True, "available_bytes": 0},
        {"total_bytes": "4", "available_bytes": 0},
        "not a reading",
    ],
)
def test_memory_total_is_null_for_a_reading_out_of_shape(memory) -> None:
    # Never a KeyError (which would 500 the whole overview), never a bool.
    assert memory_total_bytes(_box(heartbeat={"memory": memory})) is None


NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)


def test_awake_adds_up_each_controller_and_keeps_the_box_s_limit() -> None:
    reports = [
        {"machine": {"sessions_running": 2, "sessions_max": 12}},
        {"machine": {"sessions_running": 1, "sessions_max": 12}},
    ]
    assert box_awake(reports, NOW) == AwakeCount(running=3, max=12)


@pytest.mark.parametrize(
    "reports",
    [
        [],
        [{"agents": []}],
        [{"machine": {"sessions_running": 2}}],
        [{"machine": {"sessions_running": -1, "sessions_max": 12}}],
        [{"machine": {"sessions_running": True, "sessions_max": 12}}],
    ],
)
def test_awake_is_null_without_a_sound_report(reports) -> None:
    assert box_awake(reports, NOW) is None


# --- each box's disk on the operator's overview ------------------------------------------------


def _disk(**reading) -> SimpleNamespace:
    return _box(heartbeat={"disk": reading})


def test_disk_keeps_the_scope_the_box_sent() -> None:
    disk = box_disk(
        _disk(total_bytes=15 * GIB, available_bytes=12 * GIB, scope="workspace")
    )
    assert disk is not None
    assert (disk.total_bytes, disk.available_bytes, disk.scope) == (
        15 * GIB,
        12 * GIB,
        "workspace",
    )
    older = box_disk(_disk(total_bytes=8 * GIB, available_bytes=GIB))
    assert older is not None and older.scope is None
    odd = box_disk(_disk(total_bytes=8 * GIB, available_bytes=GIB, scope="<b>x</b>"))
    assert odd is not None and odd.scope is None


@pytest.mark.parametrize(
    "heartbeat",
    [
        None,
        {"disk": None},
        {"disk": "full"},
        {"disk": {"total_bytes": 0, "available_bytes": 0, "scope": "workspace"}},
        {"disk": {"total_bytes": 10, "available_bytes": 11}},
        {"disk": {"total_bytes": True, "available_bytes": 0}},
        {"disk": {"available_bytes": 5}},
    ],
)
def test_disk_is_null_for_a_reading_out_of_shape(heartbeat) -> None:
    assert box_disk(_box(heartbeat=heartbeat)) is None
