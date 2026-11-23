"""A message an agent posts is a `security.agent.message_sent` line, so one
agent's send rate can be alerted on; a person's message is not one."""

from __future__ import annotations

import logging

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.logging_context import structured_fields
from switch_core.security_events import LOGGER_NAME
from tests.routing import add_member, make_agent, make_person, make_room, process_on

SessionFactory = async_sessionmaker[AsyncSession]


def _sent(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == LOGGER_NAME
        and structured_fields(record)["switch"]["event"]
        == "security.agent.message_sent"
    ]


async def test_an_agents_message_is_logged_with_its_ids_and_never_its_text(
    session_factory: SessionFactory, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    process = process_on(session_factory)
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "bot")
    await add_member(session_factory, room, client, agent=agent)

    event_id = await process.say(room, "the secret plan", sender=client)
    await process.idle()

    [record] = _sent(caplog)
    fields = structured_fields(record)
    assert fields["switch"]["scope"] == "log"
    assert fields["switch"]["agent_id"] == agent.id
    assert fields["switch"]["room_id"] == room.id
    assert fields["switch"]["tenant_id"] == room.tenant_id
    assert fields["switch"]["actor_user_id"] is None
    assert fields["security_details"] == {"message_id": event_id, "kind": "text"}
    assert "the secret plan" not in str(fields)
    assert "the secret plan" not in record.getMessage()


async def test_a_persons_message_is_not_logged_as_an_agent_send(
    session_factory: SessionFactory, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    process = process_on(session_factory)
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "bot")
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, client, agent=agent)
    await add_member(session_factory, room, alice)

    await process.say(room, "hello", sender=alice)
    await process.idle()

    assert _sent(caplog) == []


async def test_a_file_an_agent_posts_is_logged_as_a_file(
    session_factory: SessionFactory, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    process = process_on(session_factory)
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "bot")
    await add_member(session_factory, room, client, agent=agent)

    await process.send_file(room, "report.png", sender=client)
    await process.idle()

    [record] = _sent(caplog)
    assert structured_fields(record)["security_details"]["kind"] == "file"
    assert "report.png" not in str(structured_fields(record))
