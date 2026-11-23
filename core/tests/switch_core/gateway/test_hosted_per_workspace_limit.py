"""`HOSTED_LAUNCH_CAPACITY_PER_WORKSPACE`: with hosted agents v2 on, at most
that many live cloud machines may serve any one workspace (a box serving
several workspaces counts in each), under the server-wide capacity. 0 means
no limit, with a warning at start. With v2 off it's ignored."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest

from switch_core.db.models import TenantMember, User, require_tenant_id
from switch_core.db.stores.hosted_machine_store import (
    MACHINES_FULL,
    WORKSPACE_MACHINES_FULL,
    CloudMachineConflict,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.hosted_machines import ensure_machine
from switch_core.observability.catalogue import HOSTED_CLAIM_REFUSED
from switch_core.observability.metrics import MetricsRegistry
from switch_core.providers.hosted import (
    PER_WORKSPACE_UNSET_WARNING,
    warn_if_no_per_workspace_limit,
)
from switch_core.tenant_context import tenant_scope
from switch_core.visibility.dependencies import set_process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _metric_points,
    hosted_metrics,  # noqa: F401  (fixture)
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    controller_app,
)
from tests.switch_core.hosted_machine_helpers import add_tenant


async def _person(app, name: str, tenant_id: str | None = None) -> str:
    async with app.factory() as session:
        user = User(
            name=name, email=f"{name}@example.com", role="user", password_hash="x"
        )
        session.add(user)
        await session.flush()
        session.add(
            TenantMember(
                tenant_id=tenant_id or require_tenant_id(),
                user_id=user.id,
                role="member",
            )
        )
        await session.commit()
        return user.id


async def _claim_as(app, user_id: str):
    fastapi_app = app.client._transport.app
    fastapi_app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=user_id
    )
    return await app.client.post("/hosted-machines/ensure")


def _limit(app, per_workspace: int, capacity: int = 10) -> None:
    app.config.hosted_launch_capacity = capacity
    app.config.hosted_launch_capacity_per_workspace = per_workspace


KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_workspace_at_its_limit_refuses_a_new_machine(
    controller_app,  # noqa: F811
    hosted_metrics: MetricsRegistry,  # noqa: F811
    caplog,
):
    """The owner's machine already serves this workspace: with a limit of 1,
    a second person's claim is refused with the workspace's own words, though
    the server has room. It's counted with a fixed word only, and logged with
    the workspace's keyed id, never its raw id."""
    app = controller_app
    _limit(app, per_workspace=1)
    other = await _person(app, "bea")
    set_process_keyed_id_key(KEY)
    try:
        with caplog.at_level(logging.WARNING):
            refused = await _claim_as(app, other)
    finally:
        set_process_keyed_id_key(None)
    assert refused.status_code == 409
    assert refused.json() == {"detail": WORKSPACE_MACHINES_FULL}
    assert _metric_points(hosted_metrics, HOSTED_CLAIM_REFUSED.name) == [
        ({"reason": "workspace_full"}, 1.0)
    ]
    (line,) = [r.getMessage() for r in caplog.records if "refused" in r.getMessage()]
    assert KEY.keyed_id(KeyedIdKind.WORKSPACE, require_tenant_id()) in line
    assert require_tenant_id() not in line


@pytest.mark.usefixtures("hosted_v2_on")
async def test_two_claims_at_once_at_the_last_slot_let_exactly_one_through(
    controller_app,  # noqa: F811
    monkeypatch,
):
    """At the limit less one, two people claiming at the same moment, each on
    their own session against the real database: the claims lock lets one
    through and refuses the other. Each claim, having counted, waits up to a
    second for the other to have counted too, so without the lock both would
    count one machine and both get through."""
    from switch_core.db.stores import hosted_machine_store

    counted = asyncio.Barrier(2)
    real = hosted_machine_store._refuse_if_workspace_full

    async def count_then_wait(session, per_workspace):
        await real(session, per_workspace)
        try:
            await asyncio.wait_for(counted.wait(), timeout=1)
        except TimeoutError:
            pass  # the other is held at the claims lock: as it should be

    monkeypatch.setattr(
        hosted_machine_store, "_refuse_if_workspace_full", count_then_wait
    )
    app = controller_app
    _limit(app, per_workspace=2)  # the owner's machine is one
    people = [await _person(app, name) for name in ("bea", "cai")]
    settings = app.client._transport.app.state.hosted_controller_settings
    start = asyncio.Event()

    async def claim(user_id: str) -> str:
        await start.wait()
        async with app.factory() as session:
            try:
                await ensure_machine(
                    session, app.factory, user_id, app.config, settings
                )
                await session.commit()
                return "claimed"
            except CloudMachineConflict as error:
                await session.rollback()
                return str(error)

    racing = [asyncio.create_task(claim(person)) for person in people]
    await asyncio.sleep(0)
    start.set()
    results = await asyncio.gather(*racing)
    assert sorted(results) == sorted(["claimed", WORKSPACE_MACHINES_FULL])


