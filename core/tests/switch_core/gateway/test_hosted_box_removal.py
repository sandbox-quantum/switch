"""Automated box removal, Core's half: the provisioner claims a box named for
removal and confirms it gone; the remover checks with Core before every delete
and reports the `box-removals` entries it reads. Each route on its one bearer.
Against Postgres."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import SecretStr
from sqlalchemy import select

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import CloudMachine, ServerAuditEvent
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineStore,
    box_deleted,
    lock_claims,
)
from switch_core.visibility.alerts import Condition, open_alerts
from switch_core.visibility.box_provision import (
    box_namespace_for,
    claim_provision,
    namespace_for,
    removal_pending,
)
from switch_core.visibility.box_removal import stuck_removals
from switch_core.visibility.keyed_id import KeyedIdKind
from tests.switch_core.gateway.test_hosted_controller import TOKEN
from tests.switch_core.gateway.test_hosted_provisioner import (  # noqa: F401
    KEY,
    PROVISIONER,
    _ask,
    _bearer,
    provisioner_app,
)

pytestmark = pytest.mark.usefixtures("hosted_v2_on")

REAPER = "SYNTHETIC-REMOVAL-REAPER-CREDENTIAL-0123456789"
REMOVER = "SYNTHETIC-REMOVAL-REMOVER-CREDENTIAL-012345678"
OPERATOR = "SYNTHETIC-REMOVAL-OPERATOR-CREDENTIAL-012345678"


@pytest.fixture(autouse=True)
def _fresh_refusal_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests send many refused bearers on purpose: each gets its own
    refusal budget, so none is locked out, and none spends another's."""
    from switch_core.bridges.agent import refusals

    monkeypatch.setattr(refusals, "_DEFAULT", None)


@pytest.fixture
def app(provisioner_app):  # noqa: F811
    provisioner_app.settings.reaper_token = SecretStr(REAPER)
    provisioner_app.settings.remover_token = SecretStr(REMOVER)
    provisioner_app.settings.operator_token = SecretStr(OPERATOR)
    return provisioner_app


def _person_keyed(app) -> str:
    return namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id))


async def _delete(app, machine_id: str | None = None) -> None:
    """The machine wanted deleted and its box scaled to 0: `box_deleted` names
    it for removal, as in production."""
    async with app.factory() as session:
        machine = await CloudMachineStore().locked(
            session, machine_id or app.machine_id
        )
        assert machine is not None
        machine.desired_state = "deleted"
        await box_deleted(session, machine, datetime.now(UTC))
        await session.commit()


async def _claim(app) -> dict:
    answer = await app.client.post(
        "/hosted-provisioner/removals/claim", headers=_bearer(PROVISIONER)
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


async def _check(app, namespace: str, machine_id: str | None = None):
    return await app.client.get(
        f"/hosted-provisioner/removals/{machine_id or app.machine_id}",
        params={"namespace": namespace},
        headers=_bearer(REMOVER),
    )


async def _gone(app, token: str, machine_id: str | None = None):
    return await app.client.post(
        f"/hosted-provisioner/removals/{machine_id or app.machine_id}/gone",
        headers=_bearer(PROVISIONER),
        json={"claim_token": token},
    )


async def _removed(app) -> list[ServerAuditEvent]:
    async with app.factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent).where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REMOVED
            )
        )
        return list(rows)


async def _alerted(app) -> set[str]:
    async with app.factory() as session:
        alerts = await open_alerts(session, (Condition.BOX_REMOVAL_UNJUSTIFIED,))
    return {alert.target_id for alert in alerts}


async def _revive(app):
    async with app.factory() as session:
        await lock_claims(session)

        async def revoke(*_args: object) -> None:
            return None

        claimed = await CloudMachineStore().claim(
            session,
            app.factory,
            owner_id=app.owner.id,
            capacity=5,
            now=datetime.now(UTC),
            revoke=revoke,  # type: ignore[arg-type]
            backend="box",
        )
        await session.commit()
        return claimed.machine


# ── the loop ──


