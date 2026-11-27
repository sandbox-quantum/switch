"""The warm pool's claim (T1): a new person's first click takes a waiting
pool box, in the claim's own transaction, or gets a box made from scratch at
once (the fallback). Against Postgres, through `POST /hosted-machines/ensure`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

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
from switch_core.db.stores.hosted_machine_store import (
    BIND_FAILED,
    CloudMachineConflict,
    CloudMachineStore,
    lock_claims,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.hosted_controller import sweep_hosted_machines
from switch_core.observability.catalogue import HOSTED_POOL_CLAIMS, HOSTED_POOL_RETIRED
from switch_core.observability.metrics import MetricsRegistry
from switch_core.visibility.box_provision import (
    ProvisionRefused,
    box_namespace_for,
    boxes_made,
    claim_provision,
    expire_binds,
    pool_pick_for,
    record_pool_box_gone,
    record_provision_result,
    record_provision_step,
    removal_pending,
    sweep_pool,
)
from switch_core.visibility.keyed_id import KeyedIdKind
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _metric_points,
    hosted_metrics,  # noqa: F401  (fixture)
)
from tests.switch_core.gateway.test_hosted_controller import (
    list_machines,
    observe,
    prepare,
)
from tests.switch_core.gateway.test_hosted_provisioner import (  # noqa: F401
    KEY,
    provisioner_app,
)
from tests.switch_core.test_config_gateway_admission import _config

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


# ── the bind's result, and its 30 seconds ──


async def _claimed_bind(app, email: str = "new@example.com"):
    """A person who took the waiting box, and the operator's claim of the
    bind: (person, box id, the claimed bind)."""
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    person = await _person(app.factory, email)
    assert (await _ensure(app, person)).json()["machine_id"] == box_id
    async with app.factory() as session:
        handed = await claim_provision(
            session, datetime.now(UTC), capabilities=frozenset(CAPABLE)
        )
        await session.commit()
    assert handed is not None and handed.kind == "bind"
    return person, box_id, handed


async def _result(app, handed, result: str, failed_at: str | None = None, now=None):
    async with app.factory() as session:
        await record_provision_result(
            session,
            action_id=handed.action_id,
            result=result,
            namespace=handed.namespace,
            failed_at=failed_at,
            claim_token=handed.claim_token,
            now=now or datetime.now(UTC),
        )
        await session.commit()


async def _owner_writing(app, handed, now=None) -> None:
    async with app.factory() as session:
        await record_provision_step(
            session,
            action_id=handed.action_id,
            step="owner_writing",
            claim_token=handed.claim_token,
            now=now or datetime.now(UTC),
        )
        await session.commit()


async def _machine(app, machine_id: str) -> CloudMachine:
    async with app.factory() as session:
        machine = await session.get(CloudMachine, machine_id)
    assert machine is not None
    return machine


async def _to_remove(app, machine_id: str) -> bool:
    async with app.factory() as session:
        return await removal_pending(session, machine_id)


async def _reapable(app) -> list[str]:
    async with app.factory() as session:
        return [row.id for row in await hosted_pool_store.retiring(session)]


async def test_a_bind_done_leaves_the_box_the_persons(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    person, box_id, handed = await _claimed_bind(app)
    await _owner_writing(app, handed)
    await _result(app, handed, "done")
    machine = await _machine(app, box_id)
    assert (machine.owner_id, machine.state) == (person.id, "queued")
    assert (await _pool_row(app.factory, box_id)).state == "claimed"
    assert await _reapable(app) == []


async def test_a_bind_failed_before_its_owner_is_reaped_and_the_person_starts_afresh(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    person, box_id, handed = await _claimed_bind(app)
    await _result(app, handed, "failed", "bind_machine_mismatch")
    row = await _pool_row(app.factory, box_id)
    assert (row.state, row.retire_reason) == ("retiring", "failed_before_owner")
    assert await _reapable(app) == [box_id]
    machine = await _machine(app, box_id)
    assert (machine.state, machine.error_code) == ("deleted", BIND_FAILED)
    assert not await _to_remove(app, box_id)
    # The next click: a new machine, never the failed one brought back.
    again = (await _ensure(app, person)).json()["machine_id"]
    assert again != box_id


async def _removed_through_the_normal_path(app, machine_id: str) -> None:
    """The box is tracked until it's gone: listed to the box scaler as wanted
    deleted, and named for removal once the scaler reports it at 0."""
    listed = {m["machine_id"]: m for m in await list_machines(app.client)}
    assert listed[machine_id]["desired_state"] == "deleted"
    assert not await _to_remove(app, machine_id)
    machine = await _machine(app, machine_id)
    await observe(app.client, machine_id, state="stopped", revision=machine.revision)
    assert (await _machine(app, machine_id)).state == "deleted"
    assert await _to_remove(app, machine_id)


async def test_a_bind_failed_after_its_owner_leaves_no_box_untracked(
    provisioner_app,  # noqa: F811
) -> None:
    """From `owner_writing` the box is the person's: never reaped, and not
    simply forgotten either. Its machine goes down the normal removal path,
    and the person's next click, once it's gone, gets a new machine."""
    app = provisioner_app
    person, box_id, handed = await _claimed_bind(app)
    await _owner_writing(app, handed)
    await _result(app, handed, "failed", "bind_closed")
    assert (await _pool_row(app.factory, box_id)).state == "claimed"
    assert await _reapable(app) == []
    await _removed_through_the_normal_path(app, box_id)
    assert (await _ensure(app, person)).json()["machine_id"] != box_id


async def test_a_bind_not_done_in_30_seconds_fails_and_a_late_one_is_refused(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _person_, box_id, handed = await _claimed_bind(app)
    async with app.factory() as session:
        assert await expire_binds(session, datetime.now(UTC)) == 0  # not yet
        assert (
            await expire_binds(session, datetime.now(UTC) + timedelta(seconds=31)) == 1
        )
        await session.commit()
    assert await _reapable(app) == [box_id]
    # Too late to write the owner, or to report it done.
    with pytest.raises(ProvisionRefused) as refused:
        await _owner_writing(app, handed)
    assert refused.value.status == 409
    with pytest.raises(ProvisionRefused) as late:
        await _result(app, handed, "done")
    assert late.value.status == 409
    assert (await _machine(app, box_id)).state == "deleted"


async def test_a_bind_timed_out_after_its_owner_is_never_reaped(
    provisioner_app,  # noqa: F811
) -> None:
    """The owner was written before the 30 seconds ran out: whatever comes
    after, the box is the person's. A late `done` changes nothing."""
    app = provisioner_app
    _person_, box_id, handed = await _claimed_bind(app)
    await _owner_writing(app, handed)
    async with app.factory() as session:
        await expire_binds(session, datetime.now(UTC) + timedelta(seconds=31))
        await session.commit()
    assert await _reapable(app) == []
    with pytest.raises(ProvisionRefused):
        await _result(app, handed, "done")
    assert await _reapable(app) == []
    async with app.factory() as session:
        with pytest.raises(ProvisionRefused):
            await record_pool_box_gone(session, box_id, datetime.now(UTC))
        await session.rollback()
    await _removed_through_the_normal_path(app, box_id)


