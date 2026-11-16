"""Core's own run of the hosted sweep (`hosted_sweep`), and a box request
that runs out.

With hosted agents v2 on and nothing polling `GET /hosted-controller/machines`
(no box provisioner or controller service deployed), a claimed box used to wait
for its box for ever. Core now runs the sweep itself as owned work, and an
expired request marks its machine as not made: `error`, `box_not_made`, one
`failed/launch_refused`. With v2 off nothing of it runs."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import CloudMachine, ServerAuditEvent
from switch_core.db.stores.hosted_machine_store import CloudMachineStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.gateway import hosted_sweep
from switch_core.ownership import Ownership
from switch_core.signals import SignalBus
from switch_core.visibility.box_provision import (
    TTL,
    ProvisionRefused,
    ask_for_box,
    claim_provision,
    namespace_for,
    record_provision_result,
)
from switch_core.visibility.dependencies import set_process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKind
from tests.ownership import process_lease_on
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    TOKEN,
    machine_metrics,
)
from tests.switch_core.gateway.test_hosted_provisioner import (  # noqa: F401
    KEY,
    _ask,
    _bearer,
    _claim_now,
    _entries,
    _owner_and_machine,
    provisioner_app,
)

# ── Without a database: registration and the loop ──────────────────────────


class _Kind:
    def __init__(self) -> None:
        self.wanted: list[str] = []

    def want(self, key: str) -> None:
        self.wanted.append(key)


class _Ownership:
    def __init__(self) -> None:
        self.kinds: dict[str, tuple[Any, Any, _Kind]] = {}

    def kind(self, name: str, *, start: Any, stop: Any) -> _Kind:
        kind = _Kind()
        self.kinds[name] = (start, stop, kind)
        return kind


def _no_settings() -> None:
    return None


def test_with_v2_off_boot_registers_nothing() -> None:
    """No loop, no kind and so no lease: a v1 server is as before."""
    ownership = _Ownership()
    started = hosted_sweep.start_hosted_sweep(
        False,
        ownership,  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        _no_settings,
    )
    assert started is None
    assert ownership.kinds == {}


async def test_with_v2_on_it_runs_only_once_its_process_owns_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    running = asyncio.Event()
    stopped = asyncio.Event()

    async def loop(*_a: Any, **_k: Any) -> None:
        running.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(hosted_sweep, "hosted_sweep_loop", loop)
    ownership = _Ownership()
    hosted_sweep.start_hosted_sweep(
        True,
        ownership,  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        _no_settings,
    )
    start, stop, kind = ownership.kinds[hosted_sweep.HOSTED_SWEEP_KIND]
    assert kind.wanted == [hosted_sweep.HOSTED_SWEEP_KEY]
    await asyncio.sleep(0)
    assert not running.is_set()  # not owned yet
    await start(hosted_sweep.HOSTED_SWEEP_KEY, None)
    await asyncio.wait_for(running.wait(), timeout=1)
    await stop(hosted_sweep.HOSTED_SWEEP_KEY)
    assert stopped.is_set()


async def test_a_failed_pass_logs_a_fixed_line_and_the_loop_goes_on(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    passes: list[int] = []
    second = asyncio.Event()

    async def sweep_once(*_a: Any, **_k: Any) -> bool:
        passes.append(len(passes))
        if len(passes) == 1:
            raise RuntimeError("machine m-secret request r-secret broke")
        second.set()
        return True

    monkeypatch.setattr(hosted_sweep, "sweep_once", sweep_once)
    caplog.set_level(logging.ERROR, logger="switch_core.gateway.hosted_sweep")
    task = asyncio.create_task(
        hosted_sweep.hosted_sweep_loop(
            object(),  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            _no_settings,
            every_seconds=0,
        )
    )
    await asyncio.wait_for(second.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    (line,) = [r for r in caplog.records if r.name.endswith("hosted_sweep")]
    assert line.getMessage() == "Hosted sweep pass failed (RuntimeError)"
    assert "secret" not in line.getMessage()
    assert line.exc_info is None


async def test_a_pass_does_nothing_with_v2_off_or_no_hosted_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core import hosted_v2

    def never(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("no session with v2 off or no hosted config")

    monkeypatch.setattr(hosted_v2, "_process_on", False)
    assert not await hosted_sweep.sweep_once(never, object(), lambda: object())  # type: ignore[arg-type, return-value]
    monkeypatch.setattr(hosted_v2, "_process_on", True)
    assert not await hosted_sweep.sweep_once(never, object(), _no_settings)  # type: ignore[arg-type]


# ── Against Postgres: a request that runs out ──────────────────────────────


async def _expired_request(app, *, claimed: bool = False) -> tuple[str, str | None]:
    """A request for the fixture's machine, written past its 15 minutes."""
    then = datetime.now(UTC) - TTL - timedelta(minutes=1)
    action = await _ask(app.factory, app.machine_id, now=then)
    assert isinstance(action, str)
    token = await _claim_now(app.factory, then) if claimed else None
    async with app.factory() as session:
        row = await session.get(ServerAuditEvent, action)
        assert row is not None
        row.occurred_at = then
        await session.commit()
    return action, token


