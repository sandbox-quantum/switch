"""The warm pool's claim (T1): a new person's first click takes a waiting
pool box, in the claim's own transaction, or gets a box made from scratch at
once (the fallback). Against Postgres, through `POST /hosted-machines/ensure`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import (
    CloudMachine,
    HostedPoolBox,
    ServerAuditEvent,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores import hosted_pool_store
from switch_core.db.stores.hosted_machine_store import CloudMachineStore, lock_claims
from switch_core.gateway.auth import get_current_user
from switch_core.visibility.box_provision import (
    box_namespace_for,
    claim_provision,
    pool_pick_for,
)
from switch_core.visibility.keyed_id import KeyedIdKind
from tests.switch_core.gateway.test_hosted_provisioner import (  # noqa: F401
    KEY,
    provisioner_app,
)

pytestmark = pytest.mark.usefixtures("hosted_v2_on")

REVISION = "r7"
CAPABLE = ["box_keyed_names", "pool", "bind"]


async def _person(factory, email: str) -> User:
    async with factory() as session:
        person = User(name="person", email=email, role="user", password_hash="x")
        session.add(person)
        await session.flush()
        session.add(
            TenantMember(
                tenant_id=require_tenant_id(), user_id=person.id, role="member"
            )
        )
        await session.commit()
        return person


async def _operator(factory, *, capabilities=CAPABLE, seen_at=None) -> None:
    async with factory() as session:
        await hosted_pool_store.record_operator(
            session,
            template_revision=REVISION,
            capabilities=capabilities,
            now=seen_at or datetime.now(UTC),
        )
        await session.commit()


async def _waiting_box(factory, *, revision=REVISION, ready_at=None) -> str:
    """A pool box the operator made: waiting, at `revision`."""
    now = ready_at or datetime.now(UTC)
    async with factory() as session:
        (box_id,) = await hosted_pool_store.request_boxes(session, 1, now)
        assert await hosted_pool_store.mark_waiting(
            session,
            box_id,
            namespace=box_namespace_for(KEY.keyed_id(KeyedIdKind.BOX, box_id)),
            template_revision=revision,
            now=now,
        )
        await session.commit()
    return box_id


def _pooled(app, size: int = 1) -> None:
    app.config.hosted_pool_size = size


async def _ensure(app, person: User):
    app.client._transport.app.dependency_overrides[get_current_user] = (  # type: ignore[attr-defined]
        lambda: person
    )
    return await app.client.post("/hosted-machines/ensure")


async def _provisions(factory, machine_id: str) -> list[dict]:
    async with factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent)
            .where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_PROVISION,
                ServerAuditEvent.details["phase"].astext == "requested",
                ServerAuditEvent.details["machine_id"].astext == machine_id,
            )
            .order_by(ServerAuditEvent.occurred_at)
        )
        return [dict(row.details or {}) for row in rows]


async def _claimed_entries(factory) -> list[ServerAuditEvent]:
    async with factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent).where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_POOL_BOX_CLAIMED
            )
        )
        return list(rows)


async def _pool_row(factory, box_id: str) -> HostedPoolBox:
    async with factory() as session:
        row = await hosted_pool_store.get(session, box_id)
    assert row is not None
    return row


async def test_a_new_person_takes_the_waiting_box_in_one_transaction(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    person = await _person(app.factory, "new@example.com")

    answer = await _ensure(app, person)
    assert answer.status_code == 200, answer.text
    assert answer.json()["machine_id"] == box_id  # the pool box's id
    assert (await _pool_row(app.factory, box_id)).state == "claimed"
    async with app.factory() as session:
        machine = await session.get(CloudMachine, box_id)
    assert machine is not None
    assert (machine.owner_id, machine.backend, machine.state) == (
        person.id,
        "box",
        "queued",
    )
    # One request, the bind (the sweep's ask finds it and writes no other).
    [bind] = await _provisions(app.factory, box_id)
    assert bind["kind"] == "bind"
    assert bind["user"] == KEY.keyed_id(KeyedIdKind.USER, person.id)
    [claimed] = await _claimed_entries(app.factory)
    assert claimed.target_id == KEY.keyed_id(KeyedIdKind.BOX, box_id)
    assert claimed.details == {
        "machine_id": box_id,
        "user": KEY.keyed_id(KeyedIdKind.USER, person.id),
    }
    # The bind is handed out with the box's own name.
    async with app.factory() as session:
        handed = await claim_provision(
            session, datetime.now(UTC), capabilities=frozenset(CAPABLE)
        )
        await session.commit()
    assert handed is not None and handed.machine_id == box_id
    assert (handed.kind, handed.namespace) == (
        "bind",
        box_namespace_for(KEY.keyed_id(KeyedIdKind.BOX, box_id)),
    )


async def test_with_no_box_free_the_person_gets_one_made_at_once(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    person = await _person(app.factory, "new@example.com")

    answer = await _ensure(app, person)
    assert answer.status_code == 200, answer.text
    machine_id = answer.json()["machine_id"]
    [made] = await _provisions(app.factory, machine_id)
    assert made.get("kind", "provision") == "provision"
    assert not await _claimed_entries(app.factory)


@pytest.mark.parametrize("stale", ["revision", "age"])
async def test_a_box_at_an_old_revision_or_older_than_a_day_is_never_taken(
    provisioner_app,  # noqa: F811
    stale: str,
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(
        app.factory,
        revision="r6" if stale == "revision" else REVISION,
        ready_at=(datetime.now(UTC) - timedelta(hours=25) if stale == "age" else None),
    )
    person = await _person(app.factory, "new@example.com")
    answer = await _ensure(app, person)
    assert answer.json()["machine_id"] != box_id
    assert (await _pool_row(app.factory, box_id)).state == "waiting"


@pytest.mark.parametrize("gate", ["stale_operator", "cannot_bind", "no_pool"])
async def test_without_an_operator_that_can_bind_or_a_pool_nothing_is_taken(
    provisioner_app,  # noqa: F811
    gate: str,
) -> None:
    app = provisioner_app
    _pooled(app, 0 if gate == "no_pool" else 1)
    await _operator(
        app.factory,
        capabilities=["box_keyed_names", "pool"] if gate == "cannot_bind" else CAPABLE,
        seen_at=(
            datetime.now(UTC) - timedelta(minutes=10)
            if gate == "stale_operator"
            else None
        ),
    )
    box_id = await _waiting_box(app.factory)
    person = await _person(app.factory, "new@example.com")
    answer = await _ensure(app, person)
    assert answer.status_code == 200, answer.text
    assert answer.json()["machine_id"] != box_id
    assert (await _pool_row(app.factory, box_id)).state == "waiting"
    assert not await _claimed_entries(app.factory)


async def test_a_full_per_minute_window_takes_no_box(
    provisioner_app,  # noqa: F811
) -> None:
    """A claim counts as a request in the per-minute window, so a workspace
    can't drain the pool faster than it could have boxes made."""
    app = provisioner_app
    _pooled(app)
    app.config.hosted_provisions_per_minute = 0
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    person = await _person(app.factory, "new@example.com")
    await _ensure(app, person)
    assert (await _pool_row(app.factory, box_id)).state == "waiting"


