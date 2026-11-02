"""Visibility V3 at the management routes: a cloud box's controller is refused
token exchange and credential rotation while its owner is paused, and a
controller Core revoked is refused on the next request, also by a second Core
process that never saw it cached (security, design v2.3). Against Postgres."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, AgentController, User
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
    only kind the V3 refusals apply to."""
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


async def test_a_paused_owners_cloud_controller_cant_rotate_or_exchange(
    harness: Harness,
) -> None:
    controller = await _cloud_controller(harness)
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
    """Security: the revoke deletes the sealed logins, and a
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
    # V3's path: revoke through the service, then announce.
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
    """E11, security: only a pause or turn-off marks its revoke (`revoked_by`), so a
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
    other caller (enrolment replacement, V0's revive, a path added later) leaves no
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