async def test_a_deleted_box_is_claimed_checked_and_confirmed_gone(app) -> None:
    await _delete(app)
    claimed = await _claim(app)
    assert claimed["machine_id"] == app.machine_id
    assert claimed["namespace"] == _person_keyed(app)
    assert claimed["box_keyed_id"] == KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)
    # Nothing else to claim while the lease runs.
    again = await app.client.post(
        "/hosted-provisioner/removals/claim", headers=_bearer(PROVISIONER)
    )
    assert again.status_code == 204

    check = await _check(app, claimed["namespace"])
    assert check.status_code == 200, check.text
    assert check.json() == {"removable": True, "state": "claimed"}

    gone = await _gone(app, claimed["claim_token"])
    assert gone.status_code == 204, gone.text
    [removed] = await _removed(app)
    assert removed.details["namespace"] == claimed["namespace"]
    assert removed.details["machine_id"] == app.machine_id
    # A repeat is harmless, and nothing more is claimed or removable.
    assert (await _gone(app, claimed["claim_token"])).status_code == 204
    assert len(await _removed(app)) == 1
    assert (await _check(app, claimed["namespace"])).json() == {
        "removable": False,
        "state": "gone",
    }
    assert await _alerted(app) == set()


async def test_the_recorded_namespace_is_the_one_claimed(app) -> None:
    """A box made with a box-keyed name is removed under that name."""
    await _ask(app.factory, app.machine_id)
    async with app.factory() as session:
        handed = await claim_provision(
            session, datetime.now(UTC), capabilities=frozenset({"box_keyed_names"})
        )
        await session.commit()
    assert handed is not None
    await _delete(app)
    claimed = await _claim(app)
    assert claimed["namespace"] == handed.namespace
    assert claimed["namespace"] == box_namespace_for(
        KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)
    )


async def test_a_lapsed_lease_is_claimed_again_under_the_same_namespace(app) -> None:
    await _delete(app)
    first = await _claim(app)
    async with app.factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent).where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REMOVAL_CLAIMED
            )
        )
        for row in rows:
            row.details = {
                **(row.details or {}),
                "lease_until": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
            }
        await session.commit()
    second = await _claim(app)
    assert second["namespace"] == first["namespace"]
    assert second["claim_token"] != first["claim_token"]
    # Only the current claim confirms.
    stale = await _gone(app, first["claim_token"])
    assert stale.status_code == 409
    assert (await _gone(app, second["claim_token"])).status_code == 204


async def test_a_slow_removal_confirms_with_its_token_after_the_lease(app) -> None:
    """A removal that outlives its lease, with nobody claiming since, confirms
    with its own token and raises nothing; no claim is handed out while the
    lease is live."""
    await _delete(app)
    claimed = await _claim(app)
    assert claimed["lease_seconds"] == 15 * 60
    # The lease is live: nobody else gets it.
    assert (
        await app.client.post(
            "/hosted-provisioner/removals/claim", headers=_bearer(PROVISIONER)
        )
    ).status_code == 204
    # Past the lease, still nobody has claimed it: the holder's token stands.
    async with app.factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent).where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REMOVAL_CLAIMED
            )
        )
        for row in rows:
            row.details = {
                **(row.details or {}),
                "lease_until": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
            }
        await session.commit()
    assert (await _gone(app, claimed["claim_token"])).status_code == 204
    assert len(await _removed(app)) == 1
    assert await _alerted(app) == set()


# ── the remover's check: never a live box ──


async def test_a_live_box_or_a_wrong_namespace_is_never_removable(app) -> None:
    box = KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)
    live = await _check(app, _person_keyed(app))  # not deleted, never named
    assert live.json() == {"removable": False, "state": "none"}
    assert await _alerted(app) == {box}

    await _delete(app)
    named = await _check(app, _person_keyed(app))  # named, not yet claimed
    assert named.json() == {"removable": False, "state": "pending"}
    claimed = await _claim(app)
    other = box_namespace_for(KEY.keyed_id(KeyedIdKind.BOX, "another-machine"))
    wrong = await _check(app, other)
    assert wrong.json() == {"removable": False, "state": "claimed"}
    assert (await _check(app, claimed["namespace"])).json()["removable"] is True


async def test_a_claimed_removal_is_never_revived_and_a_revived_box_never_claimed(
    app,
) -> None:
    # Revived before any claim: the naming is withdrawn and nothing is claimed.
    await _delete(app)
    revived = await _revive(app)
    assert revived.id == app.machine_id
    async with app.factory() as session:
        assert not await removal_pending(session, app.machine_id)
    assert (
        await app.client.post(
            "/hosted-provisioner/removals/claim", headers=_bearer(PROVISIONER)
        )
    ).status_code == 204
    assert (await _check(app, _person_keyed(app))).json() == {
        "removable": False,
        "state": "cancelled",
    }

    # Deleted again and claimed: the person gets a new machine, not this one.
    await _delete(app)
    await _claim(app)
    fresh = await _revive(app)
    assert fresh.id != app.machine_id
    async with app.factory() as session:
        old = await session.get(CloudMachine, app.machine_id)
    assert old is not None and old.state == "deleted"


