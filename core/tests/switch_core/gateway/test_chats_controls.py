"""`POST /chats/{room_id}/controls`: Switch Console's Stop, reset and compact,
posted as the same `com.switch.command` event a platform bridge writes."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from sqlalchemy import select, update

from switch_core.addressing import owner_only_policy
from switch_core.clients.consumer import Consumer
from switch_core.db.models import Agent, AgentSessionActivityItem, Message, User
from switch_core.events import CommandEvent
from switch_core.transport import RoomRef
from switch_core.transport.stored import to_inbound
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _code, _step


async def _control(
    chats: _Harness,
    user: User,
    room_id: str,
    agent: Agent,
    request_id: str,
    command: str = "reset",
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/controls",
        json={"requestId": request_id, "agentId": agent.id, "command": command},
        headers=chats.as_user(user),
    )


async def _commands(chats: _Harness, room_id: str) -> list[Message]:
    async with chats.factory() as session:
        rows = await session.execute(
            select(Message).where(
                Message.room_id == room_id,
                Message.event_type == "com.switch.command",
            )
        )
        return list(rows.scalars().all())


async def test_a_control_refuses_non_members_and_senders_the_agent_refuses(
    chats: _Harness,
) -> None:
    private = await chats.agent(
        "private", owner=chats.alice, policy=owner_only_policy([]).model_dump()
    )
    room_id = await chats.new_chat(chats.alice, private, "c1")

    outsider = await _control(chats, chats.bob, room_id, private, "k1")
    assert outsider.status_code == 403
    assert _code(outsider) == "NOT_A_MEMBER"

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    refused = await _control(chats, chats.bob, room_id, private, "k1")
    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"

    elsewhere = await chats.agent("elsewhere", owner=chats.alice)
    absent = await _control(chats, chats.alice, room_id, elsewhere, "k2")
    assert absent.status_code == 422
    assert _code(absent) == "AGENT_NOT_IN_CHAT"

    assert await _commands(chats, room_id) == []


async def test_a_repeated_control_posts_one_command(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    first = await _control(chats, chats.alice, room_id, agent, "k1")
    again = await _control(chats, chats.alice, room_id, agent, "k1")
    assert first.status_code == again.status_code == 202
    assert first.json() == again.json()
    assert len(await _commands(chats, room_id)) == 1

    reused = await _control(chats, chats.alice, room_id, agent, "k1", "compact")
    assert reused.status_code == 409
    assert _code(reused) == "REQUEST_REUSED"


async def test_the_posted_control_reaches_command_dispatch(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    response = await _control(chats, chats.alice, room_id, agent, "k1", "compact")
    command_id = response.json()["commandId"]

    [row] = await _commands(chats, room_id)
    async with chats.factory() as session:
        member = await chats.service.member_client(session, chats.alice.id)
    assert member is not None
    assert row.transport_event_id == command_id
    assert row.sender_id == member.transport_user_id

    seen: list[CommandEvent] = []

    async def on_command(_room: RoomRef, event: CommandEvent) -> None:
        seen.append(event)

    consumer = SimpleNamespace(
        _EVENT_DISPATCH=Consumer._EVENT_DISPATCH,
        _should_ignore=lambda _room, _event: False,
        on_command=on_command,
    )
    room = RoomRef(room_id="!room:test")
    inbound = to_inbound(row, [], transport_room_id=room.room_id)
    await Consumer._handle_custom_event(consumer, room, inbound)  # type: ignore[arg-type]

    [event] = seen
    assert event.command == "compact"
    assert event.args == "@helper"
    assert event.user_id == member.transport_user_id
    assert event.user_name == "alice"
    assert event.message_id == event.thread_id == command_id


async def test_a_posted_control_is_shown_in_the_chat(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    response = await _control(chats, chats.alice, room_id, agent, "k1", "reset")
    command_id = response.json()["commandId"]

    page = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    assert page.status_code == 200, page.text
    [shown] = [m for m in page.json()["messages"] if m["messageId"] == command_id]
    assert shown["body"] == "!reset @helper"

    listed = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    [chat] = [c for c in listed.json()["chats"] if c["roomId"] == room_id]
    assert chat["lastMessage"]["preview"] == "!reset @helper"


async def test_stop_refuses_unless_the_agents_current_turn_is_in_this_chat(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    here = await chats.new_chat(chats.alice, agent, "c1")
    there = await chats.new_chat(chats.alice, agent, "c2")

    idle = await _control(chats, chats.alice, here, agent, "k1", "interrupt")
    assert idle.status_code == 409
    assert _code(idle) == "NOTHING_RUNNING_HERE"

    await _step(chats, agent, here, "t1", "turn", 1)
    await _step(chats, agent, there, "t2", "turn", 1)
    elsewhere = await _control(chats, chats.alice, here, agent, "k2", "interrupt")
    assert elsewhere.status_code == 409
    assert _code(elsewhere) == "NOTHING_RUNNING_HERE"
    assert await _commands(chats, here) == []

    stopped = await _control(chats, chats.alice, there, agent, "k3", "interrupt")
    assert stopped.status_code == 202, stopped.text
    assert len(await _commands(chats, there)) == 1


async def test_stop_follows_the_running_turn_not_one_queued_behind_it(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    running_room = await chats.new_chat(chats.alice, agent, "c1")
    queued_room = await chats.new_chat(chats.alice, agent, "c2")
    await _step(chats, agent, running_room, "t1", "turn", 1)
    await _step(chats, agent, queued_room, "t2", "turn", 1)
    async with chats.factory() as session:
        await session.execute(
            update(AgentSessionActivityItem)
            .where(AgentSessionActivityItem.turn_id == "t2")
            .values(status="queued")
        )
        await session.commit()

    queued = await _control(chats, chats.alice, queued_room, agent, "k1", "interrupt")
    assert queued.status_code == 409
    assert _code(queued) == "NOTHING_RUNNING_HERE"

    running = await _control(chats, chats.alice, running_room, agent, "k2", "interrupt")
    assert running.status_code == 202, running.text


async def _retry(
    chats: _Harness,
    user: User,
    room_id: str,
    agent: Agent,
    request_id: str,
    message_id: str | None,
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/controls",
        json={
            "requestId": request_id,
            "agentId": agent.id,
            "command": "retry",
            **({"messageId": message_id} if message_id is not None else {}),
        },
        headers=chats.as_user(user),
    )


async def _turn_for(
    chats: _Harness, agent: Agent, room_id: str, message_id: str
) -> None:
    await _step(chats, agent, room_id, "t1", "turn", 1)
    async with chats.factory() as session:
        await session.execute(
            update(AgentSessionActivityItem)
            .where(AgentSessionActivityItem.turn_id == "t1")
            .values(message_id=message_id, status="error")
        )
        await session.commit()


async def test_a_retry_names_a_message_the_agent_took_a_turn_for(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    sent = await chats.send(chats.alice, room_id, "m1", "@helper plan a picnic")
    message_id = sent.json()["messages"][0]["messageId"]

    unnamed = await _retry(chats, chats.alice, room_id, agent, "k0", None)
    assert unnamed.status_code == 422
    assert _code(unnamed) == "INVALID_CONTROL"
    elsewhere = await _retry(chats, chats.alice, room_id, agent, "k1", "$nowhere")
    assert elsewhere.status_code == 404
    assert _code(elsewhere) == "MESSAGE_NOT_FOUND"
    untried = await _retry(chats, chats.alice, room_id, agent, "k2", message_id)
    assert untried.status_code == 409
    assert _code(untried) == "NOTHING_TO_RETRY"
    assert await _commands(chats, room_id) == []

    await _turn_for(chats, agent, room_id, message_id)
    accepted = await _retry(chats, chats.alice, room_id, agent, "k3", message_id)
    assert accepted.status_code == 202, accepted.text
    [row] = await _commands(chats, room_id)
    assert row.content["command"] == "retry"
    assert row.content["args"] == f"@helper {message_id}"
    # Nothing the person wrote is posted again.
    humans = [
        m
        for m in await chats.message_rows(room_id)
        if m.body == "@helper plan a picnic"
    ]
    assert len(humans) == 1


async def test_a_retry_is_for_the_sender_or_a_manager_and_posts_once(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    sent = await chats.send(chats.alice, room_id, "m1", "@helper plan a picnic")
    message_id = sent.json()["messages"][0]["messageId"]
    await _turn_for(chats, agent, room_id, message_id)

    not_theirs = await _retry(chats, chats.bob, room_id, agent, "k1", message_id)
    assert not_theirs.status_code in (403,)
    assert _code(not_theirs) in ("NOT_YOUR_MESSAGE", "AGENT_NOT_ALLOWED")

    # A double press, or a reconnect replaying the request: one command.
    first = await _retry(chats, chats.alice, room_id, agent, "k2", message_id)
    again = await _retry(chats, chats.alice, room_id, agent, "k2", message_id)
    assert first.status_code == again.status_code == 202
    assert first.json() == again.json()
    assert len(await _commands(chats, room_id)) == 1
    other = await _retry(chats, chats.alice, room_id, agent, "k2", "$other")
    assert other.status_code == 409
    assert _code(other) == "REQUEST_REUSED"


async def test_only_a_failed_or_interrupted_turn_is_retried(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    sent = await chats.send(chats.alice, room_id, "m1", "@helper plan a picnic")
    message_id = sent.json()["messages"][0]["messageId"]
    await _turn_for(chats, agent, room_id, message_id)
    for index, status in enumerate(("running", "completed")):
        async with chats.factory() as session:
            await session.execute(
                update(AgentSessionActivityItem)
                .where(AgentSessionActivityItem.turn_id == "t1")
                .values(status=status)
            )
            await session.commit()
        refused = await _retry(
            chats, chats.alice, room_id, agent, f"k{index}", message_id
        )
        assert refused.status_code == 409
        assert _code(refused) == "NOTHING_TO_RETRY"
    assert await _commands(chats, room_id) == []


async def test_a_member_is_offered_the_visible_commands_and_no_hidden_one(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    outsider = await chats.client.get(
        f"/chats/{room_id}/commands", headers=chats.as_user(chats.bob)
    )
    assert outsider.status_code == 403

    listed = await chats.client.get(
        f"/chats/{room_id}/commands", headers=chats.as_user(chats.alice)
    )
    assert listed.status_code == 200, listed.text
    commands = {each["name"]: each for each in listed.json()["commands"]}
    assert "retry" not in commands
    assert commands["reset"]["usage"] == "!reset <target>"
    assert commands["help"]["usage"] == "!help"
    assert all(each["description"] for each in commands.values())
