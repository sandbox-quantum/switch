"""A new user's box, asked for by Core and made by the provisioner.

Core writes one run-once provision request per machine that needs a box,
within two caps; the provisioner claims it on its own credential (and only
there), and reports the result, checked against the request."""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    CloudMachine,
    ServerAuditEvent,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import router as controller_router
from switch_core.gateway.hosted_machines import router as machines_router
from switch_core.gateway.hosted_provisioner import router as provisioner_router
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.visibility.alerts import Condition, open_alerts
from switch_core.visibility.box_provision import (
    LEASE,
    TTL,
    ProvisionRefused,
    ask_for_box,
    claim_provision,
    expire_provisions,
    namespace_for,
    open_provision_machines,
    record_provision_result,
    request_box_if_needed,
)
from switch_core.visibility.dependencies import set_process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from tests.switch_core.gateway.test_hosted_controller import (
    TEST_KEYRING,
    TOKEN,
    FakeEnrollment,
)
from tests.switch_core.hosted_machine_helpers import link_controller, seed_machine

PROVISIONER = "SYNTHETIC-PROVISIONER-CREDENTIAL-FOR-TESTS"
KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")


async def _owner_and_machine(factory, *, email: str, state: str = "provisioning"):
    async with factory() as session:
        owner = User(name="owner", email=email, role="user", password_hash="x")
        session.add(owner)
        await session.flush()
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner.id, role="member")
        )
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            state=state,
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        machine.backend = "box"  # box provisioning made it
        await session.commit()
        return owner, machine.id


async def _allow_all(machine) -> bool:
    return True


async def _ask(factory, machine_id: str, *, now=None, per_minute=5, ceiling=50):
    return await request_box_if_needed(
        factory,
        machine_id=machine_id,
        key=KEY,
        now=now or datetime.now(UTC),
        per_minute=per_minute,
        ceiling=ceiling,
        allowed=_allow_all,
    )


async def _entries(factory) -> list[ServerAuditEvent]:
    async with factory() as session:
        rows = await session.execute(
            select(ServerAuditEvent)
            .where(ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_PROVISION)
            .order_by(ServerAuditEvent.occurred_at)
        )
        return list(rows.scalars().all())


@pytest.fixture
async def provisioner_app(session_factory):
    owner, machine_id = await _owner_and_machine(session_factory, email="p@example.com")
    settings = HostedControllerSettings(
        allowed_tenant_ids=[require_tenant_id()],
        token=TOKEN,
        provisioner_token=PROVISIONER,
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    config = SimpleNamespace(
        keyring=TEST_KEYRING,
        hosted_idle_stop_minutes=0,
        hosted_disk_retention_days=7,
        hosted_launch_capacity=5,
        hosted_agents_enabled=True,
        hosted_box_provisioning=True,
        hosted_provisions_per_minute=5,
        hosted_box_ceiling=50,
    )
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.include_router(controller_router)
    app.include_router(machines_router)
    app.include_router(provisioner_router)

    async def session():
        async with session_factory() as opened:
            yield opened

    async def current_user():
        return owner

    app.dependency_overrides[get_session] = session
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_current_user] = current_user
    set_cloud_enrollment(FakeEnrollment())
    set_process_keyed_id_key(KEY)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://switch.example.com",
        ) as client:
            yield SimpleNamespace(
                client=client,
                factory=session_factory,
                machine_id=machine_id,
                owner=owner,
                config=config,
                settings=settings,
            )
    finally:
        set_cloud_enrollment(None)
        set_process_keyed_id_key(None)


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token}


async def _claim(app) -> dict:
    claimed = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert claimed.status_code == 200, claimed.text
    return claimed.json()


async def _claim_now(factory, now: datetime) -> str:
    async with factory() as session:
        claimed = await claim_provision(session, now)
        assert claimed is not None
        await session.commit()
        return claimed.claim_token


async def test_each_identity_works_only_on_its_own_routes(provisioner_app) -> None:
    """Three identities, on Core's side: the controller's bearer is
    refused on the provisioner's routes, and the provisioner's on the
    controller's."""
    app = provisioner_app
    for headers in ({}, _bearer("wrong"), _bearer(TOKEN)):
        assert (
            await app.client.post("/hosted-provisioner/claim", headers=headers)
        ).status_code == 401
        result = await app.client.post(
            "/hosted-provisioner/actions/x/result",
            headers=headers,
            json={
                "result": "done",
                "namespace": "agents-user-x",
                "claim_token": "x",
            },
        )
        assert result.status_code == 401
    listed = await app.client.get(
        "/hosted-controller/machines", headers=_bearer(PROVISIONER)
    )
    assert listed.status_code == 401
    assert (
        await app.client.post("/hosted-provisioner/claim", headers=_bearer(PROVISIONER))
    ).status_code == 204