async def test_a_confirmation_for_a_machine_not_deleted_is_refused(app) -> None:
    await _delete(app)
    claimed = await _claim(app)
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        machine.state = "queued"  # as if brought back by hand
        await session.commit()
    refused = await _gone(app, claimed["claim_token"])
    assert refused.status_code == 409
    assert await _removed(app) == []
    assert await _alerted(app) == {KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)}


# ── every list entry justified ──


async def test_listed_entries_core_does_not_back_alert(app) -> None:
    await _delete(app)
    claimed = await _claim(app)
    stray = "11111111-2222-3333-4444-555555555555"
    report = await app.client.post(
        "/hosted-provisioner/removals/listed",
        headers=_bearer(REMOVER),
        json={
            "entries": [
                {"namespace": claimed["namespace"], "machine_id": app.machine_id},
                {
                    "namespace": box_namespace_for(
                        KEY.keyed_id(KeyedIdKind.BOX, stray)
                    ),
                    "machine_id": stray,
                },
            ]
        },
    )
    assert report.status_code == 200, report.text
    assert report.json() == {"unjustified": 1, "confirmed_gone": []}
    assert await _alerted(app) == {KEY.keyed_id(KeyedIdKind.BOX, stray)}
    # Still backed once confirmed gone.
    assert (await _gone(app, claimed["claim_token"])).status_code == 204
    again = await app.client.post(
        "/hosted-provisioner/removals/listed",
        headers=_bearer(REMOVER),
        json={
            "entries": [
                {"namespace": claimed["namespace"], "machine_id": app.machine_id}
            ]
        },
    )
    assert again.json() == {"unjustified": 0, "confirmed_gone": [claimed["namespace"]]}


# ── a retired person-keyed name is never issued again ──


async def test_a_retired_person_keyed_name_is_never_issued_again(app) -> None:
    await _delete(app)
    await _claim(app)
    fresh = await _revive(app)  # the person's next machine: a new id
    await _ask(app.factory, fresh.id)
    async with app.factory() as session:
        # An operator that can't make box-keyed names is handed nothing.
        nothing = await claim_provision(session, datetime.now(UTC))
        await session.commit()
    assert nothing is None
    async with app.factory() as session:
        handed = await claim_provision(
            session, datetime.now(UTC), capabilities=frozenset({"box_keyed_names"})
        )
        await session.commit()
    assert handed is not None and handed.machine_id == fresh.id
    assert handed.namespace == box_namespace_for(
        KEY.keyed_id(KeyedIdKind.BOX, fresh.id)
    )
    assert handed.namespace != _person_keyed(app)


# ── stuck removals ──


async def test_a_removal_pending_over_a_day_is_stuck_until_confirmed(app) -> None:
    await _delete(app)
    async with app.factory() as session:
        assert await stuck_removals(session, datetime.now(UTC)) == []
        later = datetime.now(UTC) + timedelta(days=1, minutes=1)
        assert await stuck_removals(session, later) == [app.machine_id]
    claimed = await _claim(app)
    await _gone(app, claimed["claim_token"])
    async with app.factory() as session:
        assert await stuck_removals(session, later) == []


# ── each route on its one bearer ──


@pytest.mark.parametrize(
    ("method", "path", "allowed"),
    [
        ("POST", "/hosted-provisioner/removals/claim", PROVISIONER),
        (
            "POST",
            "/hosted-provisioner/removals/00000000-0000-0000-0000-000000000000/gone",
            PROVISIONER,
        ),
        (
            "GET",
            "/hosted-provisioner/removals/00000000-0000-0000-0000-000000000000"
            "?namespace=agents-user-k1-0123456789abcdef",
            REMOVER,
        ),
        ("POST", "/hosted-provisioner/removals/listed", REMOVER),
    ],
)
async def test_each_route_refuses_every_other_credential(
    app, method: str, path: str, allowed: str
) -> None:
    body = (
        {"entries": []}
        if path.endswith("listed")
        else {"claim_token": "x"}
        if path.endswith("gone")
        else None
    )
    others = [
        b for b in (PROVISIONER, REAPER, REMOVER, TOKEN, OPERATOR) if b != allowed
    ]
    for bearer in others:
        refused = await app.client.request(
            method, path, headers=_bearer(bearer), json=body
        )
        assert refused.status_code == 401, (bearer[:12], refused.text)
    # A person's session carries a cookie, never this bearer.
    session = await app.client.request(
        method, path, headers={"Cookie": "switch_auth=a-session"}, json=body
    )
    assert session.status_code == 401
    accepted = await app.client.request(
        method, path, headers=_bearer(allowed), json=body
    )
    assert accepted.status_code != 401, accepted.text