def _total(registry, seen: dict[str, float]) -> dict[str, float]:
    """The `failed` machine events counted so far in the test, by reason.
    A counter hands each increment over once per collection, and two
    increments with the same attributes arrive as one point carrying their
    sum, so each call adds what's new to `seen` and returns the running total."""
    for payload in registry.collect():
        if payload.name != "switch.hosted.machine_events":
            continue
        for point in payload.numbers:
            attributes = dict(point.attributes)
            if attributes["event"] == "failed":
                reason = attributes["reason"]
                seen[reason] = seen.get(reason, 0.0) + point.value
    return dict(seen)


async def _pass(app) -> bool:
    return await hosted_sweep.sweep_once(app.factory, app.config, lambda: app.settings)


async def _machine(app) -> CloudMachine:
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert isinstance(machine, CloudMachine)
        return machine


async def _requests(app) -> list[ServerAuditEvent]:
    return [
        e
        for e in await _entries(app.factory)
        if (e.details or {}).get("phase") == "requested"
    ]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_with_nothing_polling_core_marks_the_box_not_made(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
) -> None:
    """Case 1: no poll at all. Core's own pass expires the request and the
    machine goes to error, counted once, and isn't asked for again."""
    app = provisioner_app
    seen: dict[str, float] = {}
    await _expired_request(app)
    asked = len(await _requests(app))

    assert await _pass(app)
    machine = await _machine(app)
    assert (machine.state, machine.error_code) == ("error", "box_not_made")
    # No longer wanted running, so the box scaler never starts it.
    assert machine.desired_state == "stopped"
    listed = await app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN))
    [item] = [m for m in listed.json()["machines"] if m["id"] == app.machine_id]
    assert (item["state"], item["desired_state"]) == ("error", "stopped")
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}
    results = [
        (e.details or {}).get("result")
        for e in await _entries(app.factory)
        if (e.details or {}).get("phase") == "result"
    ]
    assert results == ["expired"]

    # Later passes: nothing more counted, and no new request written.
    assert await _pass(app)
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}
    assert len(await _requests(app)) == asked


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_controller_poll_gives_the_same_outcome_once(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
) -> None:
    """Case 2: the poll gets there first. Same mark, not `not_scheduled`, and
    Core's pass after it counts nothing more."""
    app = provisioner_app
    seen: dict[str, float] = {}
    await _expired_request(app)
    polled = await app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN))
    assert polled.status_code == 200, polled.text
    assert await _pass(app)
    machine = await _machine(app)
    assert (machine.state, machine.error_code) == ("error", "box_not_made")
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_loop_and_the_poll_at_once_mark_each_box_once(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
) -> None:
    """Both run together over the same expired requests, in different
    sessions, as two processes would: neither fails (no deadlock) and each
    machine is marked once."""
    app = provisioner_app
    seen: dict[str, float] = {}
    _, second = await _owner_and_machine(app.factory, email="q@example.com")
    then = datetime.now(UTC) - TTL - timedelta(minutes=1)
    for machine_id in (app.machine_id, second):
        action = await _ask(app.factory, machine_id, now=then)
        assert isinstance(action, str)
        async with app.factory() as session:
            row = await session.get(ServerAuditEvent, action)
            assert row is not None
            row.occurred_at = then
            await session.commit()

    passed, polled = await asyncio.gather(
        _pass(app),
        app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN)),
    )
    assert passed
    assert polled.status_code == 200, polled.text
    async with app.factory() as session:
        for machine_id in (app.machine_id, second):
            machine = await session.get(CloudMachine, machine_id)
            assert machine is not None
            assert (machine.state, machine.error_code) == ("error", "box_not_made")
    assert _total(machine_metrics, seen) == {"launch_refused": 2.0}


