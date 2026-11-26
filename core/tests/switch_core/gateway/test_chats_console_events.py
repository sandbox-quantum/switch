"""What people do to their chats in Switch Console is reported, once each.

A chat turning group, people and agents joining and leaving, and a room taken
off or put back on someone's list. Each is reported once the change commits,
and only a change: an add of someone already in, or hiding a hidden room,
reports nothing.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, Room
from tests.switch_core.gateway.conftest import _Harness


async def _add_agent(chats: _Harness, room_id: str, agent: Agent) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/agents",
        json={"agentId": agent.id},
        headers=chats.as_user(chats.alice),
    )


async def _set_hidden(chats: _Harness, room_id: str, hidden: bool) -> None:
    url = f"/chats/{room_id}/hidden"
    headers = chats.as_user(chats.alice)
    response = await (
        chats.client.put(url, headers=headers)
        if hidden
        else chats.client.delete(url, headers=headers)
    )
    assert response.status_code == 204, response.text


async def test_a_person_joining_makes_a_group_and_is_an_add(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    [group] = chats.telemetry_sink.events("console_chat_became_group")
    assert group["trigger"] == "person_added"
    assert group["age_days"] >= 0  # type: ignore[operator]
    assert chats.telemetry_sink.events("console_member_added") == [
        {
            "member_kind": "person",
            "channel_type": "channel_private",
            "console_chat": True,
        }
    ]


async def test_the_creator_rejoining_is_neither_a_group_nor_an_add(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    assert (await chats.invite(chats.alice, room_id, chats.alice)).status_code == 200

    assert chats.telemetry_sink.events("console_chat_became_group") == []
    assert chats.telemetry_sink.events("console_member_added") == []


async def test_leaving_and_being_removed_are_told_apart(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    left = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.bob)
    )
    assert left.status_code == 204

    assert [
        (event["member_kind"], event["left"])
        for event in chats.telemetry_sink.events("console_member_removed")
    ] == [("person", False), ("person", True)]
    # Removals count toward the room-wide flow as adds do.
    assert chats.telemetry_sink.events("room_users_removed") == [
        {"user_count": 1, "removed_by_kind": "user"},
        {"user_count": 1, "removed_by_kind": "user"},
    ]


async def test_a_room_s_owner_put_in_by_a_template_is_not_a_console_add(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    await chats.service.admit_member(
        "00000000-0000-0000-0000-000000000000", chats.alice, room_id, chats.bob.id
    )

    assert chats.telemetry_sink.events("room_users_added") == [{"user_count": 1}]
    assert chats.telemetry_sink.events("console_member_added") == []


async def test_a_removal_two_requests_race_for_is_reported_once(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    kick = chats.service._provisioning.kick_user
    kicked: list[bool | None] = []

    async def kick_twice(room: str, user: str, **kwargs: object) -> bool | None:
        # The second request passed the membership check before the first
        # took the person out, so its own kick finds them already gone.
        first = await kick(room, user, **kwargs)  # type: ignore[arg-type]
        second = await kick(room, user, **kwargs)  # type: ignore[arg-type]
        kicked.extend([first, second])
        return second

    chats.service._provisioning.kick_user = kick_twice  # type: ignore[method-assign]
    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )

    assert removed.status_code == 204
    assert kicked[1] is False
    assert chats.telemetry_sink.events("console_member_removed") == []
    assert chats.telemetry_sink.events("room_users_removed") == []


async def test_people_named_with_a_room_made_elsewhere_are_not_console_adds(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    unresolved = await chats.service.join_people(
        "00000000-0000-0000-0000-000000000000",
        room_id,
        user_names=["bob"],
        user_ids=[],
    )

    assert unresolved == []
    assert chats.telemetry_sink.events("room_users_added") == [{"user_count": 1}]
    assert chats.telemetry_sink.events("console_member_added") == []


async def test_a_second_agent_makes_a_group_and_both_ways_are_reported(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "c1")

    added = await _add_agent(chats, room_id, other)
    assert added.status_code == 200, added.text
    again = await _add_agent(chats, room_id, other)
    assert again.status_code == 200, again.text
    removed = await chats.client.delete(
        f"/chats/{room_id}/agents/{other.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204

    assert [
        e["trigger"] for e in chats.telemetry_sink.events("console_chat_became_group")
    ] == ["agent_added"]
    assert chats.telemetry_sink.events("console_member_added") == [
        {
            "member_kind": "agent",
            "channel_type": "channel_private",
            "console_chat": True,
        }
    ]
    assert chats.telemetry_sink.events("console_member_removed") == [
        {
            "member_kind": "agent",
            "left": False,
            "channel_type": "channel_private",
            "console_chat": True,
        }
    ]


async def test_a_group_that_fails_to_commit_is_not_reported(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "c1")
    convert = chats.service._group_if_several_agents

    async def convert_then_fail(session: AsyncSession, room: Room) -> None:
        await convert(session, room)
        raise RuntimeError("lost before commit")

    monkeypatch.setattr(chats.service, "_group_if_several_agents", convert_then_fail)
    with pytest.raises(RuntimeError, match="lost before commit"):
        await _add_agent(chats, room_id, other)

    assert chats.telemetry_sink.events("console_chat_became_group") == []
    assert chats.telemetry_sink.events("console_member_added") == []


async def test_only_a_change_to_the_list_is_reported(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    await _set_hidden(chats, room_id, True)
    await _set_hidden(chats, room_id, True)
    await _set_hidden(chats, room_id, False)
    await _set_hidden(chats, room_id, False)

    expected = {"channel_type": "direct", "console_chat": True}
    [hidden] = chats.telemetry_sink.events("console_room_hidden")
    [shown] = chats.telemetry_sink.events("console_room_shown")
    assert {k: hidden[k] for k in expected} == expected
    assert {k: shown[k] for k in expected} == expected


async def test_a_chat_back_on_its_own_is_not_shown_by_the_person(
    chats: _Harness,
) -> None:
    """A message after hiding puts the chat back on the list; un-hiding it
    afterwards changes nothing anyone sees, and hiding it again is a hide."""
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    await _set_hidden(chats, room_id, True)
    sent = await chats.send(chats.alice, room_id, "s1", "back again")
    assert sent.status_code == 200, sent.text
    await _set_hidden(chats, room_id, False)
    await _set_hidden(chats, room_id, True)

    assert len(chats.telemetry_sink.events("console_room_hidden")) == 2
    assert chats.telemetry_sink.events("console_room_shown") == []