async def test_the_two_credentials_must_differ() -> None:
    with pytest.raises(ValueError, match="separate identities"):
        HostedControllerSettings(
            allowed_tenant_ids=None,
            token=TOKEN,
            provisioner_token=TOKEN,
            agent_api_endpoint="https://switch.example.com/api/agent",
        )


async def test_a_new_machine_asks_once_and_the_provisioner_claims_it(
    provisioner_app,
) -> None:
    app = provisioner_app
    first = await _ask(app.factory, app.machine_id)
    assert isinstance(first, str)
    assert await _ask(app.factory, app.machine_id) is None  # safe to repeat
    [request] = await _entries(app.factory)
    assert request.target_id == KEY.keyed_id(KeyedIdKind.BOX, app.machine_id)
    assert request.details["user"] == KEY.keyed_id(KeyedIdKind.USER, app.owner.id)
    assert "owner" not in repr(request.details) and app.owner.email not in repr(
        request.details
    )

    claimed = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert claimed.status_code == 200
    body = claimed.json()
    assert body == {
        "action_id": first,
        "machine_id": app.machine_id,
        "user_keyed_id": KEY.keyed_id(KeyedIdKind.USER, app.owner.id),
        "size": None,  # one box size for now: the provisioner's default
        "lease_seconds": int(LEASE.total_seconds()),
        "claim_token": body["claim_token"],
    }
    assert len(body["claim_token"]) >= 32
    # Only the token's hash is kept.
    claimed_entry = (await _entries(app.factory))[-1]
    assert body["claim_token"] not in repr(claimed_entry.details)
    # The lease holds: nothing else to claim.
    again = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert again.status_code == 204


async def test_a_lapsed_lease_can_be_claimed_again(provisioner_app) -> None:
    app = provisioner_app
    now = datetime.now(UTC)
    await _ask(app.factory, app.machine_id, now=now)
    stale = await _claim_now(app.factory, now)
    async with app.factory() as session:
        assert await claim_provision(session, now + timedelta(seconds=30)) is None
    current = await _claim_now(app.factory, now + LEASE + timedelta(seconds=1))
    assert current != stale
    namespace = namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id))
    action = (await _entries(app.factory))[0].id
    # The worker whose lease passed can't report over the new claim
    # (a stale worker), but the current one can, even after
    # its own lease, while the request is inside its 15 minutes.
    async with app.factory() as session:
        with pytest.raises(ProvisionRefused, match="current claim"):
            await record_provision_result(
                session,
                action_id=action,
                result="done",
                namespace=namespace,
                failed_at=None,
                claim_token=stale,
                now=now + LEASE * 2,
            )
        await session.rollback()
    async with app.factory() as session:
        await record_provision_result(
            session,
            action_id=action,
            result="done",
            namespace=namespace,
            failed_at=None,
            claim_token=current,
            now=now + LEASE * 3,
        )
        await session.commit()


async def test_the_result_is_checked_against_its_request(provisioner_app) -> None:
    app = provisioner_app
    action = await _ask(app.factory, app.machine_id)
    user = KEY.keyed_id(KeyedIdKind.USER, app.owner.id)
    url = f"/hosted-provisioner/actions/{action}/result"
    headers = _bearer(PROVISIONER)
    unclaimed = await app.client.post(
        url,
        headers=headers,
        json={"result": "done", "namespace": namespace_for(user), "claim_token": "x"},
    )
    assert unclaimed.status_code == 409
    token = (await _claim(app))["claim_token"]
    wrong = await app.client.post(
        url,
        headers=headers,
        json={
            "result": "done",
            "namespace": "agents-user-k1-0000000000000000",
            "claim_token": token,
        },
    )
    assert wrong.status_code == 422
    unnamed = await app.client.post(
        url,
        headers=headers,
        json={
            "result": "failed",
            "namespace": namespace_for(user),
            "claim_token": token,
        },
    )
    assert unnamed.status_code == 422
    blocked = await app.client.post(
        url,
        headers=headers,
        json={
            "result": "failed",
            "namespace": namespace_for(user),
            "failed_at": "blocked",
            "claim_token": token,
        },
    )
    assert blocked.status_code == 422  # Core's own code, never the provisioner's
    extra = await app.client.post(
        url,
        headers=headers,
        json={
            "result": "done",
            "namespace": namespace_for(user),
            "claim_token": token,
            "note": "x",
        },
    )
    assert extra.status_code == 422
    not_token = await app.client.post(
        url,
        headers=headers,
        json={"result": "done", "namespace": namespace_for(user), "claim_token": "x"},
    )
    assert not_token.status_code == 409
    finished = {
        "result": "done",
        "namespace": namespace_for(user),
        "claim_token": token,
    }
    done = await app.client.post(url, headers=headers, json=finished)
    assert done.status_code == 204
    twice = await app.client.post(url, headers=headers, json=finished)
    assert twice.status_code == 409
    # With a box made, nothing more is asked for.
    assert await _ask(app.factory, app.machine_id) is None


