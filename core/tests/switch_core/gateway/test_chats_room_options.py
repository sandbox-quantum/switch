"""`POST /chats` with a room's own settings — description, instructions,
group and access — as the New room dialog sends them for a Switch Console
chat, against real Postgres through the shared harness."""

from __future__ import annotations

from typing import Any

import httpx

from switch_core.db.models import Room, RoomGroup, Tenant, User
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import TENANT, _code


async def _group(chats: _Harness, name: str = "Ops") -> str:
    async with chats.factory() as session:
        group = RoomGroup(tenant_id=TENANT, name=name)
        session.add(group)
        await session.commit()
        return group.id


async def _room(chats: _Harness, room_id: str) -> Room:
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        return room


async def _create(chats: _Harness, user: User, **body: Any) -> httpx.Response:
    return await chats.client.post(
        "/chats",
        json={"kind": "group", "requestId": "c1", **body},
        headers=chats.as_user(user),
    )


async def test_a_chat_takes_its_description_instructions_and_access(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await _create(
        chats,
        chats.alice,
        agentIds=[agent.id],
        name="Planning",
        description="  Where we plan  ",
        instructions="Keep answers short.",
        readVisibility="public",
        writeVisibility="private",
    )
    assert created.status_code == 200, created.text
    room = await _room(chats, created.json()["chat"]["roomId"])
    assert room.description == "Where we plan"
    assert room.instructions == "Keep answers short."
    assert (room.read_visibility, room.write_visibility) == ("public", "private")
    assert room.group_id is None


async def test_a_chat_without_them_is_made_as_before(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await _create(chats, chats.alice, agentIds=[agent.id], description="  ")
    assert created.status_code == 200, created.text
    room = await _room(chats, created.json()["chat"]["roomId"])
    assert room.description == "Switch Console chat with helper"
    assert room.instructions is None
    assert (room.read_visibility, room.write_visibility) == ("private", "private")


async def test_access_goes_as_a_valid_pair(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    half = await _create(
        chats, chats.alice, agentIds=[agent.id], readVisibility="public"
    )
    assert half.status_code == 422
    assert _code(half) == "ACCESS_INCOMPLETE"
    upside_down = await _create(
        chats,
        chats.alice,
        agentIds=[agent.id],
        readVisibility="private",
        writeVisibility="public",
    )
    assert upside_down.status_code == 422
    assert _code(upside_down) == "BAD_ACCESS"


async def test_an_admin_files_the_chat_in_a_group(chats: _Harness) -> None:
    group_id = await _group(chats)
    agent = await chats.agent("helper", owner=chats.admin)
    created = await _create(chats, chats.admin, agentIds=[agent.id], groupId=group_id)
    assert created.status_code == 200, created.text
    room = await _room(chats, created.json()["chat"]["roomId"])
    assert room.group_id == group_id


async def test_only_an_admin_files_a_chat_in_a_group(chats: _Harness) -> None:
    group_id = await _group(chats)
    agent = await chats.agent("helper", owner=chats.alice)
    refused = await _create(chats, chats.alice, agentIds=[agent.id], groupId=group_id)
    assert refused.status_code == 403
    assert _code(refused) == "GROUP_FILING_NOT_ALLOWED"
    # Nor does a refusal say whether the group exists.
    missing = await _create(
        chats, chats.alice, agentIds=[agent.id], groupId="no-such", requestId="c2"
    )
    assert _code(missing) == "GROUP_FILING_NOT_ALLOWED"


async def test_a_group_that_is_not_there_is_refused(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.admin)
    created = await _create(
        chats,
        chats.admin,
        agentIds=[agent.id],
        groupId="00000000-0000-0000-0000-00000000dead",
    )
    assert created.status_code == 404
    assert _code(created) == "GROUP_NOT_FOUND"


async def test_an_id_of_any_shape_is_a_group_not_found(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.admin)
    created = await _create(chats, chats.admin, agentIds=[agent.id], groupId="no-such")
    assert created.status_code == 404
    assert _code(created) == "GROUP_NOT_FOUND"


async def test_another_workspaces_group_is_not_found(chats: _Harness) -> None:
    async with chats.factory() as session:
        session.add(Tenant(id="tenant-b", slug="tenant-b", name="Tenant B"))
        await session.flush()
        group = RoomGroup(tenant_id="tenant-b", name="Theirs")
        session.add(group)
        await session.commit()
        foreign_id = group.id
    agent = await chats.agent("helper", owner=chats.admin)
    created = await _create(chats, chats.admin, agentIds=[agent.id], groupId=foreign_id)
    assert created.status_code == 404
    assert _code(created) == "GROUP_NOT_FOUND"


async def test_the_agents_are_checked_as_addressed_in_the_group(
    chats: _Harness,
) -> None:
    group_id = await _group(chats)
    other_id = await _group(chats, "Elsewhere")
    agent = await chats.agent(
        "grouped",
        owner=chats.alice,
        policy={"rules": [{"room_groups": [group_id], "users": "*"}]},
    )
    refused = await _create(chats, chats.admin, agentIds=[agent.id], groupId=other_id)
    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    admitted = await _create(
        chats, chats.admin, agentIds=[agent.id], groupId=group_id, requestId="c2"
    )
    assert admitted.status_code == 200, admitted.text


async def test_the_settings_are_part_of_what_a_retry_must_repeat(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    first = await _create(chats, chats.alice, agentIds=[agent.id], description="A")
    assert first.status_code == 200, first.text
    again = await _create(chats, chats.alice, agentIds=[agent.id], description="A")
    assert again.json()["chat"]["roomId"] == first.json()["chat"]["roomId"]
    changed = await _create(chats, chats.alice, agentIds=[agent.id], description="B")
    assert changed.status_code == 409
    assert _code(changed) == "REQUEST_REUSED"


async def test_the_agents_offered_for_a_new_chat_follow_its_group(
    chats: _Harness,
) -> None:
    group_id = await _group(chats)
    agent = await chats.agent(
        "grouped",
        owner=chats.alice,
        policy={"rules": [{"room_groups": [group_id], "users": "*"}]},
    )

    async def offered(query: str) -> list[str]:
        response = await chats.client.get(
            f"/chats/agent-candidates{query}", headers=chats.as_user(chats.admin)
        )
        assert response.status_code == 200, response.text
        return list(response.json()["agentIds"])

    assert agent.id not in await offered("")
    assert agent.id in await offered(f"?groupId={group_id}")
