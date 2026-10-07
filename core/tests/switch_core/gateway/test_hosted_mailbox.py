"""Room notices the wake mailbox owes when a row could not be delivered."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy import select

from switch_core.bridges.agent.hosted_mailbox import (
    mailbox_upkeep,
    post_mailbox_notices,
)
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import HostedWakeMailbox, require_tenant_id
from switch_core.db.stores.hosted_mailbox_store import HostedMailboxStore
from tests.switch_core.bridges.agent.protocol.registration_harness import make_service

DELETED_AGENT = "00000000-0000-4000-8000-00000000000d"


def _service(session_factory):
    service = make_service(session_factory)
    service.connections = AgentConnectionRegistry()
    service.event_buffer = SimpleNamespace(boot=1)
    service.config.hosted_controller_config_path = "/etc/switch/controller.json"
    service.config.hosted_launch_capacity = 0
    sent: list[str] = []

    async def send_message(*args, **kwargs):
        sent.append(args[2])

    service.send_message = send_message
    return service, sent


async def _row(session_factory, message_id: str, **values) -> None:
    now = datetime.now(UTC)
    async with session_factory() as session:
        fields = {
            "agent_id": DELETED_AGENT,
            "room_id": "room-1",
            "message_id": message_id,
            "event": {},
            "addressed_at": now,
            "updated_at": now,
            "expires_at": now + timedelta(hours=24),
        }
        session.add(HostedWakeMailbox(**(fields | values)))
        await session.commit()


async def _notice_columns(session_factory, message_id: str):
    async with session_factory() as session:
        return (
            await session.execute(
                select(
                    HostedWakeMailbox.state,
                    HostedWakeMailbox.notice_owed,
                    HostedWakeMailbox.notice_dropped,
                ).where(
                    HostedWakeMailbox.tenant_id == require_tenant_id(),
                    HostedWakeMailbox.message_id == message_id,
                )
            )
        ).one()


async def test_a_deleted_agents_notice_is_dropped_not_posted(session_factory, caplog):
    service, sent = _service(session_factory)
    await _row(session_factory, "$m1", state="cancelled", notice_owed="stopped")
    store = HostedMailboxStore()
    async with session_factory() as session:
        notices = await store.owed_notices(session, 10)
    assert len(notices) == 1

    await post_mailbox_notices(service, notices)

    assert sent == []
    assert tuple(await _notice_columns(session_factory, "$m1")) == (
        "cancelled",
        "stopped",
        "agent_deleted",
    )
    async with session_factory() as session:
        assert await store.owed_notices(session, 10) == []
    assert any("was deleted" in record.message for record in caplog.records)


async def test_upkeep_expires_an_undelivered_row_and_settles_its_notice(
    session_factory,
):
    service, sent = _service(session_factory)
    await _row(
        session_factory,
        "$m1",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )

    await mailbox_upkeep(service, datetime.now(UTC))

    assert sent == []
    assert tuple(await _notice_columns(session_factory, "$m1")) == (
        "expired",
        "expired",
        "agent_deleted",
    )