async def test_a_failed_provision_names_its_step(provisioner_app) -> None:
    app = provisioner_app
    action = await _ask(app.factory, app.machine_id)
    user = KEY.keyed_id(KeyedIdKind.USER, app.owner.id)
    token = (await _claim(app))["claim_token"]
    url = f"/hosted-provisioner/actions/{action}/result"
    old_name = await app.client.post(
        url,
        headers=_bearer(PROVISIONER),
        json={
            "result": "failed",
            "namespace": namespace_for(user),
            "failed_at": "network_policies",
            "claim_token": token,
        },
    )
    assert old_name.status_code == 422  # only the operator contract's codes
    response = await app.client.post(
        url,
        headers=_bearer(PROVISIONER),
        json={
            "result": "failed",
            "namespace": namespace_for(user),
            "failed_at": "ceiling_reached",
            "claim_token": token,
        },
    )
    assert response.status_code == 204
    result = (await _entries(app.factory))[-1]
    assert (
        result.details["result"] == "failed"
        and result.details["step"] == "ceiling_reached"
    )
    # Not asked for again on every sweep: the machine is in
    # error, which the existing retry and clean-up handle.
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        assert (machine.state, machine.error_code) == ("error", "box_not_made")
    assert await _ask(app.factory, app.machine_id) is None
    listed = await app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN))
    assert listed.status_code == 200
    assert len(await _entries(app.factory)) == 3  # request, claim, result


async def test_an_expired_request_is_closed_and_asked_again(provisioner_app) -> None:
    app = provisioner_app
    then = datetime.now(UTC) - TTL - timedelta(minutes=1)
    old = await _ask(app.factory, app.machine_id, now=then)
    assert isinstance(old, str)
    token = await _claim_now(app.factory, then)
    async with app.factory() as session:
        # Written "then" only in its details; age the row itself.
        row = await session.get(ServerAuditEvent, old)
        assert row is not None
        row.occurred_at = then
        await session.commit()
    async with app.factory() as session:
        with pytest.raises(ProvisionRefused, match="expired"):
            await record_provision_result(
                session,
                action_id=old,
                result="done",
                namespace=namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id)),
                failed_at=None,
                claim_token=token,
                now=datetime.now(UTC),
            )
        await session.rollback()
    async with app.factory() as session:
        assert await expire_provisions(session, datetime.now(UTC)) == 1
        await session.commit()
    assert isinstance(await _ask(app.factory, app.machine_id), str)


async def test_a_machine_that_has_run_is_never_asked_for(provisioner_app) -> None:
    """A box made by hand before box provisioning has had a controller: no second box."""
    app = provisioner_app
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        await link_controller(session, machine)
        await session.commit()
    assert await _ask(app.factory, app.machine_id) is None
    assert await _entries(app.factory) == []


async def test_the_rate_cap_and_the_ceiling_hold(provisioner_app) -> None:
    app = provisioner_app
    _, second = await _owner_and_machine(app.factory, email="second@example.com")
    assert isinstance(await _ask(app.factory, app.machine_id, per_minute=1), str)
    assert await _ask(app.factory, second, per_minute=1) == "rate"
    # Finish the first box: with a ceiling of 1, the second waits for room.
    action = (await _entries(app.factory))[0].id
    token = await _claim_now(app.factory, datetime.now(UTC))
    async with app.factory() as session:
        await record_provision_result(
            session,
            action_id=action,
            result="done",
            namespace=namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id)),
            failed_at=None,
            claim_token=token,
            now=datetime.now(UTC),
        )
        await session.commit()
    assert await _ask(app.factory, second, ceiling=1) == "ceiling"
    assert isinstance(await _ask(app.factory, second, ceiling=2), str)


