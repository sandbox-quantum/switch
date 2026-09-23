import asyncio
from uuid import uuid4

import pytest

from switch_core.db.models import HostedLaunch, SdkSession, require_tenant_id
from switch_core.sessions.contract import Session
from switch_core.sessions.service import SessionError
from tests.switch_core.sessions.test_authority import EXAMPLES, setup


async def hosted_setup(factory, limit):
    service, epoch = await setup(factory)
    async with factory() as db, db.begin():
        db.add(
            HostedLaunch(
                id="cloud-launch",
                owner_id="owner",
                name="cloud-agent",
                agent_id="agent-demo",
                spec={"session_limit": limit},
                state="ready",
            )
        )
    return service, epoch


def new_session():
    return Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": str(uuid4()), "host_id": str(uuid4())}
    )


async def test_concurrent_room_or_manual_sessions_cannot_exceed_worker_limit(
    session_factory,
):
    service, _ = await hosted_setup(session_factory, 2)
    results = await asyncio.gather(
        *(service.acquire("agent-demo", new_session()) for _ in range(2)),
        return_exceptions=True,
    )
    assert len([result for result in results if not isinstance(result, Exception)]) == 1
    failures = [result for result in results if isinstance(result, SessionError)]
    assert len(failures) == 1
    assert failures[0].code == "CAPACITY_EXCEEDED"


async def test_stopped_session_cannot_resume_above_worker_limit(session_factory):
    service, epoch = await hosted_setup(session_factory, 1)
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.snapshot = {
            **row.snapshot,
            "session": {**row.snapshot["session"], "status": "stopped"},
        }
    await service.acquire("agent-demo", new_session())
    with pytest.raises(SessionError, match="session limit"):
        await service.recover(
            "agent-demo", "session-demo", "host-demo", epoch, "resume-at-capacity", 0
        )


async def test_worker_stop_denies_new_and_recovered_execution(session_factory):
    service, epoch = await hosted_setup(session_factory, 2)
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    async with session_factory() as db, db.begin():
        launch = await db.get(HostedLaunch, (require_tenant_id(), "cloud-launch"))
        launch.desired_state = "stopped"
    with pytest.raises(SessionError, match="stopped"):
        await service.acquire("agent-demo", new_session())
    with pytest.raises(SessionError, match="stopped"):
        await service.recover(
            "agent-demo", "session-demo", "host-demo", epoch, "stopped-worker-resume", 0
        )
