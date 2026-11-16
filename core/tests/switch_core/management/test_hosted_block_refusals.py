"""Pause and turn-off at the management routes: a cloud box's controller is refused
token exchange and credential rotation while its owner is paused, and a
controller Core revoked is refused on the next request, also by a second Core
process that never saw it cached. Against Postgres."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    MachineWorkspace,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.tenant_context import no_tenant
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
)
from tests.switch_core.management.test_sealed_logins import (
    _b64,
    _logins_path,
    _register_key,
    _sealed,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _cloud_controller(harness: Harness, name: str = "ada") -> EnrolledController:
    """An enrolled controller standing in for a cloud box's: kind `ec2`, the
    only kind the pause and turn-off refusals apply to."""
    owner = await add_member(harness.session_factory, name)
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller.controller_id)
            .values(kind="ec2")
        )
        await session.commit()
    harness.controller_auth_cache.clear()
    return controller


async def _pause(harness: Harness, user_id: str) -> None:
    with no_tenant():
        async with harness.session_factory() as session:
            await session.execute(
                update(User)
                .where(User.id == user_id)
                .values(hosted_paused_at=datetime.now(UTC))
            )
            await session.commit()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_paused_owners_cloud_controller_cant_rotate_or_exchange(
    harness: Harness,
) -> None:
    controller = await _cloud_controller(harness)
    await _on_machine(harness, controller, "box")  # pause is a v2 power over boxes
    await _pause(harness, controller.owner.id)
    async with harness.client() as client:
        rotated = await client.post(
            f"/v1/management/controllers/{controller.controller_id}/credential/rotate",
            headers=controller.headers,
        )
        exchanged = await client.post(
            f"/v1/management/controllers/{controller.controller_id}/token",
            json={"credential": controller.credential},
        )
    for response in (rotated, exchanged):
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "paused_by_switch"


async def test_a_console_controller_is_never_affected_by_a_hosted_pause(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "grace")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
    await _pause(harness, owner.id)
    async with harness.client() as client:
        exchanged = await client.post(
            f"/v1/management/controllers/{controller.controller_id}/token",
            json={"credential": controller.credential},
        )
    assert exchanged.status_code == 200, exchanged.text


async def test_a_revoked_controller_is_refused_next_request_in_another_process(
    harness: Harness, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    controller = await _cloud_controller(harness)
    # A second Core process: its own caches and presence, the same database.
    other = build_harness(session_factory)
    path = f"/v1/management/controllers/{controller.controller_id}/assignment"
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await harness.management.service.revoke_controllers(
            session, TENANT_ZERO_ID, [controller.controller_id]
        )
        await session.commit()
    harness.management.service.announce_revoked([controller.controller_id])
    for process in (harness, other):
        async with process.client() as client:
            refused = await client.get(path, headers=controller.headers)
        assert refused.status_code == 401, refused.text
        assert refused.json()["error"]["code"] == "controller_revoked"


async def test_after_v3s_revoke_no_old_login_reaches_the_new_controller(
    harness: Harness,
) -> None:
    """The revoke deletes the sealed logins, and a
    login sealed to the old controller's key is refused for the new one."""
    owner = await add_member(harness.session_factory, "ada")
    old_key, new_key = _b64(32), _b64(32)
    async with harness.client() as client:
        old = await enroll_console(harness, client, owner, "box-before")
        await _register_key(client, old, old_key)
        given = await client.put(
            _logins_path(old, "claude"),
            json={"sealed": _sealed(old_key)},
            cookies=cookies_for(owner),
        )
        assert given.status_code in (200, 201), given.text
    # The pause's path: revoke through the service, then announce.
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await harness.management.service.revoke_controllers(
            session, TENANT_ZERO_ID, [old.controller_id]
        )
        await session.commit()
    harness.management.service.announce_revoked([old.controller_id])
    async with harness.client() as client:
        listed = await client.get(_logins_path(old), cookies=cookies_for(owner))
        assert listed.json() == []
        # The box enrols again after the resume, with a fresh key.
        new = await enroll_console(harness, client, owner, "box-after")
        await _register_key(client, new, new_key)
        stale = await client.put(
            _logins_path(new, "claude"),
            json={"sealed": _sealed(old_key)},
            cookies=cookies_for(owner),
        )
        fresh = await client.get(_logins_path(new), cookies=cookies_for(owner))
    assert stale.status_code == 409, stale.text
    assert fresh.json() == []


async def _revoke_state(harness: Harness, controller_id: str) -> tuple[object, object]:
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(AgentController, controller_id)
        await session.commit()
        return row.revoked_at, row.revoked_by


