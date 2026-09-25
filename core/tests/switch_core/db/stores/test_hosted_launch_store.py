import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from switch_core.db.models import HostedLaunch, Tenant, User, require_tenant_id
from switch_core.db.stores.hosted_launch_store import (
    HostedLaunchConflict,
    HostedLaunchStore,
)
from switch_core.tenant_context import tenant_scope


@pytest.fixture
async def launches(session_factory):
    async with session_factory() as session:
        session.add_all(
            [
                User(
                    id="launch-owner",
                    name="Owner",
                    email="launch@example.com",
                    role="user",
                    password_hash="unused",
                ),
                User(
                    id="launch-other",
                    name="Other",
                    email="other-launch@example.com",
                    role="user",
                    password_hash="unused",
                ),
                Tenant(id="launch-other-tenant", slug="launch-other", name="Other"),
            ]
        )
        await session.commit()
    return HostedLaunchStore(), session_factory


async def reserve(store, factory, request_id, name):
    async with factory() as session:
        row = await store.reserve(
            session,
            request_id=request_id,
            owner_id="launch-owner",
            name=name,
            spec={"repository_id": 123},
            capacity=1,
            owner_capacity=3,
            agent_ids=["00000000-0000-4000-8000-000000000001"],
        )
        await session.commit()
        return row.id


async def test_duplicate_request_survives_new_session_without_second_launch(launches):
    store, factory = launches
    assert await reserve(store, factory, "request-1", "helper") == "request-1"
    assert await reserve(store, factory, "request-1", "helper") == "request-1"
    with pytest.raises(HostedLaunchConflict, match="different"):
        await reserve(store, factory, "request-1", "different")
    with pytest.raises(HostedLaunchConflict, match="name"):
        await reserve(store, factory, "request-2", "helper")


async def test_owner_and_tenant_scope(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    async with factory() as session:
        assert await store.owned(session, "request-1", "launch-other") is None
        assert await store.owned(session, "request-1", "launch-owner") is not None
    with tenant_scope("launch-other-tenant"):
        async with factory() as session:
            assert await store.owned(session, "request-1", "launch-owner") is None
        assert await reserve(store, factory, "request-1", "helper") == "request-1"


async def test_concurrent_requests_cannot_exceed_capacity(launches):
    store, factory = launches
    results = await asyncio.gather(
        reserve(store, factory, "request-a", "first"),
        reserve(store, factory, "request-b", "second"),
        return_exceptions=True,
    )
    assert sum(isinstance(value, str) for value in results) == 1
    assert sum(isinstance(value, HostedLaunchConflict) for value in results) == 1


async def address(store, factory, launch_id, **state):
    async with factory() as session:
        if state:
            launch = await session.get(HostedLaunch, (require_tenant_id(), launch_id))
            for key, value in state.items():
                setattr(launch, key, value)
            launch.active_at = datetime.now(UTC) - timedelta(hours=1)
            await session.commit()
        result = await store.note_addressed(session, launch_id)
        await session.commit()
        return result


async def test_addressing_a_sleeping_launch_wakes_it(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    woken = await address(
        store,
        factory,
        "request-1",
        desired_state="stopped",
        state="stopped",
        sleeping=True,
        error="left over",
    )
    assert (woken.desired_state, woken.state, woken.revision) == (
        "running",
        "queued",
        2,
    )
    assert woken.sleeping is True
    assert woken.error is None
    assert datetime.now(UTC) - woken.active_at < timedelta(minutes=1)


async def test_addressing_a_ready_launch_only_marks_it_active(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    ready = await address(store, factory, "request-1", state="ready")
    assert (ready.desired_state, ready.state, ready.revision) == ("running", "ready", 1)
    assert datetime.now(UTC) - ready.active_at < timedelta(minutes=1)


@pytest.mark.parametrize("desired", ["stopped", "deleted"])
async def test_addressing_never_wakes_a_launch_its_owner_stopped(launches, desired):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    untouched = await address(
        store, factory, "request-1", desired_state=desired, state="stopped"
    )
    assert (untouched.desired_state, untouched.revision) == (desired, 1)
    assert datetime.now(UTC) - untouched.active_at > timedelta(minutes=59)


async def test_addressing_a_missing_launch_returns_none(launches):
    store, factory = launches
    assert await address(store, factory, "no-such-launch") is None


async def test_addressing_preserves_a_sleeping_worker_error(launches):
    store, factory = launches
    await reserve(store, factory, "request-1", "helper")
    launch = await address(
        store,
        factory,
        "request-1",
        desired_state="stopped",
        state="error",
        sleeping=True,
        error="Stop failed",
    )
    assert (launch.desired_state, launch.state, launch.revision, launch.error) == (
        "stopped",
        "error",
        1,
        "Stop failed",
    )
