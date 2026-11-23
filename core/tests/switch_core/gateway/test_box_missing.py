"""`box_missing`: the box scaler finds a made v2 box gone from the cluster.

Core lists `box_expected` only for a box a provision made (a `done` result
since its latest revival, and no `missing` result after it). On a missing
report at the current revision it records a `missing` result, revokes the
box's controllers, and asks for a new box once per revision through every
gate, or puts the machine in error. Against Postgres, with real agent
management."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import hosted_v2
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    AgentController,
    MachineWorkspace,
    ServerAuditEvent,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import CloudMachineStore, bump_revision
from switch_core.gateway.dependencies import get_config
from switch_core.observability.catalogue import HOSTED_MACHINE_EVENTS
from switch_core.observability.metrics import MetricsRegistry
from switch_core.visibility.box_provision import ACTION, BOX_MISSING
from switch_core.visibility.dependencies import set_process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from tests.switch_core.gateway.test_box_ready_both_orders import (
    Box,
    _box,
    _report,
    _running,
    _state,
)
from tests.switch_core.gateway.test_cloud_controller_machines import (
    HEADERS,
    _enroll,
    _hosted_app,
    _metric_points,
    _prepare,
    hosted_metrics,  # noqa: F401  (fixture)
)
from tests.switch_core.management.harness import Harness, add_member, build_harness

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


@pytest.fixture(autouse=True)
def keyed_id_key() -> Iterator[None]:
    set_process_keyed_id_key(KEY)
    yield
    set_process_keyed_id_key(None)


def _app(harness: Harness, owner) -> httpx.AsyncClient:
    """The hosted controller's routes, with box provisioning's caps set."""
    hosted = _hosted_app(harness.session_factory, owner)
    config = hosted._transport.app.dependency_overrides[get_config]()  # type: ignore[attr-defined]
    config.hosted_provisions_per_minute = 10
    config.hosted_box_ceiling = 100
    return hosted


async def _audit(factory, **details) -> ServerAuditEvent:
    async with factory() as session:
        entry = await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=details.pop("target_id"),
            details=details,
        )
        await session.commit()
        return entry


async def _asked(harness: Harness, machine_id: str) -> ServerAuditEvent:
    """A provision request for the machine, as Core writes one."""
    return await _audit(
        harness.session_factory,
        target_id=KEY.keyed_id(KeyedIdKind.BOX, machine_id),
        phase="requested",
        by="core",
        machine_id=machine_id,
        user="u",
        size=None,
    )


async def _made(harness: Harness, machine_id: str) -> None:
    """A provision for the machine, answered `done` by the provisioner."""
    request = await _asked(harness, machine_id)
    await _audit(
        harness.session_factory,
        target_id=request.target_id,
        phase="result",
        result="done",
        linked_to=request.id,
        machine_id=machine_id,
    )


async def _ready_made_box(harness: Harness, owner, hosted, client) -> Box:
    box = await _box(harness, owner, hosted, client)
    await _made(harness, box.machine_id)
    await _report(box, 1)
    await _running(box)
    assert (await _state(harness, box)).state == "ready"
    return box


async def _listed(hosted: httpx.AsyncClient, machine_id: str) -> dict:
    answer = await hosted.get("/hosted-controller/machines", headers=HEADERS)
    assert answer.status_code == 200, answer.text
    (item,) = [m for m in answer.json()["machines"] if m["machine_id"] == machine_id]
    return item


async def _missing(box: Box, revision: int | None = None) -> httpx.Response:
    machine = await _state(box.controller.harness, box)
    return await box.hosted.post(
        f"/hosted-controller/machines/{box.machine_id}/observation",
        headers=HEADERS,
        json={
            "state": "error",
            "error": "This machine's box is missing from the cluster.",
            "error_code": "box_missing",
            "revision": revision if revision is not None else machine.revision,
        },
    )


async def _entries(harness: Harness, machine_id: str, **match: str) -> list[dict]:
    async with harness.session_factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent)
            .where(
                ServerAuditEvent.action == ACTION,
                ServerAuditEvent.details["machine_id"].astext == machine_id,
            )
            .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
        )
        return [
            dict(e.details or {})
            for e in rows
            if all((e.details or {}).get(k) == v for k, v in match.items())
        ]


async def _controller(harness: Harness, box: Box) -> AgentController:
    async with tenant_session(harness.session_factory, require_tenant_id()) as session:
        controller = await session.get(AgentController, box.controller.controller_id)
        assert controller is not None
        return controller


async def _revoke_records(harness: Harness, machine_id: str) -> list[dict]:
    async with harness.session_factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent)
            .where(
                ServerAuditEvent.action
                == ServerAuditAction.HOSTED_BOX_CONTROLLERS_REVOKED,
                ServerAuditEvent.target_id == machine_id,
            )
            .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
        )
        return [dict(e.details or {}) for e in rows]


def _box_missing_events(registry: MetricsRegistry) -> float:
    return sum(
        value
        for attributes, value in _metric_points(registry, HOSTED_MACHINE_EVENTS.name)
        if attributes.get("event") == "failed"
        and attributes.get("reason") == BOX_MISSING
    )


# ── box_expected ──


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_is_expected_only_once_its_provision_is_done(
    harness: Harness,
) -> None:
    """Never while it's being made, so a box with no map entry yet is never
    reported missing: no request, then an open request, then `done`."""
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _box(harness, owner, hosted, client)
        assert (await _listed(hosted, box.machine_id))["box_expected"] is False
        request = await _asked(harness, box.machine_id)
        assert (await _listed(hosted, box.machine_id))["box_expected"] is False
        await _audit(
            harness.session_factory,
            target_id=request.target_id,
            phase="progress",
            step="claimed",
            linked_to=request.id,
        )
        assert (await _listed(hosted, box.machine_id))["box_expected"] is False
        await _audit(
            harness.session_factory,
            target_id=request.target_id,
            phase="result",
            result="done",
            linked_to=request.id,
            machine_id=box.machine_id,
        )
        assert (await _listed(hosted, box.machine_id))["box_expected"] is True


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_failed_provision_and_a_v1_machine_are_never_expected(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _box(harness, owner, hosted, client)
        request = await _asked(harness, box.machine_id)
        await _audit(
            harness.session_factory,
            target_id=request.target_id,
            phase="result",
            result="failed",
            step="box_map_failed",
            linked_to=request.id,
            machine_id=box.machine_id,
        )
        assert (await _listed(hosted, box.machine_id))["box_expected"] is False
    other = await add_member(harness.session_factory, "bea")
    async with _app(harness, other) as hosted, harness.client() as client:
        vm = await _box(harness, other, hosted, client, backend="vm")
        await _made(harness, vm.machine_id)
        # never for a v1 machine, whatever: its entry stays upstream's
        assert "box_expected" not in await _listed(hosted, vm.machine_id)


async def test_with_v2_off_the_listing_and_the_code_are_upstreams(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    monkeypatch.setattr(hosted_v2, "_process_on", True)
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        monkeypatch.setattr(hosted_v2, "_process_on", False)
        assert "box_expected" not in await _listed(hosted, box.machine_id)
        refused = await _missing(box)
        assert refused.status_code == 422
    assert not await _entries(harness, box.machine_id, result="missing")


# ── a missing report ──


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_missing_box_is_asked_for_again_once(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    """A `missing` result at this revision, the old controller revoked, the
    machine waiting for a new box, and a new request written. A repeat of
    the same report (an answer lost on the way back) changes nothing."""
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        revision = (await _state(harness, box)).revision
        answer = await _missing(box)
        assert answer.status_code == 200, answer.text
        assert answer.json()["state"] == "queued"
        machine = await _state(harness, box)
        assert machine.state == "queued" and machine.error_code is None
        assert machine.revision == revision
        assert machine.running_observed_at is None
        # The old box's facts are gone; only the new start's clock is kept.
        assert set(machine.heartbeat or {}) <= {"first_click", "start"}
        assert (machine.heartbeat or {})["start"]["revision"] == machine.revision
        assert (await _listed(hosted, box.machine_id))["box_expected"] is False
        assert (await _controller(harness, box)).revoked_at is not None
        async with tenant_session(
            harness.session_factory, require_tenant_id()
        ) as session:
            row = await session.scalar(
                select(MachineWorkspace).where(
                    MachineWorkspace.machine_id == box.machine_id
                )
            )
            assert row is not None and row.enrollment_code_encrypted is None

        assert await _revoke_records(harness, box.machine_id) == [
            {
                "machine_id": box.machine_id,
                "reason": "box_missing",
                "by": "re_ask",
                "revision": revision,
                "controllers": 1,
            }
        ]
        # The new box can enrol: no live controller, so a fresh code.
        [entry] = (await _prepare(hosted, box.machine_id))["controllers"]
        assert entry["enrollment_code"]

        (missing,) = await _entries(harness, box.machine_id, result="missing")
        assert missing["revision"] == revision and missing["phase"] == "result"
        requests = await _entries(harness, box.machine_id, phase="requested")
        assert len(requests) == 2  # the first box's, and the new one

        again = await _missing(box)
        assert again.status_code == 200, again.text
        assert len(await _entries(harness, box.machine_id, result="missing")) == 1
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 2
        # waiting for its box (the listing's sweep moves it on to provisioning)
        assert (await _state(harness, box)).state in ("queued", "provisioning")
    assert _box_missing_events(hosted_metrics) == 0


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_lost_again_at_the_same_revision_goes_to_error(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    """The one re-ask made a new box, and that one went missing too, at the
    same revision: no second request, an error, counted once."""
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        assert (await _missing(box)).status_code == 200
        await _made(harness, box.machine_id)  # the new box
        # whose controller enrols with the fresh code, so none is revoked now
        [entry] = (await _prepare(hosted, box.machine_id))["controllers"]
        enrolled = await _enroll(client, entry["enrollment_code"])
        assert enrolled["controller_id"] != box.controller.controller_id
        assert (await _listed(hosted, box.machine_id))["box_expected"] is True
        answer = await _missing(box)
        assert answer.status_code == 200, answer.text
        machine = await _state(harness, box)
        assert machine.state == "error" and machine.error_code == BOX_MISSING
        assert machine.error and "missing" in machine.error
        # the first box's request, the re-ask's, and the test's own new box
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 3
        assert len(await _entries(harness, box.machine_id, result="missing")) == 2
        assert (await _missing(box)).status_code == 200  # in error: nothing more
    assert _box_missing_events(hosted_metrics) == 1


@pytest.mark.usefixtures("hosted_v2_on")
async def test_no_re_ask_for_a_box_whose_disk_is_named_for_removal(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        async with harness.session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_TO_REMOVE,
                target_type="box",
                target_id=KEY.keyed_id(KeyedIdKind.BOX, box.machine_id),
                details={"machine_id": box.machine_id},
            )
            await session.commit()
        assert (await _missing(box)).status_code == 200
        machine = await _state(harness, box)
        assert (await _controller(harness, box)).revoked_at is None  # kept
        assert not await _revoke_records(harness, box.machine_id)
    assert machine.state == "error" and machine.error_code == BOX_MISSING
    assert len(await _entries(harness, box.machine_id, phase="requested")) == 1
    assert _box_missing_events(hosted_metrics) == 1


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_cancelled_removal_doesnt_hold_the_re_ask(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        async with harness.session_factory() as session:
            for action in (
                ServerAuditAction.HOSTED_BOX_TO_REMOVE,
                ServerAuditAction.HOSTED_BOX_TO_REMOVE_CANCELLED,
            ):
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=action,
                    target_type="box",
                    target_id=KEY.keyed_id(KeyedIdKind.BOX, box.machine_id),
                    details={"machine_id": box.machine_id},
                )
                await session.commit()
        assert (await _missing(box)).status_code == 200
        # waiting for its box (the listing's sweep moves it on to provisioning)
        assert (await _state(harness, box)).state in ("queued", "provisioning")
    assert len(await _entries(harness, box.machine_id, phase="requested")) == 2


@pytest.mark.usefixtures("hosted_v2_on")
async def test_no_re_ask_for_a_box_whose_controller_was_revoked(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        async with tenant_session(
            harness.session_factory, require_tenant_id()
        ) as session:
            controller = await session.get(
                AgentController, box.controller.controller_id
            )
            assert controller is not None
            controller.revoked_at = datetime.now(UTC)
            await session.commit()
        assert (await _missing(box)).status_code == 200
        machine = await _state(harness, box)
    assert machine.state == "error" and machine.error_code == BOX_MISSING
    assert len(await _entries(harness, box.machine_id, phase="requested")) == 1
    assert _box_missing_events(hosted_metrics) == 1


def _set_users(hosted: httpx.AsyncClient, users: list[str] | None) -> None:
    state = hosted._transport.app.state  # type: ignore[attr-defined]
    state.hosted_controller_settings = state.hosted_controller_settings.model_copy(
        update={"allowed_user_ids": users}
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_no_re_ask_for_an_owner_off_the_lists_and_a_retry_starts_afresh(
    harness: Harness,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    """An owner taken off the user list since gets an error, not a new box,
    and keeps the controller. Back on the list, their Retry revokes it, so
    the new box gets a fresh code, and the box is asked for again."""
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        _set_users(hosted, ["someone-else"])
        assert (await _missing(box)).status_code == 200
        machine = await _state(harness, box)
        assert machine.state == "error" and machine.error_code == BOX_MISSING
        assert (await _controller(harness, box)).revoked_at is None
        assert not await _revoke_records(harness, box.machine_id)
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 1
        assert _box_missing_events(hosted_metrics) == 1

        _set_users(hosted, None)
        retried = await hosted.post(
            f"/hosted-machines/{box.machine_id}/lifecycle",
            json={"action": "retry", "revision": machine.revision},
        )
        assert retried.status_code == 200, retried.text
        assert (await _controller(harness, box)).revoked_at is not None
        [record] = await _revoke_records(harness, box.machine_id)
        assert (record["by"], record["controllers"]) == ("retry", 1)
        [entry] = (await _prepare(hosted, box.machine_id))["controllers"]
        assert entry["enrollment_code"]
        await _listed(hosted, box.machine_id)  # the sweep asks for the box
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 2
        # waiting for its box (the listing's sweep moves it on to provisioning)
        assert (await _state(harness, box)).state in ("queued", "provisioning")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_report_for_a_box_not_yet_made_or_at_an_old_revision_is_ignored(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _box(harness, owner, hosted, client)
        await _asked(harness, box.machine_id)  # being made: not expected
        before = await _state(harness, box)
        assert (await _missing(box)).status_code == 200
        assert (await _state(harness, box)).state == before.state
        assert not await _entries(harness, box.machine_id, result="missing")

        other = await add_member(harness.session_factory, "bea")
    async with _app(harness, other) as hosted, harness.client() as client:
        made = await _ready_made_box(harness, other, hosted, client)
        revision = (await _state(harness, made)).revision
        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, made.machine_id)
            assert machine is not None
            bump_revision(machine, datetime.now(UTC))
            await session.commit()
        stale = await _missing(made, revision=revision)
        assert stale.status_code == 200
        machine = await _state(harness, made)
    assert machine.state != "error" and machine.error_code is None
    assert not await _entries(harness, made.machine_id, result="missing")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_not_wanted_running_is_never_counted_missing(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        async with harness.session_factory() as session:
            machine = await CloudMachineStore().locked(session, box.machine_id)
            assert machine is not None
            machine.desired_state = "stopped"
            bump_revision(machine, datetime.now(UTC))
            await session.commit()
        assert (await _missing(box)).status_code == 200
        machine = await _state(harness, box)
    assert machine.error_code is None
    assert not await _entries(harness, box.machine_id, result="missing")


# ── failures between the steps ──


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_revoke_is_recorded_even_when_it_fails(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The audit entry commits before any revoke: a revoke that then fails
    rolls the observation back, and the record of the attempt stays."""
    from switch_core.gateway import cloud_controllers

    async def broken(*_args, **_kwargs):
        raise RuntimeError("revoke failed")

    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        monkeypatch.setattr(cloud_controllers, "revoke_box_controllers", broken)
        with pytest.raises(RuntimeError, match="revoke failed"):
            await _missing(box)
        machine = await _state(harness, box)
    assert machine.state == "ready"
    assert not await _entries(harness, box.machine_id, result="missing")
    [record] = await _revoke_records(harness, box.machine_id)
    assert record["reason"] == "box_missing"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_crash_after_the_commit_is_re_asked_by_the_sweep(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The process dies after `_box_missing`'s commit, before its own ask:
    the machine waits for its box, and the next listing's sweep asks."""
    from switch_core.gateway import hosted_controller

    real = hosted_controller._ask_again_for_missing_box

    async def crash(*_args, **_kwargs):
        raise RuntimeError("process died")

    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        monkeypatch.setattr(hosted_controller, "_ask_again_for_missing_box", crash)
        with pytest.raises(RuntimeError, match="process died"):
            await _missing(box)
        assert (await _state(harness, box)).state == "queued"
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 1
        monkeypatch.setattr(hosted_controller, "_ask_again_for_missing_box", real)
        await _listed(hosted, box.machine_id)
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 2
        assert (await _state(harness, box)).state in ("queued", "provisioning")
        [entry] = (await _prepare(hosted, box.machine_id))["controllers"]
        assert entry["enrollment_code"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_crash_between_the_revoke_and_the_commit_still_converges(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    hosted_metrics: MetricsRegistry,  # noqa: F811
) -> None:
    """The revokes commit, then the observation's own transaction is lost.
    That fails safe: no `missing` result and no new box, a recorded revoke.
    The scaler's next report (after its restart, say) finds the controller
    revoked, so the machine goes to error, and the owner's Retry asks for a
    new box that can enrol."""
    from switch_core.gateway import hosted_controller

    real = hosted_controller.forget_missing_box

    async def revoke_then_crash(*args, **kwargs):
        await real(*args, **kwargs)
        raise RuntimeError("process died")

    owner = await add_member(harness.session_factory, "ada")
    async with _app(harness, owner) as hosted, harness.client() as client:
        box = await _ready_made_box(harness, owner, hosted, client)
        monkeypatch.setattr(hosted_controller, "forget_missing_box", revoke_then_crash)
        with pytest.raises(RuntimeError, match="process died"):
            await _missing(box)
        monkeypatch.setattr(hosted_controller, "forget_missing_box", real)
        assert (await _controller(harness, box)).revoked_at is not None
        assert len(await _revoke_records(harness, box.machine_id)) == 1
        assert not await _entries(harness, box.machine_id, result="missing")
        assert (await _listed(hosted, box.machine_id))["box_expected"] is True

        assert (await _missing(box)).status_code == 200  # reported again
        machine = await _state(harness, box)
        assert machine.state == "error" and machine.error_code == BOX_MISSING
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 1

        retried = await hosted.post(
            f"/hosted-machines/{box.machine_id}/lifecycle",
            json={"action": "retry", "revision": machine.revision},
        )
        assert retried.status_code == 200, retried.text
        await _listed(hosted, box.machine_id)
        assert len(await _entries(harness, box.machine_id, phase="requested")) == 2
        [entry] = (await _prepare(hosted, box.machine_id))["controllers"]
        assert entry["enrollment_code"]
    assert _box_missing_events(hosted_metrics) == 1
