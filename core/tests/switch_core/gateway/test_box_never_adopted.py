"""A v2 box's controller is never taken over as a "same device".

Upstream's device identity (#2121) lets a controller enrolling again on a
computer its owner already has a device for take that device over, agents and
all. A box enrolls again only after its controller was revoked or lost, and
v2's own path moves its agents then (`_move_placed`, under the box's revocation
and removal rules), so the two must never meet: a box's enrollment adopts no
device whatever device id it sends, and no box controller, revoked or not, is
ever adopted by anyone. Against Postgres, with real agent management.
"""

from __future__ import annotations

from typing import Any, Literal

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.db.models import TENANT_ZERO_ID, AgentController, User
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.management.device_identity import device_hash
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _hosted_app,
    _prepare,
)
from tests.switch_core.gateway.test_machine_revival import (
    _claim,
    _enrolled_machine,
    _expire_retention,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    fixture,
    platform,
)
from tests.switch_core.management.test_same_device import DEVICE, _row, _settle


@pytest.fixture(autouse=True)
def _no_enrollment_left_installed() -> Any:
    set_cloud_enrollment(None)
    yield
    set_cloud_enrollment(None)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _enroll_by_code(
    client: httpx.AsyncClient,
    code: str,
    kind: Literal["daemon", "ec2"],
    device_id: str | None = DEVICE,
) -> dict:
    body = fixture("enroll_request.json")
    body["proof"]["code"] = code
    body["controller"]["kind"] = kind
    body["controller"]["platform"] = platform()
    if device_id is None:
        body["controller"].pop("device_id", None)
    else:
        body["controller"]["device_id"] = device_id
    response = await client.post("/v1/management/controllers/enroll", json=body)
    assert response.status_code == 201, response.text
    return dict(response.json())


async def _plain_code(client: httpx.AsyncClient, owner: User) -> str:
    """An enrollment code for no machine: a computer's, as Console makes."""
    response = await client.post(
        "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
    )
    assert response.status_code in (200, 201), response.text
    return str(response.json()["code"])


async def _give_it_the_device(
    harness: Harness, controller_id: str, owner: User
) -> None:
    """The worst case: a box controller holding the device hash a later
    enrollment names (Core never stores one for an `ec2` controller)."""
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller_id)
            .values(device_hash=device_hash(owner.id, DEVICE))
        )
        await session.commit()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_enrolling_with_a_device_id_takes_over_no_device(
    harness: Harness,
) -> None:
    """The owner has an idle computer on the device the box claims to be: the
    box's machine-bound enrollment makes a controller of its own, and the
    computer keeps its credential and agents."""
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        computer = await _enroll_by_code(
            client, await _plain_code(client, owner), "daemon"
        )
    await _settle(harness)
    before = await _row(harness, computer["controller_id"])

    machine = await _claim(harness.session_factory, owner, backend="box")
    async with _hosted_app(harness.session_factory, owner) as hosted:
        [entry] = (await _prepare(hosted, machine.id))["controllers"]
    async with harness.client() as client:
        box = await _enroll_by_code(client, entry["enrollment_code"], "daemon")

    assert box["adopted"] is False
    assert box["controller_id"] != computer["controller_id"]
    after = await _row(harness, computer["controller_id"])
    assert after.api_key_id == before.api_key_id
    assert after.revoked_at is None
    assert (await _row(harness, box["controller_id"])).kind == "ec2"


@pytest.mark.parametrize("revoked", [True, False])
@pytest.mark.usefixtures("hosted_v2_on")
async def test_no_box_controller_is_ever_adopted(
    harness: Harness, revoked: bool
) -> None:
    """A box controller, revoked (deleted at retention) or only idle, even
    holding the device hash an enrollment names, is never taken over: the
    enrollment makes a new controller, and the box's row is left as it was,
    a revoked one still revoked."""
    owner = await add_member(harness.session_factory, "ada")
    machine_id, box_id = await _enrolled_machine(harness, owner, "box")
    if revoked:
        await _expire_retention(harness, machine_id)
    await _give_it_the_device(harness, box_id, owner)
    await _settle(harness)
    before = await _row(harness, box_id)
    assert (before.revoked_at is not None) is revoked

    async with harness.client() as client:
        again = await _enroll_by_code(client, await _plain_code(client, owner), "ec2")

    assert again["adopted"] is False
    assert again["controller_id"] != box_id
    after = await _row(harness, box_id)
    assert after.revoked_at == before.revoked_at
    assert after.api_key_id == before.api_key_id


async def test_with_v2_off_an_ec2_device_is_taken_over_as_upstream(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard is v2's: with v2 off, upstream's take-over is unchanged for
    every kind."""
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        first = await _enroll_by_code(client, await _plain_code(client, owner), "ec2")
        await _settle(harness)
        second = await _enroll_by_code(client, await _plain_code(client, owner), "ec2")

    assert first["adopted"] is False
    assert second["adopted"] is True
    assert second["controller_id"] == first["controller_id"]
