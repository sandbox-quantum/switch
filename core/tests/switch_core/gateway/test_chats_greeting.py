"""A chat created with a `greeting`: what its one agent says as it joins, in
place of its usual line (switch-buddy's welcome). Stamped on the room, so the
agent finds it when it joins."""

from __future__ import annotations

import httpx

from switch_core.db.models import Agent, Room, User
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _code


async def _create(
    chats: _Harness, user: User, agents: list[Agent], greeting: str
) -> httpx.Response:
    return await chats.client.post(
        "/chats",
        json={
            "agentIds": [agent.id for agent in agents],
            "requestId": "c1",
            "greeting": greeting,
        },
        headers=chats.as_user(user),
    )


async def test_the_greeting_is_stamped_on_the_chat_for_its_agent(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    response = await _create(chats, chats.alice, [agent], "Hi, I'm here.")

    assert response.status_code == 200, response.text
    async with chats.factory() as session:
        room = await session.get(Room, response.json()["chat"]["roomId"])
        assert room is not None
        assert (room.metadata_ or {})["agent_greeting"] == {
            "agent_id": agent.id,
            "body": "Hi, I'm here.",
        }


async def test_only_the_agents_owner_gives_it_a_greeting(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.bob)

    response = await _create(chats, chats.alice, [agent], "Hi.")

    assert response.status_code == 403
    assert _code(response) == "NOT_AGENT_OWNER"


async def test_a_chat_with_several_agents_has_no_greeting(chats: _Harness) -> None:
    one = await chats.agent("one", owner=chats.alice)
    two = await chats.agent("two", owner=chats.alice)

    response = await _create(chats, chats.alice, [one, two], "Hi.")

    assert response.status_code == 422
    assert _code(response) == "GREETING_NEEDS_ONE_AGENT"


async def test_an_empty_greeting_is_refused(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    response = await _create(chats, chats.alice, [agent], "   ")

    assert response.status_code == 422
    assert _code(response) == "EMPTY_MESSAGE"
