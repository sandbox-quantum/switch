"""The debug line for a stored own event costs nothing unless DEBUG is on.

It pretty-prints the whole event, and an argument to `logger.debug` is built
before the level is checked. That ran once per agent per message: on a busy
server, thousands of serialisations a second for a line nobody was logging.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.db.models import Agent, Client, Room
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

_LOGGER = "switch_core.delivery.recipient"


@pytest.fixture
async def scene(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[Process, Room, Client, Agent]:
    """`helper` in a room with someone who addresses it: only an event for
    the agent is stored, so the rest of the room never reaches the line
    under test."""
    process = process_on(session_factory)
    room = await make_room(session_factory)
    someone = await make_person(session_factory, "someone")
    helper, client = await make_agent(session_factory, "helper")
    await add_member(session_factory, room, someone)
    await add_member(session_factory, room, client, agent=helper)
    return process, room, someone, helper


@pytest.fixture
def dumps(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []
    real = AgentEvent.model_dump_json

    def counting(self: AgentEvent, **kwargs: object) -> str:
        calls.append(1)
        return real(self, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(AgentEvent, "model_dump_json", counting)
    return calls


async def test_an_event_is_not_serialised_for_a_debug_line_nobody_logs(
    session_factory: async_sessionmaker[AsyncSession],
    dumps: list[int],
    caplog: pytest.LogCaptureFixture,
    scene: tuple[Process, Room, Client, Agent],
) -> None:
    process, room, someone, helper = scene
    caplog.set_level(logging.INFO, logger=_LOGGER)

    await process.say(room, "@helper hello", sender=someone)

    assert len(await own_events(session_factory, helper.id)) == 1
    assert dumps == []
    assert not [r for r in caplog.records if "Enqueuing event" in r.getMessage()]


async def test_the_debug_line_is_still_logged_when_debug_is_on(
    session_factory: async_sessionmaker[AsyncSession],
    dumps: list[int],
    caplog: pytest.LogCaptureFixture,
    scene: tuple[Process, Room, Client, Agent],
) -> None:
    process, room, someone, helper = scene
    caplog.set_level(logging.DEBUG, logger=_LOGGER)

    await process.say(room, "@helper hello", sender=someone)

    assert len(await own_events(session_factory, helper.id)) == 1
    assert dumps == [1]
    lines = [r for r in caplog.records if "Enqueuing event" in r.getMessage()]
    assert len(lines) == 1
    assert '"body": "@helper hello"' in lines[0].getMessage()


@pytest.mark.parametrize("level", [logging.INFO, logging.DEBUG])
async def test_a_media_event_is_serialised_only_when_debug_is_on(
    session_factory: async_sessionmaker[AsyncSession],
    dumps: list[int],
    caplog: pytest.LogCaptureFixture,
    level: int,
    scene: tuple[Process, Room, Client, Agent],
) -> None:
    process, room, someone, helper = scene
    caplog.set_level(level, logger=_LOGGER)

    await process.send_file(room, "a.png", sender=someone, caption="@helper a file")

    assert len(await own_events(session_factory, helper.id)) == 1
    logged = [r for r in caplog.records if "Enqueuing media event" in r.getMessage()]
    if level == logging.DEBUG:
        assert dumps == [1]
        assert len(logged) == 1
    else:
        assert dumps == []
        assert logged == []