async def test_the_sweep_holds_the_start_clock_while_a_box_is_made(
    provisioner_app,
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        machine.updated_at = datetime.now(UTC) - timedelta(minutes=11)
        await session.commit()
        assert app.machine_id in await open_provision_machines(
            session, datetime.now(UTC)
        )
    listed = await app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN))
    assert listed.status_code == 200
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None and machine.state != "error"


async def test_the_gates_are_checked_again_at_claim(provisioner_app) -> None:
    """A user paused since Core asked: the claim hands nothing out, and the
    request ends failed at `blocked`."""
    app = provisioner_app
    action = await _ask(app.factory, app.machine_id)
    async with app.factory() as session:
        owner = await session.get(User, app.owner.id)
        assert owner is not None
        owner.hosted_paused_at = datetime.now(UTC)
        await session.commit()
    claimed = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert claimed.status_code == 204
    result = (await _entries(app.factory))[-1]
    assert result.details == {
        "phase": "result",
        "result": "failed",
        "step": "blocked",
        "linked_to": action,
        "machine_id": app.machine_id,
    }


async def test_a_claim_with_provisioning_turned_off_is_blocked(
    provisioner_app,
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    app.config.hosted_box_provisioning = False
    claimed = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert claimed.status_code == 204
    assert (await _entries(app.factory))[-1].details["step"] == "blocked"


async def test_a_revived_machine_is_asked_for_again(provisioner_app) -> None:
    """After clean-up and revival (same id), the old box is gone: a new one is
    asked for even though the machine has run and once had a box made."""
    app = provisioner_app
    first = await _ask(app.factory, app.machine_id)
    assert isinstance(first, str)
    token = await _claim_now(app.factory, datetime.now(UTC))
    async with app.factory() as session:
        await record_provision_result(
            session,
            action_id=first,
            result="done",
            namespace=namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id)),
            failed_at=None,
            claim_token=token,
            now=datetime.now(UTC),
        )
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        await link_controller(session, machine)
        await session.commit()
    assert await _ask(app.factory, app.machine_id) is None  # has its box
    async with app.factory() as session:
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_REVIVED,
            target_type="box",
            target_id=KEY.keyed_id(KeyedIdKind.BOX, app.machine_id),
            details={"by": "core", "machine_id": app.machine_id},
        )
        await session.commit()
    again = await _ask(app.factory, app.machine_id)
    assert isinstance(again, str) and again != first
    assert await _ask(app.factory, app.machine_id) is None  # once


async def _open_cap_alerts(factory) -> set[str]:
    async with factory() as session:
        return {
            alert.target_id
            for alert in await open_alerts(session, [Condition.BOX_CAP_REACHED])
        }


async def test_a_cap_raises_its_alert_and_a_write_under_it_clears_it(
    provisioner_app,
) -> None:
    """A10: the request waiting on the per-minute cap raises one
    `box_cap_reached` for `rate`; the next one written under it clears it."""
    app = provisioner_app
    app.config.hosted_provisions_per_minute = 1
    _, second = await _owner_and_machine(app.factory, email="second@example.com")
    now = datetime.now(UTC)
    first = await ask_for_box(
        app.factory,
        machine_id=app.machine_id,
        config=app.config,
        settings=app.settings,
        now=now,
    )
    assert isinstance(first, str)
    assert await _open_cap_alerts(app.factory) == set()
    assert (
        await ask_for_box(
            app.factory,
            machine_id=second,
            config=app.config,
            settings=app.settings,
            now=now,
        )
        == "rate"
    )
    assert await _open_cap_alerts(app.factory) == {"rate"}
    later = now + timedelta(minutes=2)
    written = await ask_for_box(
        app.factory,
        machine_id=second,
        config=app.config,
        settings=app.settings,
        now=later,
    )
    assert isinstance(written, str)
    assert await _open_cap_alerts(app.factory) == set()


