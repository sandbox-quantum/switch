from sqlalchemy import select

from switch_core.db.models import (
    Agent,
    MediaBlob,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
)
from switch_core.db.stores.agent_store import AgentStore
from tests.switch_core.sessions.test_authority import command, setup


async def test_delete_agent_removes_sdk_history_and_session_attachments(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await service.submit(
        command(epoch, "message-demo", {"type": "session.stop"}),
        user_id="owner",
        bridge_id=None,
    )
    await service.upload_attachment(
        "session-demo",
        "owner",
        "12345678-1234-1234-1234-123456789abc",
        "example.txt",
        "text/plain",
        b"session bytes",
    )
    async with session_factory() as db, db.begin():
        db.add(MediaBlob(uri="switch-media://room-file", size=10, data=b"room bytes"))
        for model in (SdkSession, SdkSessionCommand, SdkSessionEvent):
            assert (await db.scalars(select(model))).all()
        assert len((await db.scalars(select(MediaBlob))).all()) == 2
        await AgentStore().delete(db, "agent-demo")
    async with session_factory() as db:
        assert await db.get(Agent, "agent-demo") is None
        for model in (SdkSession, SdkSessionCommand, SdkSessionEvent):
            assert (await db.scalars(select(model))).all() == []
        remaining = (await db.scalars(select(MediaBlob))).all()
        assert [(blob.uri, blob.data) for blob in remaining] == [
            ("switch-media://room-file", b"room bytes")
        ]
