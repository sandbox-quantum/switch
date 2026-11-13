"""A paused owner, or one turned off in this workspace, gets no
new box, no controller and no enrolment code, and can't undo the block from
their own machine page."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from switch_core.db.models import TenantMember, User, require_tenant_id
from switch_core.db.stores.hosted_machine_store import (
    MACHINE_PAUSED,
    MACHINE_TURNED_OFF,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    ControllerApp,
    controller_app,
    machine_of,
    prepare,
    update_machine,
)


async def _lifecycle(app: ControllerApp, action: str, revision: int):
    return await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": action, "revision": revision},
    )


async def _turn_off(app: ControllerApp) -> None:
    async with app.factory() as session:
        member = await session.get(TenantMember, (require_tenant_id(), app.owner_id))
        assert member is not None
        member.hosted_enabled = False
        await session.commit()


async def _pause(app: ControllerApp) -> None:
    """What an operator's pause leaves: the mark on the user, the box stopped."""
    async with app.factory() as session:
        user = await session.get(User, app.owner_id)
        assert user is not None
        user.hosted_paused_at = datetime.now(UTC)
        await session.commit()
    await update_machine(
        app.factory, app.machine_id, desired_state="stopped", stop_reason="paused"
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_paused_owner_can_neither_start_stop_nor_retry(controller_app):  # noqa: F811
    app = controller_app
    await _pause(app)
    for action in ("start", "stop", "retry"):
        refused = await _lifecycle(app, action, 1)
        assert refused.status_code == 409, action
        assert refused.json() == {"detail": MACHINE_PAUSED}
    machine = await machine_of(app.factory, app.machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "paused")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_turned_off_owner_can_neither_start_stop_nor_retry(controller_app):  # noqa: F811
    app = controller_app
    await _turn_off(app)
    for action in ("start", "stop", "retry"):
        refused = await _lifecycle(app, action, 1)
        assert refused.status_code == 409, action
        assert refused.json() == {"detail": MACHINE_TURNED_OFF}


@pytest.mark.usefixtures("hosted_v2_on")
async def test_ensure_is_refused_for_a_turned_off_owner(controller_app):  # noqa: F811
    app = controller_app
    await _turn_off(app)
    off = await app.client.post("/hosted-machines/ensure")
    assert off.status_code == 409, off.text
    assert MACHINE_TURNED_OFF in off.text


async def test_ensure_never_wakes_a_paused_box(controller_app):  # noqa: F811
    app = controller_app
    await _pause(app)
    # Returned as it is, like a box its owner stopped: never started again.
    response = await app.client.post("/hosted-machines/ensure")
    assert response.status_code == 200, response.text
    assert response.json()["machine_id"] == app.machine_id
    machine = await machine_of(app.factory, app.machine_id)
    assert (machine.desired_state, machine.stop_reason) == ("stopped", "paused")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_prepare_hands_out_no_code_for_a_blocked_workspace(controller_app):  # noqa: F811
    app = controller_app
    await _turn_off(app)
    off = await prepare(app.client, app.machine_id)
    # Nothing to boot, refused with the block's own words.
    assert off.status_code == 409, off.text
    assert MACHINE_TURNED_OFF in off.text
    assert app.enrollment.minted == []
    # Never marked in error: the clean-up must not act on a blocked box.
    machine = await machine_of(app.factory, app.machine_id)
    assert machine.state != "error" and machine.error is None


# The pause is v2's: with v2 off a claim never reads it.
@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_paused_owner_with_no_box_claims_none(controller_app):  # noqa: F811
    app = controller_app
    await _pause(app)
    await update_machine(
        app.factory, app.machine_id, state="deleted", desired_state="deleted"
    )
    refused = await app.client.post("/hosted-machines/ensure")
    assert refused.status_code == 409, refused.text
    assert MACHINE_PAUSED in refused.text


class _NoRevoke:
    async def revoke_controllers(
        self, session, tenant_id, controller_ids, revoked_by=None
    ) -> None:
        return None

    def announce_revoked(self, controller_ids) -> None:
        return None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_code_from_before_a_pause_never_enrols_after_the_resume(
    controller_app,  # noqa: F811
):
    """The pause retires the unused code, and the resume
    leaves `prepare` to mint a fresh one, only once the mark is cleared."""
    from switch_core.visibility.hosted_access import HostedAccess
    from switch_core.visibility.keyed_id import KeyedIdKey

    app = controller_app
    before = (await prepare(app.client, app.machine_id)).json()["controllers"][0]
    assert before["enrollment_code"] == "swce_synthetic-1"
    access = HostedAccess(
        session_factory=app.factory,
        revoker=_NoRevoke(),
        key=KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1"),
        keyring=app.config.keyring,
    )
    await access.pause(actor_id=app.owner_id, user_id=app.owner_id, reason="Misuse")
    for task in list(access.pending):
        task.cancel()
    assert "swce_synthetic-1" in app.enrollment.retired
    # While paused, `prepare` hands out no code at all, and the box isn't in error.
    paused = await prepare(app.client, app.machine_id)
    assert paused.status_code == 409, paused.text
    assert MACHINE_PAUSED in paused.text
    assert (await machine_of(app.factory, app.machine_id)).state != "error"
    await access.resume(actor_id=app.owner_id, user_id=app.owner_id, reason="Cleared")
    resumed = await prepare(app.client, app.machine_id)
    assert resumed.status_code == 200, resumed.text
    after = resumed.json()["controllers"][0]
    assert after["enrollment_code"] not in (None, "swce_synthetic-1")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_owners_summary_shows_a_marked_box_as_stopped_by_its_owner(
    controller_app,  # noqa: F811
):
    """Console's machine schema takes only `idle` or `owner`: a marked box must
    still parse, as stopped, rather than break the owner's cloud card."""
    app = controller_app
    await _pause(app)
    listed = await app.client.get("/hosted-machines")
    assert listed.status_code == 200, listed.text
    [machine] = listed.json()["machines"]
    assert (machine["desired_state"], machine["stop_reason"]) == ("stopped", "owner")
    one = await app.client.get(f"/hosted-machines/{app.machine_id}")
    assert one.json()["stop_reason"] == "owner"
