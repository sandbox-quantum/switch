"""Whether a server runs hosted agents: only with a box cluster, which its
hosted controller config names by carrying the box operator's own bearer
(`provisioner_token`). Without one, hosted agents are cleanly off: Core still
starts, every box route answers as absent, and nothing claims, starts or wakes
a cloud machine. A v1 cloud machine is never listed, prepared, observed,
started or woken, whatever the server has."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from switch_core import box_cluster
from switch_core.box_cluster import (
    box_cluster_configured,
    box_cluster_on,
    require_box_cluster,
    require_box_cluster_here,
    set_box_cluster,
)
from switch_core.gateway.cloud_controllers import wake_controller_machine
from switch_core.gateway.hosted_machines import V1_MACHINE_IN_THE_WAY
from switch_core.providers.hosted import (
    HostedControllerSettings,
    load_hosted_settings,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    HEADERS,
    controller_app,
    enrolled,
    machine_of,
    update_machine,
)

PROVISIONER = "p" * 32
# Any loaded keyed-id key: the gate asks only whether one is.
KEY = object()

# The keys today's production config documents: no box operator's bearer.
PROD_SHAPED = {
    "allowed_tenant_ids": ["workspace-1"],
    "token": "t" * 40,
    "agent_api_endpoint": "https://switch.example.com/api/agent",
}


def _settings(**extra: object) -> HostedControllerSettings:
    return HostedControllerSettings.model_validate({**PROD_SHAPED, **extra})


def test_no_config_means_no_box_cluster() -> None:
    assert box_cluster_configured(None, KEY) is False


def test_today_s_production_config_names_no_box_cluster() -> None:
    assert box_cluster_configured(_settings(), KEY) is False


def test_the_box_operator_s_bearer_names_one() -> None:
    assert box_cluster_configured(_settings(provisioner_token=PROVISIONER), KEY) is True


@pytest.mark.parametrize(
    "token", ["", "   ", "typo", "p" * 31, 12345, True, ["p" * 32]]
)
def test_an_empty_or_short_provisioner_token_names_none_and_still_loads(
    token: object, caplog: pytest.LogCaptureFixture
) -> None:
    """A typo in this one key turns hosted agents off, said once, and never
    stops the server."""
    caplog.set_level(logging.WARNING, logger="switch_core.providers.hosted")
    settings = _settings(provisioner_token=token)
    assert settings.provisioner_token is None
    assert box_cluster_configured(settings, KEY) is False
    assert any(
        "no box cluster is configured" in record.getMessage()
        for record in caplog.records
    )
    # Said once, and never the value itself.
    assert sum("no box cluster" in r.getMessage() for r in caplog.records) == 1
    assert str(token).strip() == "" or str(token) not in caplog.text


def test_a_short_token_on_a_settings_object_made_another_way_still_names_none() -> None:
    settings = HostedControllerSettings.model_construct(
        **PROD_SHAPED, provisioner_token="p" * 31
    )
    assert box_cluster_configured(settings, KEY) is False


def test_core_starts_with_today_s_production_config(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """The file today's servers mount loads, and hosted agents are off."""
    path = tmp_path / "controller.json"
    path.write_text(json.dumps(PROD_SHAPED))
    os.chmod(path, 0o600)
    settings = load_hosted_settings(str(path))
    assert settings is not None
    assert box_cluster_configured(settings, KEY) is False


