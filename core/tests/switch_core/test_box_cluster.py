"""Whether a server runs hosted agents: only with a box cluster, which its
hosted controller config names by carrying the box operator's own bearer
(`provisioner_token`). Without one, hosted agents are cleanly off: Core still
starts, every box route answers as absent, and no box is claimed. Hosted
agents v1 is frozen: its machines are listed, prepared, observed, started and
woken as before, with or without a box cluster, but nothing makes a new one."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from switch_core import box_cluster
from switch_core.box_cluster import (
    box_cluster_configured,
    box_cluster_on,
    require_box_cluster,
    require_box_cluster_here,
    set_box_cluster,
)
from switch_core.db.models import CloudMachine
from switch_core.gateway.cloud_controllers import wake_controller_machine
from switch_core.gateway.hosted_machines import BOXES_NOT_YET
from switch_core.providers.hosted import (
    HostedControllerSettings,
    load_hosted_settings,
)
from switch_core.visibility.reason_codes import StopReason
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


# ---- v1 is frozen: existing v1 machines keep working, no new one is made ----


async def _make_vm(app, **values) -> None:  # type: ignore[no-untyped-def]
    await update_machine(app.factory, app.machine_id, backend="vm", **values)


def _claim_settings(app) -> None:  # type: ignore[no-untyped-def]
    """What `ensure` reads of the config beyond the fixture's."""
    app.config.hosted_launch_capacity_per_workspace = 0
    app.config.hosted_pool_size = 0
    app.config.hosted_provisions_per_minute = 5
    app.config.hosted_box_ceiling = 50


async def _no_machine(app) -> None:  # type: ignore[no-untyped-def]
    """The fixture's owner with no live machine: its row deleted."""
    await update_machine(
        app.factory, app.machine_id, state="deleted", desired_state="deleted"
    )


@pytest.mark.parametrize("cluster", [True, False])
async def test_a_v1_machine_is_listed_prepared_and_observed_as_today(
    controller_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    cluster: bool,
) -> None:  # type: ignore[no-untyped-def]
    """The v1 controller still manages its machines, with a box cluster or
    without one (today's production): listed with its backend, a code to enrol
    with, and its observations taken."""
    monkeypatch.setattr(box_cluster, "_process_on", cluster)
    app = controller_app
    await _make_vm(app, state="queued")
    listed = await app.client.get("/hosted-controller/machines", headers=HEADERS)
    assert listed.status_code == 200, listed.text
    (item,) = [
        m for m in listed.json()["machines"] if m["machine_id"] == app.machine_id
    ]
    assert item["backend"] == "vm" and "box_expected" not in item
    prepared = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/prepare",
        headers=HEADERS,
        json={},
    )
    assert prepared.status_code == 200, prepared.text
    (entry,) = prepared.json()["controllers"]
    assert entry["enrollment_code"]
    revision = (await machine_of(app.factory, app.machine_id)).revision
    observed = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/observation",
        headers=HEADERS,
        json={"state": "running", "revision": revision},
    )
    assert observed.status_code == 200, observed.text
    assert (await machine_of(app.factory, app.machine_id)).state == "provisioning"
    pooled = await app.client.get("/hosted-controller/pool", headers=HEADERS)
    assert pooled.status_code == (200 if cluster else 404)


async def test_a_v1_machine_s_code_is_reused_for_its_revision_as_before(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    app = controller_app
    await _make_vm(app, state="queued")
    first, again = [
        await app.client.post(
            f"/hosted-controller/machines/{app.machine_id}/prepare",
            headers=HEADERS,
            json={},
        )
        for _ in range(2)
    ]
    code = first.json()["controllers"][0]["enrollment_code"]
    assert again.json()["controllers"][0]["enrollment_code"] == code
    app.enrollment.dead.add(code)
    third = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/prepare",
        headers=HEADERS,
        json={},
    )
    # A box would get a fresh one; a v1 machine's stored code stands, as before.
    assert third.json()["controllers"][0]["enrollment_code"] == code
    assert app.enrollment.retired == []