@pytest.mark.usefixtures("hosted_v2_on")
async def test_core_s_own_pass_doesn_t_count_as_hearing_the_controller(
    provisioner_app,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ "Controller service silent" stays true to the controller: only its
    poll counts as hearing from it, never Core's own pass."""
    from switch_core.gateway import hosted_controller

    heard: list[int] = []
    monkeypatch.setattr(hosted_controller, "reconciler_heard", lambda: heard.append(1))
    app = provisioner_app
    assert await _pass(app)
    assert heard == []
    polled = await app.client.get("/hosted-controller/machines", headers=_bearer(TOKEN))
    assert polled.status_code == 200, polled.text
    assert heard == [1]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize("observed", ["running", "provisioning", "error"])
async def test_a_late_report_doesn_t_bring_back_a_box_not_made(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
    observed: str,
) -> None:
    """A box that came up, or failed, after Core gave up on it, reporting at
    the current or the previous revision, changes nothing: the machine stays
    in error, not wanted running, until its owner's Retry, and no second
    failure is counted, as `launch_refused` or `stop_failed`."""
    app = provisioner_app
    seen: dict[str, float] = {}
    await _expired_request(app)
    assert await _pass(app)
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}
    before = await _machine(app)
    for revision in {before.revision - 1, before.revision} - {0}:
        body: dict[str, Any] = {"state": observed, "revision": revision}
        if observed == "error":
            body["error"] = "The instance failed its status checks."
            body["error_code"] = "machine_needs_attention"
        reported = await app.client.post(
            f"/hosted-controller/machines/{app.machine_id}/observation",
            headers=_bearer(TOKEN),
            json=body,
        )
        assert reported.status_code == 200, reported.text
    after = await _machine(app)
    assert (after.state, after.error_code, after.desired_state) == (
        "error",
        "box_not_made",
        "stopped",
    )
    assert after.revision == before.revision
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_owner_sees_the_not_made_error_and_can_retry(
    provisioner_app,  # noqa: F811
) -> None:
    """To its owner it's an error with Retry, not a plain stop."""
    app = provisioner_app
    await _expired_request(app)
    assert await _pass(app)
    shown = await app.client.get(f"/hosted-machines/{app.machine_id}")
    assert shown.status_code == 200, shown.text
    summary = shown.json()
    assert summary["state"] == "error"
    assert summary["error_code"] == "box_not_made"
    assert summary["error"]
    assert summary["stop_reason"] is None and summary["sleeping"] is False
    retried = await app.client.post(
        f"/hosted-machines/{app.machine_id}/lifecycle",
        json={"action": "retry", "revision": summary["revision"]},
    )
    assert retried.status_code == 200, retried.text
    machine = await _machine(app)
    assert (machine.state, machine.desired_state) == ("queued", "running")


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_request_still_in_its_15_minutes_is_left_alone(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
) -> None:
    app = provisioner_app
    seen: dict[str, float] = {}
    assert isinstance(await _ask(app.factory, app.machine_id), str)
    assert await _pass(app)
    machine = await _machine(app)
    assert machine.state == "provisioning"
    assert _total(machine_metrics, seen) == {}
    assert all(
        (e.details or {}).get("phase") != "result" for e in await _entries(app.factory)
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_result_after_expiry_is_refused_and_changes_nothing(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
) -> None:
    """A provisioner that finishes late: its result is refused, the machine
    stays as marked (no second count), and the expired item can't be claimed
    again, so nothing builds a box for a machine already in error. Its Retry
    asks again."""
    app = provisioner_app
    seen: dict[str, float] = {}
    action, token = await _expired_request(app, claimed=True)
    assert token is not None
    assert await _pass(app)

    namespace = namespace_for(KEY.keyed_id(KeyedIdKind.USER, app.owner.id))
    for result, failed_at in (("done", None), ("failed", "ceiling_reached")):
        async with app.factory() as session:
            with pytest.raises(ProvisionRefused) as refused:
                await record_provision_result(
                    session,
                    action_id=action,
                    result=result,
                    namespace=namespace,
                    failed_at=failed_at,
                    claim_token=token,
                    now=datetime.now(UTC),
                )
            assert refused.value.status == 409
            await session.rollback()
    machine = await _machine(app)
    assert (machine.state, machine.error_code) == ("error", "box_not_made")
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}

    async with app.factory() as session:
        assert await claim_provision(session, datetime.now(UTC)) is None
        await session.rollback()

    # The owner's Retry wants it running again, and Core's next pass asks
    # for its box.
    asked = len(await _requests(app))
    async with app.factory() as session:
        store = CloudMachineStore()
        locked = await store.locked(session, app.machine_id)
        assert locked is not None
        store.retry(locked, datetime.now(UTC))
        await session.commit()
    machine = await _machine(app)
    assert (machine.state, machine.desired_state) == ("queued", "running")
    assert await _pass(app)
    assert len(await _requests(app)) == asked + 1


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_box_not_made_is_released_then_deleted_if_nobody_retries(
    provisioner_app,  # noqa: F811
) -> None:
    """Core's half of cleaning up a box the provisioner may have built late:
    with no Retry, the machine is retained once the idle window passes, then
    marked deleted, which is what tells the box operator to remove the box."""
    app = provisioner_app
    await _expired_request(app)
    assert await _pass(app)
    assert (await _machine(app)).error_code == "box_not_made"

    app.config.hosted_idle_stop_minutes = 1
    async with app.factory() as session:
        machine = await session.get(CloudMachine, app.machine_id)
        assert machine is not None
        machine.updated_at = datetime.now(UTC) - timedelta(minutes=2)
        await session.commit()
    assert await _pass(app)
    assert (await _machine(app)).desired_state == "retained"
    assert await _pass(app)
    assert (await _machine(app)).desired_state == "deleted"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_with_no_keyed_id_key_a_waiting_box_is_marked_not_made_once(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
) -> None:
    """No key, no box can be named: none is asked for, and the box doesn't
    wait for ever. Asking again changes nothing more."""
    app = provisioner_app
    seen: dict[str, float] = {}
    set_process_keyed_id_key(None)  # the fixture puts it back afterwards
    for _ in range(2):
        asked = await ask_for_box(
            app.factory,
            machine_id=app.machine_id,
            config=app.config,
            settings=app.settings,
            now=datetime.now(UTC),
        )
        assert asked is None
    machine = await _machine(app)
    assert (machine.state, machine.error_code) == ("error", "box_not_made")
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}
    assert await _requests(app) == []