async def test_a_node_type_is_never_sent_as_a_box_size(provisioner_app) -> None:
    """There is one box size: whatever an observation left in `instance_type`
    (a node type), the request carries no size."""
    app = provisioner_app
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        machine.instance_type = "m7i.2xlarge"
        await session.commit()
    await _ask(app.factory, app.machine_id)
    [request] = await _entries(app.factory)
    assert request.details["size"] is None
    assert (await _claim(app))["size"] is None


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_v1_machine_is_never_asked_for(provisioner_app) -> None:
    """Core's half: a `vm` row is `serve`'s, so box provisioning never asks
    the provisioner for it, while the `box` row beside it is asked for."""
    app = provisioner_app
    _, v1 = await _owner_and_machine(app.factory, email="v1@example.com")
    async with app.factory() as session:
        machine = await session.get(CloudMachine, v1)
        assert machine is not None
        machine.backend = "vm"
        await session.commit()
    assert await _ask(app.factory, v1) is None
    assert isinstance(await _ask(app.factory, app.machine_id), str)
    [request] = await _entries(app.factory)
    assert request.details["machine_id"] == app.machine_id
    listed = await app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN))
    backends = {m["machine_id"]: m["backend"] for m in listed.json()["machines"]}
    assert backends == {app.machine_id: "box", v1: "vm"}


async def test_a_claim_waits_for_a_result_in_flight(provisioner_app) -> None:
    """A result and a re-claim take the same action lock, so a
    stale worker's result can't land just as the action is claimed again:
    the claim waits, then sees the result and hands nothing out."""
    app = provisioner_app
    now = datetime.now(UTC)
    action = await _ask(app.factory, app.machine_id, now=now)
    assert isinstance(action, str)
    token = await _claim_now(app.factory, now)
    namespace = namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id))
    async with app.factory() as reporting:
        await record_provision_result(
            reporting,
            action_id=action,
            result="done",
            namespace=namespace,
            failed_at=None,
            claim_token=token,
            now=now + LEASE + timedelta(seconds=1),
        )

        async def reclaim():
            async with app.factory() as claiming:
                claimed = await claim_provision(
                    claiming, now + LEASE + timedelta(seconds=2)
                )
                await claiming.commit()
                return claimed

        waiting = asyncio.create_task(reclaim())
        await asyncio.sleep(0.5)
        assert not waiting.done()  # held by the result's lock
        await reporting.commit()
    assert await asyncio.wait_for(waiting, timeout=10) is None


async def test_a_claim_with_hosted_agents_switched_off_is_blocked(
    provisioner_app,
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    app.config.hosted_agents_enabled = False
    claimed = await app.client.post(
        "/hosted-provisioner/claim", headers=_bearer(PROVISIONER)
    )
    assert claimed.status_code == 204
    assert (await _entries(app.factory))[-1].details["step"] == "blocked"


async def test_a_malformed_action_id_is_refused(provisioner_app) -> None:
    app = provisioner_app
    for bad in ("x" * 65, "a_b", "a.b"):
        response = await app.client.post(
            f"/hosted-provisioner/actions/{bad}/result",
            headers=_bearer(PROVISIONER),
            json={"result": "done", "namespace": "agents-user-x", "claim_token": "x"},
        )
        assert response.status_code == 422, bad


async def test_the_request_checks_the_gates_itself(provisioner_app) -> None:
    """The request checks every gate itself, not only its callers.
    A paused owner, or hosted agents switched off, gets no request at all."""
    app = provisioner_app
    async with app.factory() as session:
        owner = await session.get(User, app.owner.id)
        assert owner is not None
        owner.hosted_paused_at = datetime.now(UTC)
        await session.commit()
    asked = await ask_for_box(
        app.factory,
        machine_id=app.machine_id,
        config=app.config,
        settings=app.settings,
        now=datetime.now(UTC),
    )
    assert asked is None
    async with app.factory() as session:
        owner = await session.get(User, app.owner.id)
        assert owner is not None
        owner.hosted_paused_at = None
        await session.commit()
    app.config.hosted_agents_enabled = False
    assert (
        await ask_for_box(
            app.factory,
            machine_id=app.machine_id,
            config=app.config,
            settings=app.settings,
            now=datetime.now(UTC),
        )
        is None
    )
    assert await _entries(app.factory) == []
    app.config.hosted_agents_enabled = True
    assert isinstance(
        await ask_for_box(
            app.factory,
            machine_id=app.machine_id,
            config=app.config,
            settings=app.settings,
            now=datetime.now(UTC),
        ),
        str,
    )
