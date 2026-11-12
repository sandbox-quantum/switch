"""The hosted metrics, through Core's real routes.

A hosted box's status report leaves a summary of counts beside it, and the
memory histograms; a laptop's report leaves nothing; and the operator's
evictions are counted. A canary in every text field of the report must not
reach the stored summary or any metric.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.switch_core.gateway.test_cloud_controller_machines import (
    HEADERS,
    _claim,
    _enroll,
    _hosted_app,
    _machine,
    _prepare,
    _update,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    build_harness,
    enroll_daemon,
    report_status,
)

CANARY = "CANARY-91be-do-not-export"


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Iterator[None]:
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
def harness(session_factory) -> Harness:
    return build_harness(session_factory)


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _canary_agents() -> list[dict]:
    return [
        {
            "agent_id": "00000000-0000-4000-8000-0000000000a1",
            "applied_revision": 1,
            "process": "running",
            "attached": True,
            "sessions": {"active": 1, "ids": ["00000000-0000-4000-8000-0000000000e1"]},
            "session": "active",
            "restarts_10m": 1,
            "oom_kills": 0,
            "directory": f"/work/{CANARY}",
            "since": "2026-10-29T11:00:00Z",
            "detail": CANARY,
            CANARY: CANARY,
        },
        {
            "agent_id": "00000000-0000-4000-8000-0000000000a2",
            "applied_revision": 1,
            "process": "stopped",
            "attached": False,
            "sessions": {"active": 0, "ids": []},
            "restarts_10m": 0,
            "oom_kills": 0,
            "directory": None,
            "since": "2026-10-29T11:00:00Z",
            "reason": "out_of_memory",
            "detail": CANARY,
        },
    ]


def _names(registry: MetricsRegistry) -> dict[str, list]:
    out: dict[str, list] = {}
    for payload in registry.collect():
        out[payload.name] = [*payload.numbers, *payload.histograms]
    return out


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_hosted_box_report_leaves_counts_only(
    harness: Harness, registry: MetricsRegistry
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    machine = await _claim(harness.session_factory, owner)
    async with _hosted_app(harness.session_factory, owner) as hosted:
        code = (await _prepare(hosted, machine.id))["controllers"][0]["enrollment_code"]
        async with harness.client() as client:
            enrolled = await _enroll(client, code)
            token = await client.post(
                f"/v1/management/controllers/{enrolled['controller_id']}/token",
                json={"credential": enrolled["credential"]},
            )
            controller = SimpleNamespace(
                controller_id=enrolled["controller_id"],
                credential=enrolled["credential"],
                access_token=token.json()["access_token"],
                owner=owner,
                harness=harness,
                headers=bearer(token.json()["access_token"]),
            )
            # A v2 box: the box-only counts are kept for a box only.
            await _update(
                harness.session_factory,
                machine.id,
                running_observed_at=datetime.now(UTC),
                backend="box",
            )
            response = await report_status(
                client,
                controller,  # type: ignore[arg-type]
                1,
                agents=_canary_agents(),
            )
            assert response.status_code == 200, response.text

    stored = (await _machine(harness.session_factory, machine.id)).heartbeat
    assert stored is not None
    [report] = stored["controllers"].values()
    summary = report["metrics"]
    # Neither agent is placed on this controller, so Core drops their session
    # state before storing (a box may only set its own agents' states).
    assert summary["agents"] == {"running:none": 1, "stopped:none": 1}
    assert summary["stopped"]["out_of_memory"] == 1
    assert summary["restarts_10m"] == 1
    assert CANARY not in json.dumps(stored)
    assert "00000000-0000-4000-8000" not in json.dumps(summary)

    names = _names(registry)
    assert "switch.hosted.box_memory_used" in names
    assert CANARY not in json.dumps([str(p) for p in names.values()])


async def test_a_laptop_report_is_never_counted(
    harness: Harness, registry: MetricsRegistry
) -> None:
    owner = await add_member(harness.session_factory, "grace")
    async with harness.client() as client:
        laptop = await enroll_daemon(harness, client, owner)
        response = await report_status(client, laptop, 1, agents=_canary_agents())
        assert response.status_code == 200, response.text
    names = _names(registry)
    assert not [name for name in names if name.startswith("switch.hosted.")]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_since_start_counts_must_be_bounded_ints(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "lin")
    async with harness.client() as client:
        laptop = await enroll_daemon(harness, client, owner)
        from tests.switch_core.management.harness import ensure_connected, status_report

        await ensure_connected(client, laptop)
        for bad in ("12", -1, 1_000_001, 1.5, True):
            body = status_report(2)
            body["machine"]["guard_stops"] = bad
            refused = await client.put(
                f"/v1/management/controllers/{laptop.controller_id}/status",
                json=body,
                headers=laptop.headers,
            )
            assert refused.status_code in (400, 422), (bad, refused.text)
        body = status_report(3)
        body["machine"]["guard_stops"] = 4
        body["machine"]["valve_parks"] = 0
        accepted = await client.put(
            f"/v1/management/controllers/{laptop.controller_id}/status",
            json=body,
            headers=laptop.headers,
        )
        assert accepted.status_code == 200, accepted.text


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_operators_evictions_are_counted(
    harness: Harness, registry: MetricsRegistry
) -> None:
    owner = await add_member(harness.session_factory, "kim")
    machine = await _claim(harness.session_factory, owner)
    async with _hosted_app(harness.session_factory, owner) as hosted:
        response = await hosted.post(
            f"/hosted-controller/machines/{machine.id}/observation",
            json={
                "state": "provisioning",
                "revision": machine.revision,
                "evictions": 2,
            },
            headers=HEADERS,
        )
        assert response.status_code == 200, response.text
    [point] = _names(registry)["switch.hosted.box_evictions"]
    assert point.value == 2.0
    assert dict(point.attributes) == {}
