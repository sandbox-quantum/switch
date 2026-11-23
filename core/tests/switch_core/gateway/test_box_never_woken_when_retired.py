"""S2: a v2 box that is retained, or wanted deleted, is never started again by
a message to one of its agents or by an agent placed on it, whatever stop
reason it was left with. Only its owner's claim or Retry brings it back.
Pins `cloud_controllers.wake_controller_machine` (and the lifted-block path,
`wake_lifted_machine`, which ends in it). Against Postgres, with real agent
management."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.gateway.cloud_controllers import (
    wake_controller_machine,
    wake_lifted_machine,
)
from tests.switch_core.gateway.test_cloud_controller_machines import (
    _claim,
    _enroll,
    _hosted_app,
    _machine,
    _prepare,
    _update,
    reported,  # noqa: F401  (fixture)
)
from tests.switch_core.management.harness import Harness, add_member, build_harness
from tests.telemetry_records import RecordingSink


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    ("state", "desired_state"),
    [("retained", "retained"), ("stopped", "deleted"), ("error", "deleted")],
)
@pytest.mark.parametrize("stop_reason", [None, "idle", "turned_off", "owner"])
async def test_a_retired_box_is_never_woken(
    harness: Harness,
    reported: RecordingSink,  # noqa: F811
    state: str,
    desired_state: str,
    stop_reason: str | None,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    machine = await _claim(harness.session_factory, owner)
    async with _hosted_app(harness.session_factory, owner) as hosted:
        code = (await _prepare(hosted, machine.id))["controllers"][0]["enrollment_code"]
        async with harness.client() as client:
            enrolled = await _enroll(client, code)
    await _update(
        harness.session_factory,
        machine.id,
        backend="box",
        state=state,
        desired_state=desired_state,
        stop_reason=stop_reason,
    )
    before = await _machine(harness.session_factory, machine.id)
    for trigger in ("message", "agent_placed"):
        async with harness.session_factory() as session:
            await wake_controller_machine(
                session,
                enrolled["controller_id"],
                datetime.now(UTC),
                trigger,  # type: ignore[arg-type]
            )
            await session.commit()
    async with harness.session_factory() as session:
        await wake_lifted_machine(session, enrolled["controller_id"], datetime.now(UTC))
        await session.commit()
    after = await _machine(harness.session_factory, machine.id)
    assert (after.state, after.desired_state, after.stop_reason) == (
        state,
        desired_state,
        stop_reason,
    )
    assert after.revision == before.revision
    assert reported.events("cloud_machine_woken") == []