async def test_the_second_person_gets_the_fallback_and_the_pool_is_refilled(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    first = await _person(app.factory, "first@example.com")
    second = await _person(app.factory, "second@example.com")

    assert (await _ensure(app, first)).json()["machine_id"] == box_id
    # Refilled just after the claim: one new pool box asked for.
    async with app.factory() as session:
        counted = await hosted_pool_store.counts(session)
    assert (counted["claimed"], counted["requested"]) == (1, 1)
    other = (await _ensure(app, second)).json()["machine_id"]
    assert other != box_id
    [made] = await _provisions(app.factory, other)
    assert made.get("kind", "provision") == "provision"


async def test_a_claim_that_rolls_back_leaves_the_box_waiting(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    person = await _person(app.factory, "new@example.com")
    async with app.factory() as session:
        await lock_claims(session)
        claimed = await CloudMachineStore().claim(
            session,
            app.factory,
            owner_id=person.id,
            capacity=5,
            now=datetime.now(UTC),
            backend="box",
            pool_pick=pool_pick_for(app.config, app.settings),  # type: ignore[arg-type]
        )
        assert claimed.from_pool and claimed.machine.id == box_id
        await session.rollback()
    assert (await _pool_row(app.factory, box_id)).state == "waiting"
    assert not await _claimed_entries(app.factory)
    assert not await _provisions(app.factory, box_id)
    async with app.factory() as session:
        assert await session.get(CloudMachine, box_id) is None


async def test_an_owner_with_a_machine_never_takes_a_box(
    provisioner_app,  # noqa: F811
) -> None:
    """The fixture's owner already has a machine: the pool is for brand-new
    rows only."""
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    answer = await _ensure(app, app.owner)
    assert answer.json()["machine_id"] == app.machine_id
    assert (await _pool_row(app.factory, box_id)).state == "waiting"