async def test_the_sweep_raises_and_clears_the_stuck_removal_alert(app) -> None:
    from switch_core.gateway.hosted_controller import sweep_hosted_machines

    async def stuck_alerts() -> set[str]:
        async with app.factory() as session:
            alerts = await open_alerts(session, (Condition.BOX_REMOVAL_STUCK,))
        return {alert.target_id for alert in alerts}

    await _delete(app)
    later = datetime.now(UTC) + timedelta(days=1, minutes=1)
    async with app.factory() as session:
        await sweep_hosted_machines(
            session, app.factory, app.config, app.settings, later
        )
        await session.commit()
    assert await stuck_alerts() == {KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)}
    claimed = await _claim(app)
    await _gone(app, claimed["claim_token"])
    async with app.factory() as session:
        await sweep_hosted_machines(
            session, app.factory, app.config, app.settings, later + timedelta(minutes=1)
        )
        await session.commit()
    assert await stuck_alerts() == set()


# ── the operator's live boxes against its ceiling ──


async def test_the_operators_report_is_kept_and_alerts_near_its_ceiling(app) -> None:
    from switch_core.db.stores import hosted_pool_store

    async def report(live: int, ceiling: int) -> None:
        answer = await app.client.post(
            "/hosted-provisioner/claim",
            headers=_bearer(PROVISIONER),
            json={"boxes_live": live, "ceiling": ceiling},
        )
        assert answer.status_code in (200, 204), answer.text

    async def near() -> set[str]:
        async with app.factory() as session:
            alerts = await open_alerts(session, (Condition.BOX_MAP_NEAR_CEILING,))
        return {alert.target_id for alert in alerts}

    await report(10, 40)
    # The box inventory is taken too (the orphan check reads it).
    inventory = await app.client.post(
        "/hosted-provisioner/claim",
        headers=_bearer(PROVISIONER),
        json={
            "boxes_live": 10,
            "ceiling": 40,
            "boxes": ["agents-box-k1-0123456789abcdef"],
        },
    )
    assert inventory.status_code in (200, 204), inventory.text
    too_many = await app.client.post(
        "/hosted-provisioner/claim",
        headers=_bearer(PROVISIONER),
        json={"boxes": ["agents-box-k1-0123456789abcdef"] * 20_001},
    )
    assert too_many.status_code == 422
    async with app.factory() as session:
        row = await hosted_pool_store.operator(session)
    assert row is not None and (row.boxes_live, row.box_ceiling) == (10, 40)
    assert await near() == set()
    await report(33, 40)  # 82.5%
    assert await near() == {"box_map_80"}
    await report(39, 40)  # 97.5%
    assert await near() == {"box_map_80", "box_map_95"}
    await report(20, 40)
    assert await near() == set()
    # An operator from before sends neither: nothing changes, nothing raised.
    plain = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert plain.status_code in (200, 204)
    async with app.factory() as session:
        row = await hosted_pool_store.operator(session)
    assert row is not None and row.boxes_live is None


async def test_the_reaper_and_the_remover_hold_separate_powers(app) -> None:
    """A leaked reaper token can't check or report removals, and a leaked
    remover token can't list or report pool boxes."""
    reaper_on_removals = await app.client.post(
        "/hosted-provisioner/removals/listed",
        headers=_bearer(REAPER),
        json={"entries": []},
    )
    assert reaper_on_removals.status_code == 401
    remover_on_pool = await app.client.get(
        "/hosted-provisioner/pool/retiring", headers=_bearer(REMOVER)
    )
    assert remover_on_pool.status_code == 401
    with pytest.raises(ValueError, match="separate identity"):
        app.settings.__class__(
            allowed_tenant_ids=None,
            token=TOKEN,
            provisioner_token=PROVISIONER,
            reaper_token=REAPER,
            remover_token=REAPER,
            agent_api_endpoint="https://switch.example.com/api/agent",
        )