@pytest.mark.usefixtures("hosted_v2_on")
async def test_under_the_limit_a_claim_goes_ahead_then_stops_at_it(controller_app):  # noqa: F811
    app = controller_app
    _limit(app, per_workspace=2)
    second = await _claim_as(app, await _person(app, "bea"))
    assert second.status_code == 200, second.text
    third = await _claim_as(app, await _person(app, "cai"))
    assert third.status_code == 409
    assert third.json() == {"detail": WORKSPACE_MACHINES_FULL}


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_joining_a_workspace_counts_there(controller_app):  # noqa: F811
    """The owner's box joins tenant-b, which then has one machine: at a limit
    of 1, nobody else in tenant-b can claim one. Joining a workspace already
    at its limit is refused too."""
    app = controller_app
    _limit(app, per_workspace=1)
    async with app.factory() as session:
        await add_tenant(session, "tenant-b")
        await session.commit()
    app.settings.allowed_tenant_ids = ["*"]
    with tenant_scope("tenant-b"):
        joined = await _claim_as(app, app.owner_id)
        assert joined.status_code == 200, joined.text
        refused = await _claim_as(app, await _person(app, "bea", "tenant-b"))
        assert refused.status_code == 409
        assert refused.json() == {"detail": WORKSPACE_MACHINES_FULL}
    async with app.factory() as session:
        await add_tenant(session, "tenant-c")
        await session.commit()
    with tenant_scope("tenant-c"):
        dee = await _person(app, "dee", "tenant-c")
        assert (await _claim_as(app, dee)).status_code == 200  # tenant-c's one
        # The owner's box would be tenant-c's second: refused, and not joined.
        assert (await _claim_as(app, app.owner_id)).status_code == 409


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_server_wide_capacity_still_applies_on_top(controller_app):  # noqa: F811
    app = controller_app
    _limit(app, per_workspace=5, capacity=1)
    refused = await _claim_as(app, await _person(app, "bea"))
    assert refused.status_code == 409
    assert refused.json() == {"detail": MACHINES_FULL}


@pytest.mark.usefixtures("hosted_v2_on")
async def test_zero_means_no_per_workspace_limit(controller_app):  # noqa: F811
    app = controller_app
    _limit(app, per_workspace=0)
    for name in ("bea", "cai"):
        assert (await _claim_as(app, await _person(app, name))).status_code == 200


async def test_with_v2_off_the_limit_is_ignored(controller_app, monkeypatch):  # noqa: F811
    from switch_core import hosted_v2

    monkeypatch.setattr(hosted_v2, "_process_on", False)
    app = controller_app
    app.settings.allowed_user_ids = None  # v1: every account
    _limit(app, per_workspace=1)
    claimed = await _claim_as(app, await _person(app, "bea"))
    assert claimed.status_code == 200, claimed.text


def test_core_warns_at_start_only_when_v2_runs_machines_with_no_limit(caplog):
    with caplog.at_level(logging.WARNING, logger="switch_core.providers.hosted"):
        assert warn_if_no_per_workspace_limit(10, 0, v2=True) is True
        assert warn_if_no_per_workspace_limit(10, 3, v2=True) is False
        assert warn_if_no_per_workspace_limit(0, 0, v2=True) is False
        assert warn_if_no_per_workspace_limit(10, 0, v2=False) is False
    assert [r.getMessage() for r in caplog.records] == [PER_WORKSPACE_UNSET_WARNING]