@pytest.mark.usefixtures("box_cluster_off")
async def test_a_v1_machine_asleep_is_woken_by_a_message(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
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
    assert after.desired_state == "running"


@pytest.mark.usefixtures("box_cluster_off")
async def test_the_owner_can_start_their_v1_machine(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    app = controller_app
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="owner")
    revision = (await machine_of(app.factory, app.machine_id)).revision
    answered = await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": "start", "revision": revision},
    )
    assert answered.status_code == 200, answered.text
    assert (await machine_of(app.factory, app.machine_id)).desired_state == "running"


@pytest.mark.parametrize("cluster", [True, False])
async def test_a_person_with_a_v1_machine_is_served_by_it_never_a_box(
    controller_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    cluster: bool,
) -> None:  # type: ignore[no-untyped-def]
    """Their v1 machine is started again; no box and no second machine. With
    the cloud-machine user list unset it still serves them, as before boxes."""
    monkeypatch.setattr(box_cluster, "_process_on", cluster)
    app = controller_app
    _claim_settings(app)
    app.settings.allowed_user_ids = None
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="idle")
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 200, answered.text
    after = await machine_of(app.factory, app.machine_id)
    assert (after.backend, after.desired_state) == ("vm", "running")
    async with app.factory() as session:
        rows = (
            await session.scalars(
                select(CloudMachine).where(CloudMachine.owner_id == app.owner_id)
            )
        ).all()
    assert [m.id for m in rows] == [app.machine_id]


async def test_without_a_v1_machine_a_person_gets_a_box(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    """Their deleted v1 machine is never made again: they get a box."""
    app = controller_app
    _claim_settings(app)
    await _make_vm(app)
    await _no_machine(app)
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 200, answered.text
    async with app.factory() as session:
        live = (
            await session.scalars(
                select(CloudMachine).where(
                    CloudMachine.owner_id == app.owner_id,
                    CloudMachine.state != "deleted",
                )
            )
        ).all()
    assert [m.backend for m in live] == ["box"]


@pytest.mark.usefixtures("box_cluster_off")
async def test_without_a_box_cluster_a_person_with_no_v1_machine_gets_nothing(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    """Today's production: a person with no v1 machine is told hosted agents
    aren't available yet, no machine is made, and no box is asked for."""
    from switch_core.db.audit import ServerAuditAction, ServerAuditEvent

    app = controller_app
    _claim_settings(app)
    await _no_machine(app)
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 503, answered.text
    assert answered.json()["detail"] == BOXES_NOT_YET
    listed = await app.client.get("/hosted-machines")
    assert listed.json()["available"] is False
    async with app.factory() as session:
        made = await session.scalar(
            select(func.count())
            .select_from(CloudMachine)
            .where(
                CloudMachine.owner_id == app.owner_id, CloudMachine.state != "deleted"
            )
        )
        asked = await session.scalar(
            select(func.count())
            .select_from(ServerAuditEvent)
            .where(ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_PROVISION)
        )
    assert (made, asked) == (0, 0)


async def test_v1_machines_take_no_box_capacity(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    """`hosted_launch_capacity` and the per-workspace limit count boxes only:
    a server full of v1 machines still makes a box."""
    from switch_core.db.models import User
    from tests.switch_core.hosted_machine_helpers import seed_machine

    app = controller_app
    _claim_settings(app)
    app.config.hosted_launch_capacity = 1
    app.config.hosted_launch_capacity_per_workspace = 1
    async with app.factory() as session:
        for name in ("v1-a", "v1-b"):
            other = User(
                name=name, email=f"{name}@example.com", role="user", password_hash="x"
            )
            session.add(other)
            await session.flush()
            vm = await seed_machine(
                session,
                owner_id=other.id,
                state="ready",
                desired_state="running",
                stop_reason=None,
                revision=1,
            )
            vm.backend = "vm"
        await session.commit()
    await _no_machine(app)
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 200, answered.text


def _blocked(monkeypatch: pytest.MonkeyPatch, reason: StopReason) -> None:
    """Every box power in force against the fixture's owner: paused or turned
    off here, and paused and suspended for claims."""
    from switch_core.db.stores import hosted_machine_store
    from switch_core.gateway import hosted_controller, hosted_machines
    from switch_core.visibility import hosted_access

    async def _block(*_a, **_k):  # type: ignore[no-untyped-def]
        return reason

    async def _yes(*_a, **_k):  # type: ignore[no-untyped-def]
        return True

    for module in (hosted_access, hosted_controller, hosted_machines):
        monkeypatch.setattr(module, "block_reason_in", _block)
    monkeypatch.setattr(hosted_machine_store, "owner_paused", _yes)
    monkeypatch.setattr(hosted_machine_store, "owner_suspended", _yes)


@pytest.mark.parametrize(
    "reason", [StopReason.PAUSED_BY_SWITCH, StopReason.TURNED_OFF_BY_ADMIN]
)
async def test_box_powers_never_touch_a_v1_machine(
    controller_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    reason: StopReason,
) -> None:  # type: ignore[no-untyped-def]
    """Pause, turn-off and suspension are powers over boxes: a v1 owner under
    any of them is still prepared, woken, started and served as before."""
    app = controller_app
    _claim_settings(app)
    controller_id, _ = await enrolled(app, agents=1)
    _blocked(monkeypatch, reason)
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="idle")
    async with app.factory() as session:
        await wake_controller_machine(
            session, controller_id, datetime.now(UTC), "message"
        )
        await session.commit()
    assert (await machine_of(app.factory, app.machine_id)).desired_state == "running"
    prepared = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/prepare",
        headers=HEADERS,
        json={},
    )
    assert prepared.status_code == 200, prepared.text
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="owner")
    revision = (await machine_of(app.factory, app.machine_id)).revision
    started = await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": "start", "revision": revision},
    )
    assert started.status_code == 200, started.text
    ensured = await app.client.post("/hosted-machines/ensure")
    assert ensured.status_code == 200, ensured.text


