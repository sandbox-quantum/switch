"""What Switch has to tell an agent rides on the next message it receives,
until the agent reads about it: read once for every agent of the room."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.message_events import message_event
from switch_core.db.stores.template_install_store import TemplateInstallStore
from switch_core.delivery.recipient import AgentRecipient
from switch_core.transport.types import InboundMessage
from tests.switch_core.db.stores.test_template_install_store import _agent, _install

_STORE = TemplateInstallStore()


async def test_notices_are_read_for_the_agents_that_have_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        noticed = await _agent(session, "switch-buddy-max")
        quiet = await _agent(session, "switch-buddy-zoe")
        plain = await _agent(session, "helper")
        install = await _install(session, noticed)
        await _install(session, quiet)
        (resource,) = await _STORE.resources(session, install.id)
        await _STORE.set_notice(session, resource.id, "New revision.")

        assert await _STORE.notices_for_agents(
            session, [noticed.id, quiet.id, plain.id]
        ) == {noticed.id: "New revision."}
        assert await _STORE.notices_for_agents(session, []) == {}


async def test_the_recipient_asks_the_room_s_reads_for_its_own_notice() -> None:
    asked: list[str] = []

    class Reads:
        async def switch_notice(self, _session: object, agent_id: str) -> str:
            asked.append(agent_id)
            return "New revision."

    recipient = SimpleNamespace(agent=SimpleNamespace(id="a-1"), _notices=Reads())

    assert (
        await AgentRecipient._switch_notice(recipient, None)  # type: ignore[arg-type]
        == "New revision."
    )
    assert asked == ["a-1"]


def test_the_notice_rides_on_the_message() -> None:
    event = message_event(
        room_id="room-1",
        bridge_id=None,
        channel_type="direct",
        event=InboundMessage(
            room_id="room-1",
            event_id="$1",
            sender="@max:test",
            timestamp=1,
            body="hi",
            sender_name="max",
        ),
        addressed=True,
        sender_name="max",
        body="hi",
        thread_id=None,
        switch_notice="New revision.",
    )

    assert event.payload.switch_notice == "New revision."  # type: ignore[union-attr]