async def test_a_hosted_blocks_revoke_is_marked_and_any_other_revoke_clears_it(
    harness: Harness,
) -> None:
    """Only a pause or turn-off marks its revoke (`revoked_by`), so a
    lift may wake the box. The owner's removal on a row a pause already revoked
    clears the mark and keeps the first revoke's time, so no resume wakes it."""
    controller = await _cloud_controller(harness)
    service = harness.management.service
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await service.revoke_controllers(
            session, TENANT_ZERO_ID, [controller.controller_id], "pause"
        )
        await session.commit()
    revoked_at, revoked_by = await _revoke_state(harness, controller.controller_id)
    assert revoked_at is not None and revoked_by == "pause"

    # A turn-off on the already revoked row changes nothing.
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await service.revoke_controllers(
            session, TENANT_ZERO_ID, [controller.controller_id], "turn_off"
        )
        await session.commit()
    assert await _revoke_state(harness, controller.controller_id) == (
        revoked_at,
        "pause",
    )

    # The owner removes it: the mark goes, the time stays.
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await service.revoke_controller(
            session, TENANT_ZERO_ID, controller.owner.id, controller.controller_id
        )
    assert await _revoke_state(harness, controller.controller_id) == (revoked_at, None)


async def test_a_revoke_by_any_other_path_carries_no_mark_by_default(
    harness: Harness,
) -> None:
    """The shared helper's default is "not a hosted block": a fresh revoke from any
    other caller (enrolment replacement, a box's revive, a path added later) leaves no
    mark, and on a row a pause revoked it clears the mark."""
    service = harness.management.service
    fresh = await _cloud_controller(harness)
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await service.revoke_controllers(session, TENANT_ZERO_ID, [fresh.controller_id])
        await session.commit()
    at, by = await _revoke_state(harness, fresh.controller_id)
    assert at is not None and by is None

    paused = await _cloud_controller(harness, "grace")
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await service.revoke_controllers(
            session, TENANT_ZERO_ID, [paused.controller_id], "pause"
        )
        await session.commit()
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await service._revoke(session, TENANT_ZERO_ID, paused.controller_id)
        await session.commit()
    assert (await _revoke_state(harness, paused.controller_id))[1] is None


# ── The v1/v2 switch: with hosted agents v2 off, a v2 box's controller is refused ──


@pytest.fixture
def v2_off(monkeypatch):
    from switch_core import hosted_v2

    monkeypatch.setattr(hosted_v2, "_process_on", False)