async def test_box_powers_still_hold_a_box(
    controller_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:  # type: ignore[no-untyped-def]
    from switch_core.db.stores.hosted_machine_store import MACHINE_PAUSED

    app = controller_app
    await update_machine(app.factory, app.machine_id, backend="box")
    _blocked(monkeypatch, StopReason.PAUSED_BY_SWITCH)
    prepared = await app.client.post(
        f"/hosted-controller/machines/{app.machine_id}/prepare",
        headers=HEADERS,
        json={},
    )
    assert prepared.status_code == 409, prepared.text
    assert prepared.json()["detail"] == MACHINE_PAUSED


async def test_an_unset_user_list_admits_nobody_to_a_box(
    controller_app,  # noqa: F811
) -> None:  # type: ignore[no-untyped-def]
    """The closed rule for boxes: with `allowed_user_ids` unset, a person with
    no v1 machine gets none. (A v1 owner is served: the test above.)"""
    from switch_core.gateway.hosted_machines import MACHINES_DISABLED

    app = controller_app
    _claim_settings(app)
    app.settings.allowed_user_ids = None
    await _no_machine(app)
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 503, answered.text
    assert answered.json()["detail"] == MACHINES_DISABLED


async def test_a_v1_machine_gone_before_the_claim_leaves_only_the_box_rules(
    controller_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:  # type: ignore[no-untyped-def]
    """v1's reading of the lists is for a v1 owner's v1 machine only. If that
    machine goes between the first look and the claims lock, the person is
    asking for a box, and an unset list admits nobody to one."""
    from switch_core.db.stores.hosted_machine_store import CloudMachineStore
    from switch_core.gateway.hosted_machines import MACHINES_DISABLED

    app = controller_app
    _claim_settings(app)
    app.settings.allowed_user_ids = None
    await _make_vm(app, state="stopped", desired_state="stopped", stop_reason="idle")
    looks: list[int] = []
    real = CloudMachineStore.live_for_owner

    async def gone_after_first_look(self, session, owner_id):  # type: ignore[no-untyped-def]
        found = await real(self, session, owner_id)
        looks.append(1)
        if len(looks) == 1:
            await _no_machine(app)
        return found

    monkeypatch.setattr(CloudMachineStore, "live_for_owner", gone_after_first_look)
    answered = await app.client.post("/hosted-machines/ensure")
    assert answered.status_code == 503, answered.text
    assert answered.json()["detail"] == MACHINES_DISABLED
    assert len(looks) == 2
    after = await machine_of(app.factory, app.machine_id)
    assert (after.backend, after.state) == ("vm", "deleted")


def test_the_store_refuses_to_write_a_v1_machine() -> None:
    from switch_core.db.stores.hosted_machine_store import VmRowRefused, _only_boxes

    _only_boxes(CloudMachine(id="m", backend="box"))
    with pytest.raises(VmRowRefused):
        _only_boxes(CloudMachine(id="m", backend="vm"))


def test_only_the_migration_s_rollback_ever_writes_a_v1_machine() -> None:
    """Across Core, the only code that sets a machine's backend to `vm` is
    `flip_back` (the operator's audited rollback onto the person's own disk),
    and the only code that makes a machine row is the claim, which makes a
    box behind `_only_boxes`."""
    import ast
    import pathlib

    import switch_core

    root = pathlib.Path(switch_core.__file__).parent
    writes_vm: set[str] = set()
    makes_rows: set[str] = set()
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            where = f"{path.relative_to(root)}:{fn.name}"
            for node in ast.walk(fn):
                vm = ast.Constant(value="vm")
                if isinstance(node, ast.Assign) and any(
                    isinstance(t, ast.Attribute) and t.attr == "backend"
                    for t in node.targets
                ):
                    if ast.dump(node.value) == ast.dump(vm):
                        writes_vm.add(where)
                if isinstance(node, ast.keyword) and node.arg == "backend":
                    if ast.dump(node.value) == ast.dump(vm):
                        writes_vm.add(where)
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id == "CloudMachine"
                ):
                    makes_rows.add(where)
    assert writes_vm == {"db/stores/hosted_machine_store.py:flip_back"}
    assert makes_rows == {"db/stores/hosted_machine_store.py:claim"}


async def test_a_claim_that_would_revive_a_v1_machine_is_refused(
    controller_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:  # type: ignore[no-untyped-def]
    """The guard bites: a revive bent into writing `vm` fails before the
    database, and the deleted v1 row stays deleted."""
    from switch_core.db.stores import hosted_machine_store
    from switch_core.db.stores.hosted_machine_store import VmRowRefused

    app = controller_app
    _claim_settings(app)
    await _make_vm(app)
    await _no_machine(app)
    real = hosted_machine_store.bump_revision

    def bent(machine, now):  # type: ignore[no-untyped-def]
        machine.backend = "vm"
        return real(machine, now)

    monkeypatch.setattr(hosted_machine_store, "bump_revision", bent)
    with pytest.raises(VmRowRefused):
        await app.client.post("/hosted-machines/ensure")
    after = await machine_of(app.factory, app.machine_id)
    assert (after.backend, after.state) == ("vm", "deleted")


def test_no_retired_wording_is_left_for_people_to_see() -> None:
    """v1 users never read that their machine is retired, removed or old."""
    import pathlib

    import switch_core

    banned = (
        "has been retired",
        "machines are retired",
        "earlier version of hosted agents",
    )
    root = pathlib.Path(switch_core.__file__).parent
    for path in root.rglob("*.py"):
        text = path.read_text()
        for words in banned:
            assert words not in text, (path, words)


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