async def test_with_v2_turned_off_a_pass_marks_nothing_and_on_again_it_does(
    provisioner_app,  # noqa: F811
    machine_metrics,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from switch_core import hosted_v2

    app = provisioner_app
    seen: dict[str, float] = {}
    await _expired_request(app)
    monkeypatch.setattr(hosted_v2, "_process_on", False)
    assert not await _pass(app)
    assert (await _machine(app)).state == "provisioning"
    assert _total(machine_metrics, seen) == {}

    monkeypatch.setattr(hosted_v2, "_process_on", True)
    assert await _pass(app)
    assert (await _machine(app)).error_code == "box_not_made"
    assert _total(machine_metrics, seen) == {"launch_refused": 1.0}


def _never_listening() -> Any:
    raise AssertionError("these processes' signal buses are never started")


async def test_of_two_processes_only_one_runs_the_sweep(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sweeping: list[str] = []

    async def loop(*_a: Any, **_k: Any) -> None:
        process = asyncio.current_task().get_name()  # type: ignore[union-attr]
        sweeping.append(process)
        try:
            await asyncio.Event().wait()
        finally:
            sweeping.remove(process)

    monkeypatch.setattr(hosted_sweep, "hosted_sweep_loop", loop)
    processes = []
    for _ in range(2):
        lease = process_lease_on(session_factory)
        await lease.renew()
        ownership = Ownership(
            lease=lease,
            session_factory=session_factory,
            bus=SignalBus(
                session_factory, _never_listening, process_id=lease.process_id
            ),
            store=OwnershipLeaseStore(),
            processes=SwitchCoreProcessStore(),
        )
        kind = hosted_sweep.start_hosted_sweep(
            True,
            ownership,
            session_factory,
            object(),  # type: ignore[arg-type]
            _no_settings,
        )
        assert kind is not None
        processes.append((ownership, kind))
    for ownership, _ in processes:
        await ownership.balance()
    await asyncio.sleep(0)
    assert len([kind for _, kind in processes if kind.held()]) == 1
    assert len(sweeping) == 1
    for ownership, _ in processes:
        await ownership.stop()