async def _on_machine(
    harness: Harness, controller: EnrolledController, backend: str
) -> None:
    """Put the controller on a cloud machine of this backend, as its enrolment would."""
    from tests.switch_core.hosted_machine_helpers import seed_machine

    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        machine = await seed_machine(
            session,
            owner_id=controller.owner.id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        machine.backend = backend
        workspace = await session.scalar(
            select(MachineWorkspace).where(MachineWorkspace.machine_id == machine.id)
        )
        workspace.controller_id = controller.controller_id
        await session.commit()
    harness.controller_auth_cache.clear()


async def _exchange(harness: Harness, controller: EnrolledController):
    async with harness.client() as client:
        return await client.post(
            f"/v1/management/controllers/{controller.controller_id}/token",
            json={"credential": controller.credential},
        )


async def test_v2_off_a_boxs_controller_gets_no_token(harness: Harness, v2_off) -> None:
    controller = await _cloud_controller(harness)
    await _on_machine(harness, controller, "box")
    refused = await _exchange(harness, controller)
    assert refused.status_code == 403, refused.text
    assert refused.json()["error"]["code"] == "hosted_v2_off"


async def test_v2_off_a_v1_machines_controller_works_as_before(
    harness: Harness, v2_off
) -> None:
    controller = await _cloud_controller(harness, "grace")
    await _on_machine(harness, controller, "vm")
    exchanged = await _exchange(harness, controller)
    assert exchanged.status_code == 200, exchanged.text


async def test_v2_off_a_paused_owners_v1_controller_is_not_refused(
    harness: Harness, v2_off
) -> None:
    """The pause is v2's; with it off, as before v2, nothing reads it."""
    controller = await _cloud_controller(harness, "lin")
    await _on_machine(harness, controller, "vm")
    await _pause(harness, controller.owner.id)
    exchanged = await _exchange(harness, controller)
    assert exchanged.status_code == 200, exchanged.text


@pytest.mark.usefixtures("hosted_v2_on")
async def test_v2_on_a_boxs_controller_still_gets_its_token(harness: Harness) -> None:
    controller = await _cloud_controller(harness, "ken")
    await _on_machine(harness, controller, "box")
    exchanged = await _exchange(harness, controller)
    assert exchanged.status_code == 200, exchanged.text


# Three conditions for the sweep: with v2
# off a box's controller is refused enrolment, a token and a reconnect; no
# sealed login is opened for it; and nothing about it is revoked or deleted.


async def _box_workspace(harness: Harness, owner_id: str) -> str:
    """A box machine of the owner's, serving the bound workspace: the id of
    the workspace's row on it (read again by the caller in its own session)."""
    from tests.switch_core.hosted_machine_helpers import seed_machine

    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        machine = await seed_machine(
            session,
            owner_id=owner_id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        machine.backend = "box"
        workspace = await session.scalar(
            select(MachineWorkspace).where(MachineWorkspace.machine_id == machine.id)
        )
        workspace_id = workspace.id
        await session.commit()
    return workspace_id


async def test_v2_off_a_box_cannot_enrol_with_its_code(
    harness: Harness, v2_off
) -> None:
    from tests.switch_core.management.harness import fixture

    owner = await add_member(harness.session_factory, "mo")
    workspace_id = await _box_workspace(harness, owner.id)
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        workspace = await session.get(MachineWorkspace, (TENANT_ZERO_ID, workspace_id))
        code = await harness.management.service.machine_enrollment_code(
            session, workspace, datetime.now(UTC)
        )
        await session.commit()
    body = fixture("enroll_request.json")
    body["proof"]["code"] = code
    async with harness.client() as client:
        refused = await client.post("/v1/management/controllers/enroll", json=body)
    assert refused.status_code == 403, refused.text
    assert refused.json()["error"]["code"] == "hosted_v2_off"
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        still = await session.get(MachineWorkspace, (TENANT_ZERO_ID, workspace_id))
    assert still.controller_id is None  # nothing enrolled


async def test_v2_off_a_boxs_controller_cannot_reconnect_or_open_a_sealed_login(
    harness: Harness, v2_off
) -> None:
    from switch_core.bridges.agent.auth import ControllerPrincipal
    from switch_core.management.errors import ManagementError

    controller = await _cloud_controller(harness, "noor")
    await _on_machine(harness, controller, "box")
    principal = ControllerPrincipal(
        controller_id=controller.controller_id,
        owner_id=controller.owner.id,
        tenant_id=TENANT_ZERO_ID,
    )
    service = harness.management.service
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        with pytest.raises(ManagementError) as reconnect:
            await service.record_opened(
                session,
                principal,
                connection_id="c-1",
                generation=1,
                resume_cursors={},
            )
        with pytest.raises(ManagementError) as sealed:
            await service.own_sealed_login(session, principal, "claude")
    assert reconnect.value.status_code == sealed.value.status_code == 403


async def test_v2_off_a_refused_box_is_never_revoked_or_deleted(
    harness: Harness, v2_off, monkeypatch
) -> None:
    from switch_core import hosted_v2
    from switch_core.db.models import CloudMachine

    controller = await _cloud_controller(harness, "ravi")
    await _on_machine(harness, controller, "box")
    assert (await _exchange(harness, controller)).status_code == 403
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(AgentController, controller.controller_id)
        workspace = await session.scalar(
            select(MachineWorkspace).where(
                MachineWorkspace.controller_id == controller.controller_id
            )
        )
        machine = await session.get(CloudMachine, workspace.machine_id)
    assert row.revoked_at is None and row.revoked_by is None
    assert machine.state != "deleted"
    # Its credential was kept: with v2 on again the same box carries on.
    monkeypatch.setattr(hosted_v2, "_process_on", True)
    harness.controller_auth_cache.clear()
    assert (await _exchange(harness, controller)).status_code == 200


# The extras: with v2 off a cloud controller's status report
# records no awake minutes or AI calls, and its answer carries no v2 wait limit.


@pytest.mark.parametrize(
    ("on", "backend"), [(False, "box"), (False, "vm"), (True, "vm"), (True, "box")]
)
async def test_a_cloud_status_report_records_v2_usage_only_for_a_v2_box(
    harness: Harness, monkeypatch, on: bool, backend: str
) -> None:
    from switch_core import hosted_v2
    from switch_core.management import service as service_module
    from tests.switch_core.management.harness import report_status_only

    monkeypatch.setattr(hosted_v2, "_process_on", on)
    recorded: list[str] = []

    async def _awake(*_a, **_k) -> int:
        recorded.append("awake")
        return 0

    async def _calls(*_a, **_k) -> None:
        recorded.append("calls")

    monkeypatch.setattr(service_module, "record_awake_minutes", _awake)
    monkeypatch.setattr(service_module, "record_hosted_ai_calls", _calls)
    controller = await _cloud_controller(harness, f"usage-{on}-{backend}")
    await _on_machine(harness, controller, backend)
    async with harness.client() as client:
        response = await report_status_only(client, controller, 2)
    assert response.status_code == 200, response.text
    v2_box = on and backend == "box"
    assert ("wait_limit_seconds" in response.json()) is v2_box
    assert recorded == (["awake", "calls"] if v2_box else [])


# The five other guard sites: each door refuses a box's
# controller with v2 off, and lets a v1 machine's through (and a box's with v2
# on). "Through" means not refused by the switch: a door may still answer for
# its own reasons (no sealed login stored, say).


async def _door(harness: Harness, controller: EnrolledController, door: str):
    from tests.switch_core.management.harness import create_managed_agent

    path = f"/v1/management/controllers/{controller.controller_id}"
    async with harness.client() as client:
        if door == "token":
            return await client.post(
                f"{path}/token", json={"credential": controller.credential}
            )
        if door == "rotate":
            return await client.post(
                f"{path}/credential/rotate", headers=controller.headers
            )
        if door == "sealed_login":
            return await client.get(
                f"{path}/provider-credentials/claude", headers=controller.headers
            )
        if door == "reconnect":
            return await client.post(
                f"/v1/controllers/{controller.controller_id}/connection",
                json={"cursors": {}},
                headers=controller.headers,
            )
        assert door == "placement"
        return await create_managed_agent(
            client,
            controller.owner,
            name="helper",
            controller_id=controller.controller_id,
        )


def _switch_refused(response) -> bool:
    if response.status_code != 403:
        return False
    body = response.json()
    return (body.get("error") or {}).get("code") == "hosted_v2_off"


DOORS = ("token", "rotate", "sealed_login", "reconnect", "placement")


@pytest.mark.parametrize("door", DOORS)
@pytest.mark.parametrize(
    ("on", "backend", "refused"),
    [(False, "box", True), (False, "vm", False), (True, "box", False)],
)
async def test_each_door_refuses_only_a_box_while_v2_is_off(
    harness: Harness, monkeypatch, door: str, on: bool, backend: str, refused: bool
) -> None:
    from switch_core import hosted_v2

    monkeypatch.setattr(hosted_v2, "_process_on", on)
    controller = await _cloud_controller(harness, f"{door}-{on}-{backend}")
    await _on_machine(harness, controller, backend)
    response = await _door(harness, controller, door)
    assert _switch_refused(response) is refused, response.text


async def test_v2_off_a_v1_machine_enrols_with_its_code(
    harness: Harness, v2_off
) -> None:
    from tests.switch_core.hosted_machine_helpers import seed_machine
    from tests.switch_core.management.harness import fixture

    owner = await add_member(harness.session_factory, "vic")
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        workspace = await session.scalar(
            select(MachineWorkspace).where(MachineWorkspace.machine_id == machine.id)
        )
        code = await harness.management.service.machine_enrollment_code(
            session, workspace, datetime.now(UTC)
        )
        await session.commit()
    body = fixture("enroll_request.json")
    body["proof"]["code"] = code
    async with harness.client() as client:
        enrolled = await client.post("/v1/management/controllers/enroll", json=body)
    assert enrolled.status_code == 201, enrolled.text


async def test_v2_on_a_paused_owners_v1_machine_is_not_refused(
    harness: Harness,
) -> None:
    """Pause and turn-off are v2 powers over boxes;
    a v1 machine keeps upstream's lifecycle whatever the switch says."""
    controller = await _cloud_controller(harness, "pia")
    await _on_machine(harness, controller, "vm")
    await _pause(harness, controller.owner.id)
    assert (await _exchange(harness, controller)).status_code == 200


async def test_off_then_on_the_box_carries_on_with_the_same_credential_and_login(
    harness: Harness, monkeypatch
) -> None:
    """Refused with the switch off, then served with the same
    credential once it's on again; its sealed login is still there, and
    nothing was revoked or cleared by the refusals."""
    from switch_core import hosted_v2

    key = _b64(32)
    controller = await _cloud_controller(harness, "otto")
    async with harness.client() as client:
        registered = await _register_key(client, controller, key)
        assert registered.status_code < 300, registered.text
        stored = await client.put(
            _logins_path(controller, "claude"),
            json={"sealed": _sealed(key)},
            cookies=cookies_for(controller.owner),
        )
    assert stored.status_code in (200, 201, 204), stored.text
    await _on_machine(harness, controller, "box")
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    for door in DOORS:
        assert _switch_refused(await _door(harness, controller, door)), door
    monkeypatch.setattr(hosted_v2, "_process_on", True)
    harness.controller_auth_cache.clear()
    assert (await _exchange(harness, controller)).status_code == 200
    login = await _door(harness, controller, "sealed_login")
    assert login.status_code == 200, login.text
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(AgentController, controller.controller_id)
    assert row.revoked_at is None
