"""The box cluster's network reports, and each box's usage, as security events.
Against Postgres."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from pydantic import SecretStr

from switch_core.gateway import hosted_controller
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.hosted_network import router as network_router
from switch_core.logging_context import structured_fields
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.security_events import LOGGER_NAME
from switch_core.visibility.dependencies import set_process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKind
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    controller_app,
    observe,
    update_machine,
)
from tests.switch_core.gateway.test_hosted_provisioner import (
    KEY,
    PROVISIONER,
    TOKEN,
    _bearer,
    _owner_and_machine,
)

NETWORK = "SYNTHETIC-NETWORK-REPORTER-CREDENTIAL-0123456789"


@pytest.fixture
async def network_app(session_factory):
    owner, machine_id = await _owner_and_machine(session_factory, email="e@example.com")
    settings = HostedControllerSettings(
        allowed_tenant_ids=["*"],
        allowed_user_ids=["*"],
        token=TOKEN,
        provisioner_token=PROVISIONER,
        network_report_token=NETWORK,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.include_router(network_router)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    set_process_keyed_id_key(KEY)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://switch.example.com",
        ) as client:
            yield SimpleNamespace(
                client=client, machine_id=machine_id, owner=owner, settings=settings
            )
    finally:
        set_process_keyed_id_key(None)


def _box(squid_id: str, **totals) -> dict:
    return {
        "box": squid_id,
        "requests": 3,
        "denied": 1,
        "categories": {
            "ours": {"requests": 1, "policy": "block"},
            "malware": {"requests": 2, "policy": "block"},
            "miners": {"requests": 4, "policy": "watch"},
            "cdn": {"requests": 7, "policy": "allow"},
        },
        "bytes_up": 1200,
        "bytes_down": 50_000,
        "distinct_hosts": 25,
        "hosts": [
            {
                "host": "h-0000aaaa",
                "requests": 2,
                "denied": 0,
                "bytes_up": 1000,
                "bytes_down": 49_000,
            },
            {
                "host": "h-0000bbbb",
                "requests": 1,
                "denied": 1,
                "bytes_up": 200,
                "bytes_down": 1000,
            },
        ],
        **totals,
    }


def _logged(caplog, action: str) -> list[tuple[dict, dict]]:
    return [
        (
            structured_fields(record)["switch"],
            structured_fields(record)["security_details"],
        )
        for record in caplog.records
        if record.name == LOGGER_NAME
        and structured_fields(record)["switch"]["action"] == action
    ]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_one_line_per_box_names_its_machine_owner_and_busiest_hosts(
    network_app, caplog
) -> None:
    app = network_app
    by_box = "box-" + KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)
    by_owner = KEY.keyed_id(KeyedIdKind.USER, app.owner.id)
    unknown = "box-k1-0000000000000000"
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    sent = await app.client.post(
        "/hosted-network/report",
        headers=_bearer(NETWORK),
        json={
            "window_seconds": 60,
            "boxes": [_box(by_box), _box(by_owner), _box(unknown)],
            "unattributed_requests": 4,
        },
    )
    assert sent.status_code == 204, sent.text
    lines = _logged(caplog, "hosted.box_network")
    assert len(lines) == 3
    for (event, details), squid_id in zip(lines, [by_box, by_owner, unknown]):
        assert details["box"] == squid_id
        assert event["target_type"] == "cloud_machine"
        assert details["distinct_hosts"] == 25 and details["other_hosts"] == 23
        assert json.loads(details["categories"])["miners"] == {
            "requests": 4,
            "policy": "watch",
        }
        assert (details["blocked_total"], details["watched_total"]) == (3, 4)
        assert [h["host"] for h in json.loads(details["hosts"])] == [
            "h-0000aaaa",
            "h-0000bbbb",
        ]
    # Both squid id forms resolve to the machine and its owner; an unknown box is logged by its id alone.
    assert [(e["target_id"], e["actor_user_id"]) for e, _ in lines] == [
        (app.machine_id, app.owner.id),
        (app.machine_id, app.owner.id),
        (None, None),
    ]
    [(_, gap)] = _logged(caplog, "hosted.box_network_unattributed")
    assert gap["requests"] == 4


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_reporter_has_its_own_bearer_and_its_limits(network_app) -> None:
    app = network_app
    body = {"window_seconds": 60, "boxes": []}
    for bearer in (TOKEN, PROVISIONER, "nope"):
        refused = await app.client.post(
            "/hosted-network/report", headers=_bearer(bearer), json=body
        )
        assert refused.status_code == 401
    too_many = _box("box-k1-0000000000000000")
    too_many["hosts"] = too_many["hosts"] * 6
    assert (
        await app.client.post(
            "/hosted-network/report",
            headers=_bearer(NETWORK),
            json={"window_seconds": 60, "boxes": [too_many]},
        )
    ).status_code == 422
    app.settings.network_report_token = None
    assert (
        await app.client.post(
            "/hosted-network/report", headers=_bearer(NETWORK), json=body
        )
    ).status_code == 401
    with pytest.raises(ValueError, match="separate identity"):
        HostedControllerSettings(
            allowed_tenant_ids=None,
            token=TOKEN,
            network_report_token=SecretStr(TOKEN),
            agent_api_endpoint="https://switch.example.com/api/agent",
        )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_boxs_usage_is_logged_at_most_once_a_minute(
    controller_app,  # noqa: F811
    caplog,
    monkeypatch,
) -> None:
    app = controller_app
    await update_machine(app.factory, app.machine_id, state="provisioning", revision=1)
    hosted_controller._usage_logged_at.clear()
    clock = iter([1000.0, 1030.0, 1061.0])
    monkeypatch.setattr(hosted_controller, "_monotonic", lambda: next(clock))
    usage = {
        "cpu_millicores": 2900,
        "memory_bytes": 1 << 30,
        "cpu_limit_millicores": 3000,
        "memory_limit_bytes": 4 << 30,
    }
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    for _ in range(3):
        await observe(
            app.client, app.machine_id, state="running", revision=1, usage=usage
        )
    lines = _logged(caplog, "hosted.box_usage")
    assert len(lines) == 2  # the one 30 s after the first is skipped
    event, details = lines[0]
    assert event["target_id"] == app.machine_id
    assert details["cpu_ratio"] == 0.967 and details["memory_ratio"] == 0.25
