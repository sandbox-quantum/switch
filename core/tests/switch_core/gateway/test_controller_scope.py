"""Each cloud controller sees and acts on its own kind of machine.

On the shared controller routes (`/machines`, `/prepare`, `/observation`), the
box workers' bearer (`box_controller_token`) reaches boxes only, and v1's
controller `token` reaches v1 machines only, once a box bearer is configured.
A machine of the other kind is answered exactly as a machine that doesn't
exist. With no box bearer configured, `token` reaches every machine, as before,
so a box cluster not yet moved over works unchanged.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from switch_core.db.models import User
from tests.switch_core.gateway.test_hosted_controller import (
    HEADERS,
    TOKEN,
    ControllerApp,
    controller_app,  # noqa: F401 -- the fixture
    machine_of,
)
from tests.switch_core.hosted_machine_helpers import seed_machine

BOX_TOKEN = "SYNTHETIC-BOX-CONTROLLER-CREDENTIAL-FOR-TESTS"
BOX_HEADERS = {"Authorization": "Bearer " + BOX_TOKEN}
NOT_FOUND = {"detail": "Cloud machine not found."}


def _with_box_bearer(app: ControllerApp) -> None:
    """Configure the box workers' bearer on the running app."""
    settings = app.settings.model_copy(
        update={"box_controller_token": _secret(BOX_TOKEN)}
    )
    app.client._transport.app.state.hosted_controller_settings = settings  # type: ignore[attr-defined]


def _secret(value: str) -> Any:
    from pydantic import SecretStr

    return SecretStr(value)


async def _box(app: ControllerApp) -> str:
    """A second person's box, beside the fixture's v1 machine (one machine per
    person)."""
    async with app.factory() as session:
        other = User(
            name="box owner",
            email=f"box-{uuid4().hex[:8]}@example.com",
            role="user",
            password_hash="x",
        )
        session.add(other)
        await session.flush()
        box = await seed_machine(
            session,
            owner_id=other.id,
            state="queued",
            desired_state="running",
            stop_reason=None,
            revision=1,
            backend="box",
        )
        await session.commit()
        return box.id


async def _listed(app: ControllerApp, headers: dict) -> set[str]:
    response = await app.client.get("/hosted-controller/machines", headers=headers)
    assert response.status_code == 200, response.text
    return {item["machine_id"] for item in response.json()["machines"]}


async def _prepare(app: ControllerApp, machine_id: str, headers: dict):  # type: ignore[no-untyped-def]
    return await app.client.post(
        f"/hosted-controller/machines/{machine_id}/prepare", headers=headers, json={}
    )


async def _observe(app: ControllerApp, machine_id: str, headers: dict):  # type: ignore[no-untyped-def]
    return await app.client.post(
        f"/hosted-controller/machines/{machine_id}/observation",
        headers=headers,
        json={"revision": 1, "state": "provisioning"},
    )


async def test_with_no_box_bearer_the_controller_token_sees_every_machine(
    controller_app: ControllerApp,  # noqa: F811
) -> None:
    app = controller_app
    box = await _box(app)
    assert await _listed(app, HEADERS) == {app.machine_id, box}


async def test_each_bearer_lists_only_its_own_kind(
    controller_app: ControllerApp,  # noqa: F811
) -> None:
    app = controller_app
    box = await _box(app)
    _with_box_bearer(app)
    assert await _listed(app, HEADERS) == {app.machine_id}
    assert await _listed(app, BOX_HEADERS) == {box}


@pytest.mark.parametrize("call", [_prepare, _observe])
async def test_the_controller_token_is_told_a_box_does_not_exist(
    controller_app: ControllerApp,  # noqa: F811
    call: Any,
) -> None:
    app = controller_app
    box = await _box(app)
    _with_box_bearer(app)
    before = await machine_of(app.factory, box)
    response = await call(app, box, HEADERS)
    assert (response.status_code, response.json()) == (404, NOT_FOUND)
    after = await machine_of(app.factory, box)
    assert (after.state, after.revision, after.heartbeat) == (
        before.state,
        before.revision,
        before.heartbeat,
    )
    assert app.enrollment.minted == []


@pytest.mark.parametrize("call", [_prepare, _observe])
async def test_the_box_bearer_is_told_a_v1_machine_does_not_exist(
    controller_app: ControllerApp,  # noqa: F811
    call: Any,
) -> None:
    app = controller_app
    _with_box_bearer(app)
    before = await machine_of(app.factory, app.machine_id)
    response = await call(app, app.machine_id, BOX_HEADERS)
    assert (response.status_code, response.json()) == (404, NOT_FOUND)
    after = await machine_of(app.factory, app.machine_id)
    assert (after.state, after.revision) == (before.state, before.revision)
    assert app.enrollment.minted == []


async def test_a_deleted_machine_of_the_other_kind_is_still_not_found(
    controller_app: ControllerApp,  # noqa: F811
) -> None:
    """The kind is checked before the state, so a 409 for a deleted machine
    can't say one of the other kind is there."""
    app = controller_app
    box = await _box(app)
    async with app.factory() as session:
        from switch_core.db.models import CloudMachine

        machine = await session.get(CloudMachine, box)
        assert machine is not None
        machine.desired_state = "deleted"
        await session.commit()
    _with_box_bearer(app)
    response = await _prepare(app, box, HEADERS)
    assert (response.status_code, response.json()) == (404, NOT_FOUND)


async def test_each_bearer_still_acts_on_its_own_kind(
    controller_app: ControllerApp,  # noqa: F811
) -> None:
    app = controller_app
    _with_box_bearer(app)
    response = await _prepare(app, app.machine_id, HEADERS)
    assert response.status_code == 200, response.text
    assert TOKEN not in response.text