async def test_the_sweep_fails_a_bind_past_its_30_seconds(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _person_, box_id, _handed = await _claimed_bind(app)
    async with app.factory() as session:
        await sweep_hosted_machines(
            session,
            app.factory,
            app.config,
            app.settings,
            datetime.now(UTC) + timedelta(seconds=31),
        )
        await session.commit()
    assert await _reapable(app) == [box_id]


# ── the sweep: retire, then refill ──


async def _states(app) -> dict[str, tuple[str, str | None]]:
    async with app.factory() as session:
        rows = await session.scalars(select(HostedPoolBox))
        return {row.id: (row.state, row.retire_reason) for row in rows}


@pytest.mark.parametrize("stale", ["image", "age"])
async def test_the_sweep_retires_a_stale_box_and_asks_for_a_fresh_one(
    provisioner_app,  # noqa: F811
    stale: str,
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(
        app.factory,
        revision="r6" if stale == "image" else REVISION,
        ready_at=(datetime.now(UTC) - timedelta(hours=25) if stale == "age" else None),
    )
    made = await sweep_pool(app.factory, app.config, datetime.now(UTC))
    states = await _states(app)
    assert states[box_id] == ("retiring", stale)
    assert [states[new] for new in made] == [("requested", None)]
    assert await _reapable(app) == [box_id]


async def test_a_smaller_pool_retires_the_newest_and_zero_retires_them_all(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    older = await _waiting_box(
        app.factory, ready_at=datetime.now(UTC) - timedelta(minutes=5)
    )
    newer = await _waiting_box(app.factory)
    assert await sweep_pool(app.factory, app.config, datetime.now(UTC)) == []
    states = await _states(app)
    assert states[older] == ("waiting", None)
    assert states[newer] == ("retiring", "size")

    _pooled(app, 0)
    async with app.factory() as session:
        (requested,) = await hosted_pool_store.request_boxes(
            session, 1, datetime.now(UTC)
        )
        await session.commit()
    assert await sweep_pool(app.factory, app.config, datetime.now(UTC)) == []
    states = await _states(app)
    assert states[older] == ("retiring", "size")
    assert states[requested] == ("retiring", "size")


async def test_the_full_sweep_runs_the_pool_pass(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    async with app.factory() as session:
        await sweep_hosted_machines(
            session, app.factory, app.config, app.settings, datetime.now(UTC)
        )
        await session.commit()
    async with app.factory() as session:
        assert (await hosted_pool_store.counts(session))["requested"] == 1


# ── the pool counts towards both ceilings ──


async def _claim_new(
    app, person: User, capacity: int, *, revoke=None, per_workspace: int = 0
):
    async with app.factory() as session:
        await lock_claims(session)
        claimed = await CloudMachineStore().claim(
            session,
            app.factory,
            owner_id=person.id,
            capacity=capacity,
            now=datetime.now(UTC),
            backend="box",
            revoke=revoke,
            per_workspace=per_workspace,
            pool_pick=pool_pick_for(app.config, app.settings),  # type: ignore[arg-type]
        )
        await session.commit()
        return claimed


async def test_pool_boxes_count_towards_the_capacity_but_a_full_server_still_hands_one_out(
    provisioner_app,  # noqa: F811
) -> None:
    """With one machine (the fixture's) and one waiting pool box, a capacity
    of 2 is full: a new person still takes the pool box (counted already), but
    once none waits, nobody gets a new one."""
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    first = await _person(app.factory, "first@example.com")
    claimed = await _claim_new(app, first, capacity=2)
    assert claimed.from_pool and claimed.machine.id == box_id

    async with app.factory() as session:
        await hosted_pool_store.request_boxes(session, 1, datetime.now(UTC))
        await session.commit()
    second = await _person(app.factory, "second@example.com")
    with pytest.raises(CloudMachineConflict, match="in use"):
        await _claim_new(app, second, capacity=3)  # 2 machines + 1 requested


async def test_pool_boxes_count_towards_the_box_ceiling(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    async with app.factory() as session:
        before = await boxes_made(session)
    await _waiting_box(app.factory)
    async with app.factory() as session:
        await hosted_pool_store.request_boxes(session, 1, datetime.now(UTC))
        await session.commit()
        assert await boxes_made(session) == before + 2


@pytest.mark.parametrize(
    ("size", "capacity", "ceiling", "refused"),
    [
        (1, 3, 50, False),
        (2, 3, 50, True),
        (2, 10, 3, True),
        (0, 0, 1, False),
        # The chart's default pool of 10 needs 12 of each.
        (10, 12, 12, False),
        (10, 11, 50, True),
        (10, 12, 11, True),
        # The most a pool may be.
        (50, 52, 52, False),
        (50, 51, 52, True),
    ],
)
def test_core_refuses_a_pool_that_leaves_fewer_than_two_for_people(
    size: int, capacity: int, ceiling: int, refused: bool
) -> None:
    overrides = {
        "hosted_pool_size": size,
        "hosted_launch_capacity": capacity,
        "hosted_box_ceiling": ceiling,
    }
    if refused:
        with pytest.raises(ValueError, match="HOSTED_POOL_SIZE"):
            _config(**overrides)
    else:
        assert _config(**overrides).hosted_pool_size == size


def test_core_refuses_a_pool_above_50() -> None:
    with pytest.raises(ValueError, match="less than or equal to 50"):
        _config(hosted_pool_size=51, hosted_launch_capacity=100, hosted_box_ceiling=100)


async def test_waiting_and_retired_spares_count_against_no_workspace(
    provisioner_app,  # noqa: F811
) -> None:
    """Spares belong to no workspace: with the fixture's machine the only one
    serving this workspace, a per-workspace limit of 2 still lets a new person
    take a waiting spare, however many wait or have retired."""
    app = provisioner_app
    _pooled(app, 3)
    await _operator(app.factory)
    waiting = {await _waiting_box(app.factory), await _waiting_box(app.factory)}
    retired = await _waiting_box(app.factory)
    await _retire_waiting(app, retired)
    person = await _person(app.factory, "spare@example.com")
    claimed = await _claim_new(app, person, capacity=10, per_workspace=2)
    assert claimed.from_pool
    assert claimed.machine.id in waiting
    assert set(await _waiting_ids(app)) == waiting - {claimed.machine.id}


@pytest.mark.parametrize("capacity", [10, 2])
async def test_a_bind_is_refused_when_the_workspace_is_at_its_limit(
    provisioner_app,  # noqa: F811
    capacity: int,
) -> None:
    """The workspace already has its one machine (the fixture's), so a new
    person there is refused before any spare is bound to them, whether the
    server has room (capacity 10) or is full and would hand out a waiting
    spare (capacity 2): the spare stays waiting and nothing is claimed."""
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    box_id = await _waiting_box(app.factory)
    person = await _person(app.factory, "capped@example.com")

    with pytest.raises(CloudMachineConflict, match="this workspace may have"):
        await _claim_new(app, person, capacity=capacity, per_workspace=1)

    assert (await _pool_row(app.factory, box_id)).state == "waiting"
    assert await _claimed_entries(app.factory) == []
    async with app.factory() as session:
        assert await session.get(CloudMachine, box_id) is None


async def test_a_retired_spare_stops_counting_towards_both_ceilings(
    provisioner_app,  # noqa: F811
) -> None:
    """A spare counts towards the capacity and the box ceiling while it's
    requested or waiting, and not once it's retired."""
    app = provisioner_app
    async with app.factory() as session:
        before = await boxes_made(session)
    box_id = await _waiting_box(app.factory)
    async with app.factory() as session:
        assert await boxes_made(session) == before + 1
    await _retire_waiting(app, box_id)
    async with app.factory() as session:
        assert await boxes_made(session) == before
    # The fixture's machine alone, at a capacity of 2: one is free again.
    person = await _person(app.factory, "after-retire@example.com")
    claimed = await _claim_new(app, person, capacity=2)
    assert not claimed.from_pool


async def _retire_waiting(app, box_id: str) -> None:
    async with app.factory() as session:
        await session.execute(
            update(HostedPoolBox)
            .where(HostedPoolBox.id == box_id)
            .values(
                state="retiring", retire_reason="size", retired_at=datetime.now(UTC)
            )
        )
        await session.commit()


async def _waiting_ids(app) -> list[str]:
    async with app.factory() as session:
        rows = await session.scalars(
            select(HostedPoolBox.id).where(HostedPoolBox.state == "waiting")
        )
        return list(rows)


# ── metrics ──


def _points(registry: MetricsRegistry, name: str, key: str) -> dict[str, float]:
    found: dict[str, float] = {}
    for attributes, value in _metric_points(registry, name):
        found[attributes[key]] = found.get(attributes[key], 0) + value
    return found


async def test_new_boxes_are_counted_by_path_and_retired_ones_by_reason(
    provisioner_app,  # noqa: F811
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    app = provisioner_app
    _pooled(app)
    await _operator(app.factory)
    await _waiting_box(app.factory)
    await _ensure(app, await _person(app.factory, "first@example.com"))
    await _ensure(app, await _person(app.factory, "second@example.com"))
    assert _points(hosted_metrics, HOSTED_POOL_CLAIMS.name, "path") == {
        "pool": 1,
        "fallback": 1,
    }
    _pooled(app, 0)
    await sweep_pool(app.factory, app.config, datetime.now(UTC))  # the refill
    assert _points(hosted_metrics, HOSTED_POOL_RETIRED.name, "reason") == {"size": 1}


async def test_no_code_is_given_to_a_box_until_its_owner_is_written(
    provisioner_app,  # noqa: F811
) -> None:
    """Before `owner_writing` the box could still go to the reaper, so
    `prepare` gives it no enrolment code and nothing can enrol on it. From
    `owner_writing` on it's the person's: the code is there, without waiting
    for `done` (the box scaler asks once the box map entry, the bind's last
    step, is written, and backs off for minutes on a refusal)."""
    app = provisioner_app
    _person_, box_id, handed = await _claimed_bind(app)
    early = await prepare(app.client, box_id)
    assert early.status_code == 409, early.text
    await _owner_writing(app, handed)
    owned = await prepare(app.client, box_id)
    assert owned.status_code == 200, owned.text
    [entry] = owned.json()["controllers"]
    assert entry["enrollment_code"]


async def test_a_box_whose_bind_failed_before_its_owner_gets_no_code(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _person_, box_id, handed = await _claimed_bind(app)
    await _result(app, handed, "failed", "bind_machine_mismatch")
    refused = await prepare(app.client, box_id)
    assert refused.status_code == 409, refused.text


async def test_a_box_made_from_scratch_is_prepared_as_before(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    answer = await prepare(app.client, app.machine_id)  # no bind: never pooled
    assert answer.status_code == 200, answer.text
