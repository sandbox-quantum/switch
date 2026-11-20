"""The hosted alerts through the operator's routes: the cluster report and the box facts.

The cluster report is strict, capped and never echoed, it's kept for the
Machines tab, and it decides the machine and service alerts. The observation
keeps the box's node, restarts and evictions, and status reports don't wipe
them.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest

from switch_core.db.models import CloudMachine
from switch_core.gateway.cloud_controllers import (
    record_controller_status,
    set_cloud_enrollment,
)
from switch_core.tenant_context import no_tenant
from switch_core.visibility.alerts import Condition, open_alerts
from switch_core.visibility.cluster_report import (
    forget_cluster_report,
    latest_cluster_report,
)
from tests.switch_core.gateway.test_cloud_controller_machines import (
    HEADERS,
    _claim,
    _hosted_app,
    _machine,
)
from tests.switch_core.hosted_machine_helpers import link_controller
from tests.switch_core.management.harness import Harness, add_member, build_harness

CANARY = "CANARY-77c0-do-not-echo"


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    set_cloud_enrollment(None)
    forget_cluster_report()
    yield
    set_cloud_enrollment(None)
    forget_cluster_report()


@pytest.fixture
def harness(session_factory) -> Harness:
    return build_harness(session_factory)


def _report(**overrides: object) -> dict:
    body: dict[str, object] = {
        "nodes": [
            {
                "name": "ip-10-0-1-7",
                "zone": "eu-west-2a",
                "memory_used_pct": 91.0,
                "memory_booked_pct": 70.0,
                "gate": "passed",
                "held_minutes": 0,
            }
        ],
        "services": [
            {"name": "coredns", "ready": 1, "wanted": 2, "short_seconds": 180}
        ],
    }
    body.update(overrides)
    return body


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_report_is_kept_and_decides_its_alerts(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _hosted_app(harness.session_factory, owner) as hosted:
        response = await hosted.post(
            "/hosted-controller/cluster", json=_report(), headers=HEADERS
        )
    assert response.status_code == 200, response.text
    held = latest_cluster_report()
    assert held is not None and held.report.nodes[0].name == "ip-10-0-1-7"
    with no_tenant():
        async with harness.session_factory() as session:
            current = {(a.condition, a.target_id) for a in await open_alerts(session)}
    assert current == {
        (Condition.MACHINE_MEMORY, "ip-10-0-1-7"),
        (Condition.SERVICE_SHORT, "coredns"),
    }


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_bad_report_is_refused_without_echoing_it(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "grace")
    async with _hosted_app(harness.session_factory, owner) as hosted:
        extra = await hosted.post(
            "/hosted-controller/cluster",
            json=_report(nodes=[{**_report()["nodes"][0], "note": CANARY}]),  # type: ignore[index]
            headers=HEADERS,
        )
        unlisted = await hosted.post(
            "/hosted-controller/cluster",
            json=_report(services=[{"name": "postgres", "ready": 0, "wanted": 1}]),
            headers=HEADERS,
        )
        huge = await hosted.post(
            "/hosted-controller/cluster",
            content=json.dumps(_report()) + " " * 70_000,
            headers={**HEADERS, "content-type": "application/json"},
        )
        unauthenticated = await hosted.post(
            "/hosted-controller/cluster", json=_report()
        )
    assert extra.status_code == 422 and CANARY not in extra.text
    assert unlisted.status_code == 422 and "postgres" not in unlisted.text
    assert huge.status_code == 413
    assert unauthenticated.status_code == 401
    assert latest_cluster_report() is None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_box_facts_are_kept_and_status_reports_leave_them(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "lin")
    machine = await _claim(harness.session_factory, owner)
    async with _hosted_app(harness.session_factory, owner) as hosted:
        response = await hosted.post(
            f"/hosted-controller/machines/{machine.id}/observation",
            json={
                "state": "provisioning",
                "revision": machine.revision,
                "node": "ip-10-0-1-7",
                "restarts": 2,
                "evictions": 1,
            },
            headers=HEADERS,
        )
        assert response.status_code == 200, response.text
        # Ahead of Core's revision: the observation is ignored, the box facts aren't.
        ahead = await hosted.post(
            f"/hosted-controller/machines/{machine.id}/observation",
            json={"state": "running", "revision": machine.revision + 5, "restarts": 1},
            headers=HEADERS,
        )
        assert ahead.status_code == 200, ahead.text
    stored = (await _machine(harness.session_factory, machine.id)).heartbeat
    assert stored is not None
    assert stored["box"]["node"] == "ip-10-0-1-7"
    assert stored["box"]["restarts_today"] == 3
    assert len(stored["box"]["eviction_times"]) == 1
    # A status report rebuilds the heartbeat's own keys and keeps `box`.
    async with harness.session_factory() as session:
        row = await session.get(CloudMachine, machine.id)
        assert row is not None
        controller = await link_controller(session, row)
        await record_controller_status(
            session,
            controller.id,
            {
                "disk_free_bytes": 10,
                "disk_total_bytes": 20,
                "mem_free_bytes": 1024,
                "mem_total_bytes": 4096,
                "sessions_running": 1,
                "sessions_max": 4,
            },
            [],
        )
        await session.commit()
    kept = (await _machine(harness.session_factory, machine.id)).heartbeat
    assert kept is not None
    assert kept["memory"] == {"total_bytes": 4096, "available_bytes": 1024}
    assert kept["box"]["restarts_today"] == 3
    assert kept["box"]["node"] == "ip-10-0-1-7"