def test_set_box_cluster_records_the_answer_and_says_so(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(box_cluster, "_process_on", False)
    caplog.set_level(logging.INFO, logger="switch_core.box_cluster")
    assert set_box_cluster(_settings(), KEY) is False
    assert box_cluster_on() is False
    assert "no box cluster is configured" in caplog.text
    assert set_box_cluster(_settings(provisioner_token=PROVISIONER), KEY) is True
    assert box_cluster_on() is True


def test_without_the_keyed_id_key_a_named_box_operator_is_not_enough(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The operator's views, actions and alerts name boxes and people only by
    keyed id: without the key, some alerts would quietly raise nothing, so
    hosted agents stay off, said once, and Core still starts."""
    monkeypatch.setattr(box_cluster, "_process_on", True)
    caplog.set_level(logging.WARNING, logger="switch_core.box_cluster")
    settings = _settings(provisioner_token=PROVISIONER)
    assert box_cluster_configured(settings, None) is False
    assert set_box_cluster(settings, None) is False
    assert box_cluster_on() is False
    assert "no keyed-id key is loaded" in caplog.text
    assert PROVISIONER not in caplog.text


def test_without_a_box_operator_a_missing_key_says_nothing_more(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger="switch_core.box_cluster")
    assert set_box_cluster(_settings(), None) is False
    assert "keyed-id" not in caplog.text


@pytest.mark.usefixtures("box_cluster_off")
@pytest.mark.parametrize("gate", [require_box_cluster, require_box_cluster_here])
async def test_without_one_every_box_route_answers_as_absent(gate) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(HTTPException) as refused:
        await gate()
    assert (refused.value.status_code, refused.value.detail) == (404, "Not Found")


@pytest.mark.parametrize("gate", [require_box_cluster, require_box_cluster_here])
async def test_with_one_the_gate_lets_it_through(gate) -> None:  # type: ignore[no-untyped-def]
    assert await gate() is None


# ---- a v1 cloud machine is refused, never acted on ----


async def _make_vm(app, **values) -> None:  # type: ignore[no-untyped-def]
    await update_machine(app.factory, app.machine_id, backend="vm", **values)


async def test_the_listing_never_names_a_v1_machine(controller_app) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app = controller_app
    await _make_vm(app)
    listed = await app.client.get("/hosted-controller/machines", headers=HEADERS)
    assert listed.status_code == 200, listed.text
    assert app.machine_id not in {m["machine_id"] for m in listed.json()["machines"]}


async def test_a_v1_machine_is_refused_its_boot_and_its_observations(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    app = controller_app
    await _make_vm(app, state="provisioning")
    before = await machine_of(app.factory, app.machine_id)
    prepared = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/prepare",
        headers=HEADERS,
        json={},
    )
    observed = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": before.revision},
    )
    assert (prepared.status_code, observed.status_code) == (409, 409)
    assert prepared.json()["detail"] == observed.json()["detail"]
    assert "retired" in prepared.json()["detail"]
    after = await machine_of(app.factory, app.machine_id)
    assert (after.state, after.desired_state, after.revision) == (
        before.state,
        before.desired_state,
        before.revision,
    )
    assert app.enrollment.minted == []


async def test_a_v1_machine_asleep_is_never_woken(controller_app) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    """A message to an agent on a v1 cloud machine wakes nothing."""
    app = controller_app
    controller_id, _ = await enrolled(app, agents=1)
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="idle")
    async with app.factory() as session:
        machine = await wake_controller_machine(
            session, controller_id, datetime.now(UTC), "message"
        )
        await session.commit()
    assert machine is not None and machine.backend == "vm"
    after = await machine_of(app.factory, app.machine_id)
    assert (after.desired_state, after.stop_reason) == ("stopped", "idle")


async def test_the_owner_can_t_start_a_v1_machine(controller_app) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app = controller_app
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="owner")
    revision = (await machine_of(app.factory, app.machine_id)).revision
    answered = await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": "start", "revision": revision},
    )
    assert answered.status_code == 409, answered.text
    after = await machine_of(app.factory, app.machine_id)
    assert after.desired_state == "stopped"


async def test_an_owner_with_a_v1_machine_is_given_no_box_over_it(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    """The v1 machine isn't claimed, joined or started, and no box is made
    over it until it is cleared away."""
    app = controller_app
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="idle")
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 503, answered.text
    assert answered.json()["detail"] == V1_MACHINE_IN_THE_WAY
    after = await machine_of(app.factory, app.machine_id)
    assert (after.backend, after.desired_state) == ("vm", "stopped")


@pytest.mark.usefixtures("box_cluster_off")
async def test_without_a_box_cluster_nobody_gets_a_machine_and_no_box_is_asked_for(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    """Today's production: hosted agents on and a launch capacity, but no box
    cluster. A person asking for their machine is told it's not available, and
    no box request is written."""
    from sqlalchemy import func, select

    from switch_core.db.audit import ServerAuditAction, ServerAuditEvent
    from switch_core.providers.hosted import NOT_AVAILABLE

    app = controller_app
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 503, answered.text
    assert answered.json()["detail"] == NOT_AVAILABLE
    async with app.factory() as session:
        asked = await session.scalar(
            select(func.count())
            .select_from(ServerAuditEvent)
            .where(ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_PROVISION)
        )
    assert asked == 0


# ---- boot and the gateway give one answer ----


def _boot_files(tmp_path, *, token: str | None, key: bool):  # type: ignore[no-untyped-def]
    from types import SimpleNamespace

    controller = tmp_path / "controller.json"
    config_json = dict(PROD_SHAPED)
    if token is not None:
        config_json["provisioner_token"] = token
    controller.write_text(json.dumps(config_json))
    os.chmod(controller, 0o600)
    key_path = None
    if key:
        key_file = tmp_path / "keyed-id.key"
        key_file.write_bytes(b"a-made-up-test-key-of-thirty-two-bytes-or-more")
        os.chmod(key_file, 0o400)
        key_path = str(key_file)
    return SimpleNamespace(
        hosted_controller_config_path=str(controller),
        visibility_keyed_id_key_path=key_path,
        visibility_keyed_id_key_version="k1",
    )


@pytest.mark.parametrize(
    ("token", "key", "on"),
    [
        (PROVISIONER, True, True),
        (None, True, False),
        (PROVISIONER, False, False),
        ("p" * 31, True, False),
    ],
)
def test_boot_and_the_gateway_give_the_same_answer(
    tmp_path, monkeypatch: pytest.MonkeyPatch, token, key, on
) -> None:  # type: ignore[no-untyped-def]
    """`main` asks before the gateway app is built; the gateway records its own
    answer from the files it loads. Both read the same files by the same rule."""
    from switch_core.box_cluster import box_cluster_at_boot
    from switch_core.visibility.dependencies import load_keyed_id_key

    monkeypatch.setattr(box_cluster, "_process_on", not on)
    config = _boot_files(tmp_path, token=token, key=key)
    at_boot = box_cluster_at_boot(config)
    # As the gateway does it (`create_gateway_app`).
    recorded = set_box_cluster(
        load_hosted_settings(config.hosted_controller_config_path),
        load_keyed_id_key(config),
    )
    assert at_boot is recorded is box_cluster_on() is on
