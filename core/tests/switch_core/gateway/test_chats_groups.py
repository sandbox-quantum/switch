"""`/chats` group chats: a direct chat turning into a group, creating a chat
with people, adding and removing agents, naming several agents, and reading
a thread — against real Postgres, through the shared harness."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core import room_changes as room_changes_module
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_OWNER_MARKER_META_KEY,
)
from switch_core.chats.service import ChatError, ChatService
from switch_core.db.models import Agent, Client, Message, Room, User, room_agents
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import chats as chats_module
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.schemas import RoomUpdateRequest
from switch_core.room_changes import RoomChanges, people_concerned
from switch_core.user_changes import ROOM
from tests.switch_core.gateway.conftest import (
    _chat_service,
    _FakeActivityListener,
    _FakeListener,
    _Harness,
)
from tests.switch_core.gateway.test_chats_routes import (
    TENANT,
    _code,
    _events_of,
    _left_chat,
    _listed,
    _reads,
    _stream,
)


async def _channel_type(chats: _Harness, room_id: str) -> str | None:
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        return room.channel_type


async def _agent_ids(chats: _Harness, room_id: str) -> set[str]:
    async with chats.factory() as session:
        return set(
            (
                await session.execute(
                    select(room_agents.c.agent_id).where(
                        room_agents.c.room_id == room_id
                    )
                )
            ).scalars()
        )


async def _set_policy(chats: _Harness, agent: Agent, policy: dict) -> None:
    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.addressing_policy = policy
        await session.commit()


async def _add_agent(
    chats: _Harness, manager_id: str, room_id: str, agent: Agent
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/agents",
        json={"agentId": agent.id},
        headers={"x-user": manager_id},
    )


async def _addressed(chats: _Harness, room_id: str, agent: Agent, body: str) -> bool:
    sent = await chats.send(chats.alice, room_id, body, body)
    assert sent.status_code == 200, sent.text
    seq = sent.json()["messages"][0]["seq"]
    return (room_id, seq) in await _events_of(chats, agent)


# ── Direct becomes group ─────────────────────────────────────────────────────


async def test_adding_a_person_makes_a_direct_chat_a_group_for_good(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert await _addressed(chats, room_id, agent, "before") is True

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert await _channel_type(chats, room_id) == "channel_private"
    assert await _addressed(chats, room_id, agent, "unnamed") is False
    assert await _addressed(chats, room_id, agent, "@helper named") is True

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert await _channel_type(chats, room_id) == "channel_private"
    assert await _addressed(chats, room_id, agent, "still a group") is False


async def test_the_creator_rejoining_keeps_a_chat_direct(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.alice)).status_code == 200
    assert await _channel_type(chats, room_id) == "direct"


async def test_a_second_agent_makes_a_direct_chat_a_group(chats: _Harness) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "c1")

    added = await _add_agent(chats, chats.alice.id, room_id, other)
    assert added.status_code == 200, added.text
    chat = added.json()["chat"]
    assert chat["channelType"] == "channel_private"
    assert {a["id"] for a in chat["agents"]} == {helper.id, other.id}
    assert await _addressed(chats, room_id, helper, "unnamed") is False

    removed = await chats.client.delete(
        f"/chats/{room_id}/agents/{other.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert await _channel_type(chats, room_id) == "channel_private"
    assert await _addressed(chats, room_id, helper, "one agent, still a group") is False


async def test_a_second_agent_that_fails_to_commit_leaves_the_chat_direct(
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
        await _add_agent(chats, chats.alice.id, room_id, other)
    assert await _agent_ids(chats, room_id) == {helper.id}
    assert await _channel_type(chats, room_id) == "direct"


async def test_concurrent_agent_adds_make_one_group(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    convert = chats.service._group_if_several_agents
    both_written = asyncio.Barrier(2)

    async def after_both_agents_are_written(session: AsyncSession, room: Room) -> None:
        await both_written.wait()
        await convert(session, room)

    monkeypatch.setattr(
        chats.service, "_group_if_several_agents", after_both_agents_are_written
    )
    helper = await chats.agent("helper", owner=chats.alice)
    ann = await chats.agent("ann", owner=chats.alice)
    ben = await chats.agent("ben", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "c1")
    await chats.room_service.remove_agents_from_room(room_id, [helper.id])
    assert await _channel_type(chats, room_id) == "direct"

    responses = await asyncio.gather(
        _add_agent(chats, chats.alice.id, room_id, ann),
        _add_agent(chats, chats.alice.id, room_id, ben),
    )
    assert [r.status_code for r in responses] == [200, 200]
    assert await _agent_ids(chats, room_id) == {ann.id, ben.id}
    assert await _channel_type(chats, room_id) == "channel_private"


async def test_an_owner_grant_does_not_make_a_group(chats: _Harness) -> None:
    agent = await chats.agent("mine", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    [guest] = await _agent_ids(chats, room_id)
    await chats.room_service.remove_agents_from_room(room_id, [guest])
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])

    assert await _reads(chats, chats.alice, room_id) == 200
    assert await _channel_type(chats, room_id) == "direct"
    assert await _addressed(chats, room_id, agent, "hello") is True


async def test_a_person_who_fails_to_commit_leaves_the_chat_direct(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    provisioning = chats.service._provisioning
    record_join = provisioning.record_join

    async def join_then_fail(
        session: AsyncSession, room_id: str, user_id: str
    ) -> Callable[[], None]:
        await record_join(session, room_id, user_id)
        raise RuntimeError("lost before commit")

    monkeypatch.setattr(provisioning, "record_join", join_then_fail)
    with pytest.raises(RuntimeError, match="lost before commit"):
        await chats.invite(chats.alice, room_id, chats.bob)
    assert await _channel_type(chats, room_id) == "direct"
    assert await _reads(chats, chats.bob, room_id) == 403
    async with chats.factory() as session:
        bob = await chats.service.member_client(session, chats.bob.id)
        assert bob is not None
        arrivals = await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.room_id == room_id, Message.sender_client_id == bob.id)
        )
    assert arrivals == 0


async def test_concurrent_adds_leave_one_consistent_group(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    lock = chats.service._locked_room
    both_ready = asyncio.Barrier(2)

    async def together(session: AsyncSession, locked_room_id: str) -> Room:
        await both_ready.wait()
        return await lock(session, locked_room_id)

    monkeypatch.setattr(chats.service, "_locked_room", together)

    responses = await asyncio.gather(
        chats.invite(chats.alice, room_id, chats.bob),
        chats.invite(chats.alice, room_id, chats.admin),
    )
    assert [r.status_code for r in responses] == [200, 200]
    assert await _channel_type(chats, room_id) == "channel_private"
    members = await chats.client.get(
        f"/chats/{room_id}/members", headers=chats.as_user(chats.alice)
    )
    assert {m["userId"] for m in members.json()["members"]} == {
        chats.alice.id,
        chats.bob.id,
        chats.admin.id,
    }


async def test_a_bridged_direct_room_is_never_converted(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    async with chats.factory() as session:
        room = Room(
            transport_room_id="!dm:test",
            name="dm",
            description="",
            owner_id=chats.alice.id,
            channel_type="direct",
        )
        session.add(room)
        await session.flush()
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await session.commit()
        room_id = room.id

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    added = await _add_agent(chats, chats.alice.id, room_id, other)
    assert added.status_code == 200
    assert await _channel_type(chats, room_id) == "direct"


async def test_removing_a_person_updates_the_others_summary(chats: _Harness) -> None:
    created = await chats.client.post(
        "/chats",
        json={
            "agentIds": [],
            "memberUserIds": [chats.bob.id, chats.admin.id],
            "requestId": "c1",
        },
        headers=chats.as_user(chats.alice),
    )
    room_id = created.json()["chat"]["roomId"]
    assert created.json()["chat"]["memberCount"] == 3

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    name, summary = await events.next()
    assert (name, summary["memberCount"]) == ("chat", 3)
    assert (await events.next())[0] == "ready"

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.admin.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    name, summary = await events.next()
    assert (name, summary["roomId"], summary["memberCount"]) == ("chat", room_id, 2)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_swapping_one_person_for_another_updates_the_summary(
    chats: _Harness,
) -> None:
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "memberUserIds": [chats.bob.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    room_id = created.json()["chat"]["roomId"]
    assert created.json()["chat"]["memberUserIds"] == sorted(
        [chats.alice.id, chats.bob.id]
    )

    events = _stream(chats, chats.alice, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert (await chats.invite(chats.alice, room_id, chats.admin)).status_code == 200
    # The stream reads both changes in one pass: same count, other people.
    name, summary = await events.next()
    assert name == "chat"
    assert summary["memberUserIds"] == sorted([chats.alice.id, chats.admin.id])
    assert summary["memberCount"] == 2
    await events.stream.aclose()  # type: ignore[attr-defined]


# ── Creating with people ─────────────────────────────────────────────────────


async def test_a_chat_with_people_and_no_agent_is_a_listed_group(
    chats: _Harness,
) -> None:
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "memberUserIds": [chats.bob.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    chat = created.json()["chat"]
    assert chat["channelType"] == "channel_private"
    assert chat["agents"] == []
    assert chat["roomId"] in await _listed(chats, chats.bob)
    assert chat["roomId"] in await _listed(chats, chats.alice)
    assert (await chats.send(chats.bob, chat["roomId"], "s1", "hi")).status_code == 200


async def test_a_chat_with_no_agents_and_no_one_else(chats: _Harness) -> None:
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    chat = created.json()["chat"]
    assert chat["agents"] == []
    assert chat["channelType"] == "channel_private"
    assert chat["roomId"] in await _listed(chats, chats.alice)
    async with chats.factory() as session:
        room = await session.get(Room, chat["roomId"])
        assert room is not None
        assert room.description == "Switch Console chat"


async def test_one_agent_and_a_person_make_a_group(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={"agentId": agent.id, "memberUserIds": [chats.bob.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    room_id = created.json()["chat"]["roomId"]
    assert created.json()["chat"]["channelType"] == "channel_private"
    assert await _addressed(chats, room_id, agent, "unnamed") is False
    assert await _addressed(chats, room_id, agent, "@helper named") is True


async def test_kind_group_makes_a_group_of_one_agent(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={"agentId": agent.id, "kind": "group", "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    room_id = created.json()["chat"]["roomId"]
    assert created.json()["chat"]["channelType"] == "channel_private"
    assert await _channel_type(chats, room_id) == "channel_private"
    assert room_id in await _listed(chats, chats.alice)
    assert await _addressed(chats, room_id, agent, "unnamed") is False
    assert await _addressed(chats, room_id, agent, "@helper named") is True


async def test_kind_is_part_of_what_a_retry_must_repeat(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    async def create(**extra: str) -> httpx.Response:
        return await chats.client.post(
            "/chats",
            json={"agentId": agent.id, "requestId": "c1", **extra},
            headers=chats.as_user(chats.alice),
        )

    first = await create(kind="group")
    assert first.status_code == 200, first.text
    assert (await create(kind="group")).json()["chat"]["roomId"] == first.json()[
        "chat"
    ]["roomId"]
    other = await create()
    assert other.status_code == 409
    assert _code(other) == "REQUEST_REUSED"


async def test_a_create_ignores_the_creator_and_repeats_in_who_it_adds(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={
            "agentIds": [agent.id, agent.id],
            "memberUserIds": [chats.bob.id, chats.alice.id, chats.bob.id],
            "kind": "group",
            "requestId": "c1",
        },
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    chat = created.json()["chat"]
    assert [each["id"] for each in chat["agents"]] == [agent.id]
    assert chat["memberUserIds"] == sorted([chats.alice.id, chats.bob.id])
    assert chat["memberCount"] == 2


async def test_a_group_does_not_open_with_a_greeting(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={
            "agentId": agent.id,
            "kind": "group",
            "greeting": "Hi",
            "requestId": "c1",
        },
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 422
    assert _code(created) == "GREETING_NEEDS_ONE_AGENT"


async def test_a_create_with_people_is_retried_as_one_request(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    async def create(member_ids: list[str]) -> httpx.Response:
        return await chats.client.post(
            "/chats",
            json={"agentId": agent.id, "memberUserIds": member_ids, "requestId": "c1"},
            headers=chats.as_user(chats.alice),
        )

    first = await create([chats.bob.id])
    second = await create([chats.bob.id, chats.alice.id])
    assert first.status_code == second.status_code == 200
    assert first.json()["chat"]["roomId"] == second.json()["chat"]["roomId"]

    other = await create([chats.admin.id])
    assert other.status_code == 409
    assert _code(other) == "REQUEST_REUSED"


async def test_a_create_refuses_someone_outside_the_workspace(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    refused = await chats.client.post(
        "/chats",
        json={
            "agentId": agent.id,
            "memberUserIds": [chats.carol.id],
            "requestId": "c1",
        },
        headers=chats.as_user(chats.alice),
    )
    assert refused.status_code == 422
    assert _code(refused) == "NOT_A_TENANT_MEMBER"


async def _make_bootstrap_owner(chats: _Harness, user: User) -> None:
    async with chats.factory() as session:
        row = await session.get(User, user.id)
        assert row is not None
        row.metadata_ = {BOOTSTRAP_OWNER_MARKER_META_KEY: True}
        await session.commit()


async def test_the_bootstrap_owner_is_not_a_person_to_chat_with(
    chats: _Harness,
) -> None:
    await _make_bootstrap_owner(chats, chats.bob)
    agent = await chats.agent("helper", owner=chats.alice)
    owned = await chats.agent("bootstrapped", owner=chats.bob)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    refused = await chats.invite(chats.alice, room_id, chats.bob)
    assert refused.status_code == 422
    assert _code(refused) == "NOT_A_PERSON"
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "memberUserIds": [chats.bob.id], "requestId": "c2"},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 422
    assert _code(created) == "NOT_A_PERSON"

    # Its agents are still welcome, and the flag is the marker, not a name.
    assert (await _add_agent(chats, chats.alice.id, room_id, owned)).status_code == 200
    async with chats.factory() as session:
        admin = await session.get(User, chats.admin.id)
        assert admin is not None
        admin.name = "Agent Bootstrap"
        await session.commit()
    assert (await chats.invite(chats.alice, room_id, chats.admin)).status_code == 200


# ── Adding and removing agents ───────────────────────────────────────────────


async def test_adding_an_agent_needs_its_permission_in_this_room(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    scoped = await chats.agent("scoped", owner=chats.admin)
    denied_room = await chats.new_chat(chats.alice, helper, "c1")
    allowed_room = await chats.new_chat(chats.alice, helper, "c2")
    await _set_policy(chats, scoped, {"rules": [{"rooms": [allowed_room]}]})

    refused = await _add_agent(chats, chats.alice.id, denied_room, scoped)
    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    assert await _agent_ids(chats, denied_room) == {helper.id}
    assert await _channel_type(chats, denied_room) == "direct"

    added = await _add_agent(chats, chats.alice.id, allowed_room, scoped)
    assert added.status_code == 200, added.text
    assert await _agent_ids(chats, allowed_room) == {helper.id, scoped.id}


async def test_only_a_manager_adds_or_removes_an_agent(chats: _Harness) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.bob)
    room_id = await chats.new_chat(chats.alice, helper, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    added = await _add_agent(chats, chats.bob.id, room_id, other)
    assert added.status_code == 403
    assert _code(added) == "NOT_A_MANAGER"
    removed = await chats.client.delete(
        f"/chats/{room_id}/agents/{helper.id}", headers=chats.as_user(chats.bob)
    )
    assert removed.status_code == 403
    assert await _agent_ids(chats, room_id) == {helper.id}


async def test_adding_and_removing_an_agent_are_idempotent(chats: _Harness) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, helper, "c1")

    again = await _add_agent(chats, chats.alice.id, room_id, helper)
    assert again.status_code == 200
    assert await _channel_type(chats, room_id) == "direct"

    for _ in range(2):
        removed = await chats.client.delete(
            f"/chats/{room_id}/agents/{helper.id}", headers=chats.as_user(chats.alice)
        )
        assert removed.status_code == 204
    assert await _agent_ids(chats, room_id) == set()
    # A Switch Console chat stays listed, and readable, with no agent left.
    assert room_id in await _listed(chats, chats.alice)
    assert await _reads(chats, chats.alice, room_id) == 200


async def test_a_manager_removes_an_agent_they_may_no_longer_use(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    guest = await chats.agent("guest", owner=chats.admin)
    room_id = await chats.new_chat(chats.alice, helper, "c1")
    added = await _add_agent(chats, chats.alice.id, room_id, guest)
    assert added.status_code == 200
    await _set_policy(chats, guest, {"rules": [{"owner": True, "users": []}]})

    removed = await chats.client.delete(
        f"/chats/{room_id}/agents/{guest.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert await _agent_ids(chats, room_id) == {helper.id}


async def _candidates(chats: _Harness, user: User, room_id: str | None) -> Any:
    return await chats.client.get(
        "/chats/agent-candidates",
        params={"roomId": room_id} if room_id is not None else {},
        headers=chats.as_user(user),
    )


async def test_agent_candidates_are_the_agents_the_caller_may_add(
    chats: _Harness,
) -> None:
    mine = await chats.agent("mine", owner=chats.alice)
    spare = await chats.agent("spare", owner=chats.alice)
    private = await chats.agent("private", owner=chats.bob)
    await _set_policy(chats, private, {"rules": [{"owner": True, "users": []}]})
    scoped = await chats.agent("scoped", owner=chats.bob)
    room_id = await chats.new_chat(chats.alice, mine, "c1")
    await _set_policy(chats, scoped, {"rules": [{"rooms": [room_id]}]})

    new_chat = await _candidates(chats, chats.alice, None)
    assert new_chat.status_code == 200, new_chat.text
    assert set(new_chat.json()["agentIds"]) == {mine.id, spare.id}

    in_room = await _candidates(chats, chats.alice, room_id)
    assert set(in_room.json()["agentIds"]) == {spare.id, scoped.id}

    outsider = await _candidates(chats, chats.bob, room_id)
    assert outsider.status_code == 403
    assert _code(outsider) == "NOT_A_MANAGER"


# ── Mentions ─────────────────────────────────────────────────────────────────


async def test_mention_agent_ids_address_only_those_agents(chats: _Harness) -> None:
    a = await chats.agent("ann", owner=chats.alice)
    b = await chats.agent("ben", owner=chats.alice)
    c = await chats.agent("cat", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [a.id, b.id, c.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    room_id = created.json()["chat"]["roomId"]

    sent = await chats.send(
        chats.alice,
        room_id,
        "s1",
        "please look",
        mentionAgentIds=[b.id],
        mentionAgentId=a.id,
    )
    assert sent.status_code == 200, sent.text
    [message] = sent.json()["messages"]
    assert message["body"] == "@ann @ben please look"
    assert sorted(message["namedAgentIds"]) == sorted([a.id, b.id])
    place = (room_id, message["seq"])
    assert place in await _events_of(chats, a)
    assert place in await _events_of(chats, b)
    assert place not in await _events_of(chats, c)

    retried = await chats.send(
        chats.alice,
        room_id,
        "s1",
        "please look",
        mentionAgentIds=[b.id],
        mentionAgentId=a.id,
    )
    assert retried.json()["messages"][0]["seq"] == message["seq"]
    reused = await chats.send(
        chats.alice, room_id, "s1", "please look", mentionAgentIds=[c.id]
    )
    assert reused.status_code == 409


# ── Threads ──────────────────────────────────────────────────────────────────


async def test_a_thread_pages_its_replies_and_roots_count_them(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    root = (await chats.send(chats.alice, room_id, "r", "root")).json()["messages"][0]
    other = (await chats.send(chats.alice, room_id, "o", "other")).json()["messages"][0]
    replies = [
        (
            await chats.send(
                chats.alice,
                room_id,
                f"t{i}",
                f"reply {i}",
                threadRootId=root["messageId"],
            )
        ).json()["messages"][0]
        for i in range(3)
    ]

    url = f"/chats/{room_id}/threads/{root['messageId']}/messages"
    first = await chats.client.get(
        url, params={"limit": 2}, headers=chats.as_user(chats.alice)
    )
    assert first.status_code == 200, first.text
    page = first.json()
    assert [m["body"] for m in page["messages"]] == ["reply 1", "reply 2"]
    assert page["hasMore"] is True
    older = await chats.client.get(
        url,
        params={"limit": 2, "beforeSeq": page["messages"][0]["seq"]},
        headers=chats.as_user(chats.alice),
    )
    assert [m["body"] for m in older.json()["messages"]] == ["reply 0"]
    assert older.json()["hasMore"] is False

    history = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    by_id = {m["messageId"]: m for m in history.json()["messages"]}
    assert by_id[root["messageId"]]["threadReplyCount"] == 3
    assert by_id[root["messageId"]]["threadLastReplySeq"] == replies[-1]["seq"]
    assert by_id[other["messageId"]]["threadReplyCount"] == 0
    assert by_id[other["messageId"]]["threadLastReplySeq"] is None
    assert by_id[replies[0]["messageId"]]["threadRootId"] == root["messageId"]


async def test_a_thread_is_read_only_by_members_and_only_in_its_room(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    elsewhere = await chats.new_chat(chats.alice, agent, "c2")
    foreign = (await chats.send(chats.alice, elsewhere, "f", "there")).json()[
        "messages"
    ][0]
    root = (await chats.send(chats.alice, room_id, "r", "root")).json()["messages"][0]

    missing = await chats.client.get(
        f"/chats/{room_id}/threads/{foreign['messageId']}/messages",
        headers=chats.as_user(chats.alice),
    )
    assert missing.status_code == 404
    assert _code(missing) == "THREAD_NOT_FOUND"
    outsider = await chats.client.get(
        f"/chats/{room_id}/threads/{root['messageId']}/messages",
        headers=chats.as_user(chats.bob),
    )
    assert outsider.status_code == 403


async def test_history_stays_readable_once_the_agents_are_gone(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.send(chats.alice, room_id, "s1", "kept")).status_code == 200
    await chats.room_service.remove_agents_from_room(room_id, [agent.id])

    history = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    assert history.status_code == 200
    assert "kept" in [m["body"] for m in history.json()["messages"]]


# ── Reading ──────────────────────────────────────────────────────────────────


async def _summary_of(chats: _Harness, user: User, room_id: str) -> dict[str, Any]:
    return (await _listed(chats, user))[room_id]


async def _read(chats: _Harness, user: User, room_id: str, seq: int) -> httpx.Response:
    return await chats.client.put(
        f"/chats/{room_id}/read", json={"seq": seq}, headers=chats.as_user(user)
    )


async def test_unread_counts_others_messages_past_the_read_position(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    before = await chats.send(chats.alice, room_id, "s0", "said before bob")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert (await _summary_of(chats, chats.bob, room_id))["unreadCount"] == 0

    first = (await chats.send(chats.alice, room_id, "s1", "one")).json()["messages"][0]
    await chats.send(chats.alice, room_id, "s2", "two")
    await chats.send(chats.bob, room_id, "s3", "bob's own")
    assert (await _summary_of(chats, chats.bob, room_id))["unreadCount"] == 2
    assert (await _summary_of(chats, chats.alice, room_id))["unreadCount"] == 1

    assert (await _read(chats, chats.bob, room_id, first["seq"])).status_code == 204
    assert (await _summary_of(chats, chats.bob, room_id))["unreadCount"] == 1
    # Never backwards, and idempotent.
    older = before.json()["messages"][0]["seq"]
    assert (await _read(chats, chats.bob, room_id, older)).status_code == 204
    assert (await _read(chats, chats.bob, room_id, first["seq"])).status_code == 204
    assert (await _summary_of(chats, chats.bob, room_id))["unreadCount"] == 1

    ahead = await _read(chats, chats.bob, room_id, 10_000)
    assert ahead.status_code == 422
    assert _code(ahead) == "SEQ_OUT_OF_RANGE"
    outsider = await _read(chats, chats.admin, room_id, first["seq"])
    assert outsider.status_code == 403


async def test_reading_re_sends_the_readers_summary(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    sent = (await chats.send(chats.alice, room_id, "s1", "hi")).json()["messages"][0]

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    name, summary = await events.next()
    assert (name, summary["unreadCount"]) == ("chat", 1)
    assert (await events.next())[0] == "ready"

    assert (await _read(chats, chats.bob, room_id, sent["seq"])).status_code == 204
    name, summary = await events.next()
    assert (name, summary["unreadCount"]) == ("chat", 0)
    await events.stream.aclose()  # type: ignore[attr-defined]


# ── People mentions and leaving ──────────────────────────────────────────────


async def test_naming_a_person_wakes_no_agent_even_one_of_the_same_name(
    chats: _Harness,
) -> None:
    namesake = await chats.agent("bob", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={
            "agentIds": [namesake.id],
            "memberUserIds": [chats.bob.id],
            "requestId": "c1",
        },
        headers=chats.as_user(chats.alice),
    )
    room_id = created.json()["chat"]["roomId"]

    person = await chats.send(
        chats.alice, room_id, "s1", "@bob can you look?", mentionUserIds=[chats.bob.id]
    )
    assert person.status_code == 200, person.text
    [message] = person.json()["messages"]
    assert message["namedUserIds"] == [chats.bob.id]
    assert message["namedAgentIds"] == []
    assert (room_id, message["seq"]) not in await _events_of(chats, namesake)

    both = await chats.send(
        chats.alice,
        room_id,
        "s2",
        "@bob and you too",
        mentionUserIds=[chats.bob.id],
        mentionAgentIds=[namesake.id],
    )
    [message] = both.json()["messages"]
    assert message["namedAgentIds"] == [namesake.id]
    assert (room_id, message["seq"]) in await _events_of(chats, namesake)

    typed = (await chats.send(chats.alice, room_id, "s3", "@bob typed")).json()
    assert (room_id, typed["messages"][0]["seq"]) in await _events_of(chats, namesake)

    stranger = await chats.send(
        chats.alice, room_id, "s4", "@admin hi", mentionUserIds=[chats.admin.id]
    )
    assert stranger.status_code == 422
    assert _code(stranger) == "USER_NOT_IN_CHAT"


async def test_an_ordinary_member_leaves_without_managing(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    left = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.bob)
    )
    assert left.status_code == 204
    assert await _reads(chats, chats.bob, room_id) == 403


# ── Creating across processes ────────────────────────────────────────────────


def _second_process(chats: _Harness) -> ChatService:
    service, _ = _chat_service(
        chats.factory,
        lifecycle=chats.lifecycle,
        listener=_FakeListener(),
        activity=_FakeActivityListener(),
        connections=AgentConnectionRegistry(),
    )
    return service


async def test_one_create_on_two_processes_makes_one_room(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    other = _second_process(chats)
    both_looked = asyncio.Barrier(2)
    for service in (chats.service, other):
        look = service._room_of_operation

        async def look_then_wait(
            session: AsyncSession, operation_id: str, look=look
        ) -> Room | None:
            found = await look(session, operation_id)
            if found is None:
                await both_looked.wait()
            return found

        monkeypatch.setattr(service, "_room_of_operation", look_then_wait)

    def create(service: ChatService) -> Any:
        return service.create_chat(
            "00000000-0000-0000-0000-000000000000",
            chats.alice,
            agent_ids=[agent.id],
            member_user_ids=[chats.bob.id],
            kind=None,
            name=None,
            request_id="c1",
            greeting=None,
        )

    first, second = await asyncio.gather(create(chats.service), create(other))
    assert first.id == second.id
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 1
    assert await _reads(chats, chats.bob, first.id) == 200


async def test_a_create_cut_off_before_its_people_joined_finishes_on_retry(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    join = chats.service._join
    async with chats.factory() as session:
        bob_client = await chats.service.member_client(session, chats.bob.id)
    assert bob_client is None

    async def join_but_not_bob(tenant_id: str, room: Room, client: Client) -> None:
        if client.user_id == chats.bob.id:
            raise RuntimeError("cut off")
        await join(tenant_id, room, client)

    monkeypatch.setattr(chats.service, "_join", join_but_not_bob)
    body = {"agentId": agent.id, "memberUserIds": [chats.bob.id], "requestId": "c1"}
    with pytest.raises(RuntimeError, match="cut off"):
        await chats.client.post("/chats", json=body, headers=chats.as_user(chats.alice))
    monkeypatch.setattr(chats.service, "_join", join)

    retried = await chats.client.post(
        "/chats", json=body, headers=chats.as_user(chats.alice)
    )
    assert retried.status_code == 200, retried.text
    room_id = retried.json()["chat"]["roomId"]
    assert sorted(retried.json()["chat"]["memberUserIds"]) == sorted(
        [chats.alice.id, chats.bob.id]
    )
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 1
    assert await _reads(chats, chats.bob, room_id) == 200


async def test_a_chat_noticed_late_is_followed_from_the_join(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    events = _stream(chats, chats.bob, {}, recheck=0.2)
    assert (await events.next())[0] == "ready"

    # The membership signal is lost; only the periodic recheck finds the room.
    monkeypatch.setattr(chats.service, "_memberships_changed", lambda *_: None)
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    for index in range(3):
        sent = await chats.send(chats.alice, room_id, f"s{index}", f"m{index}")
        assert sent.status_code == 200

    name, summary = await events.next()
    assert (name, summary["roomId"]) == ("chat", room_id)
    bodies = [(await events.next())[1]["body"] for _ in range(3)]
    assert bodies == ["m0", "m1", "m2"]
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_a_reconnect_cursor_still_decides_where_a_chat_resumes(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    first = (await chats.send(chats.alice, room_id, "s1", "seen")).json()
    await chats.send(chats.alice, room_id, "s2", "new")

    events = _stream(chats, chats.alice, {room_id: first["messages"][0]["seq"]}, 60.0)
    name, data = await events.next()
    assert (name, data["body"]) == ("message", "new")
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_a_change_to_one_chat_re_summarises_only_that_chat(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_ids = []
    for index in range(20):
        created = await chats.client.post(
            "/chats",
            json={
                "agentIds": [],
                "memberUserIds": [chats.bob.id, chats.admin.id],
                "requestId": f"c{index}",
            },
            headers=chats.as_user(chats.alice),
        )
        room_ids.append(created.json()["chat"]["roomId"])
    streams = [
        _stream(chats, user, {}, recheck=60.0) for user in (chats.bob, chats.admin)
    ]
    for events in streams:
        assert await events.until("ready") == {}

    summaries: list[str] = []
    summarise = chats_module.chat_summaries

    async def counted(session: AsyncSession, rooms: list[Room], **kwargs: Any) -> Any:
        summaries.extend(room.id for room in rooms)
        return await summarise(session, rooms, **kwargs)

    monkeypatch.setattr(chats_module, "chat_summaries", counted)
    added = await _add_agent(chats, chats.alice.id, room_ids[0], agent)
    assert added.status_code == 200
    for events in streams:
        name, summary = await events.next()
        assert (name, summary["roomId"]) == ("chat", room_ids[0])
        await events.stream.aclose()  # type: ignore[attr-defined]
    # The add answers with one summary; each of the two streams sends one.
    assert summaries == [room_ids[0]] * 3


async def test_group_only_requests_are_refused_while_group_chats_is_off(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    chats.service.group_chats_enabled = False

    refusals = [
        await chats.client.post(
            "/chats",
            json={
                "agentId": agent.id,
                "memberUserIds": [chats.bob.id],
                "requestId": "g1",
            },
            headers=chats.as_user(chats.alice),
        ),
        await chats.client.post(
            "/chats",
            json={"agentIds": [], "requestId": "g2"},
            headers=chats.as_user(chats.alice),
        ),
        await _add_agent(chats, chats.alice.id, room_id, other),
        await chats.client.delete(
            f"/chats/{room_id}/agents/{agent.id}", headers=chats.as_user(chats.alice)
        ),
        await chats.send(
            chats.alice, room_id, "s1", "@alice", mentionUserIds=[chats.alice.id]
        ),
        await _candidates(chats, chats.alice, room_id),
    ]
    assert [(r.status_code, _code(r)) for r in refusals] == [
        (409, "GROUP_CHATS_OFF")
    ] * len(refusals)
    # What was there before group chats still works.
    assert (await chats.send(chats.alice, room_id, "s2", "hi")).status_code == 200
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    chats.service.group_chats_enabled = True
    assert (await _add_agent(chats, chats.alice.id, room_id, other)).status_code == 200


def _utf16(text: str) -> bytes:
    return text.encode("utf-16-le")


def _at(body: str, span: dict[str, Any]) -> str:
    units = _utf16(body)
    return units[span["offset"] * 2 : (span["offset"] + span["length"]) * 2].decode(
        "utf-16-le"
    )


async def test_mention_spans_place_people_and_agents_in_the_body(
    chats: _Harness,
) -> None:
    namesake = await chats.agent("bob", owner=chats.alice)
    helper = await chats.agent("helper", owner=chats.alice)
    created = await chats.client.post(
        "/chats",
        json={
            "agentIds": [namesake.id, helper.id],
            "memberUserIds": [chats.bob.id],
            "requestId": "c1",
        },
        headers=chats.as_user(chats.alice),
    )
    room_id = created.json()["chat"]["roomId"]

    # An emoji (two UTF-16 units) before a person's mention of the agent's name.
    person = {"kind": "user", "id": chats.bob.id, "offset": 3, "length": 4}
    sent = await chats.send(
        chats.alice, room_id, "s1", "😀 @bob look", mentionSpans=[person]
    )
    assert sent.status_code == 200, sent.text
    [message] = sent.json()["messages"]
    assert message["mentions"] == [person]
    assert message["namedUserIds"] == [chats.bob.id]
    assert _at(message["body"], message["mentions"][0]) == "@bob"
    assert (room_id, message["seq"]) not in await _events_of(chats, namesake)

    # An agent the body does not name is put first; the spans move with it.
    prefixed = await chats.send(
        chats.alice,
        room_id,
        "s2",
        "@bob see",
        mentionAgentIds=[helper.id],
        mentionSpans=[{"kind": "user", "id": chats.bob.id, "offset": 0, "length": 4}],
    )
    [message] = prefixed.json()["messages"]
    assert message["body"] == "@helper @bob see"
    assert [_at(message["body"], span) for span in message["mentions"]] == ["@bob"]
    assert (room_id, message["seq"]) in await _events_of(chats, helper)
    assert (room_id, message["seq"]) not in await _events_of(chats, namesake)

    agent_span = {"kind": "agent", "id": namesake.id, "offset": 0, "length": 4}
    for_agent = await chats.send(
        chats.alice, room_id, "s3", "@bob go", mentionSpans=[agent_span]
    )
    [message] = for_agent.json()["messages"]
    assert (room_id, message["seq"]) in await _events_of(chats, namesake)

    for index, (body, spans) in enumerate(
        [
            ("😀 @bob", [{**person, "offset": 1, "length": 3}]),
            ("@bob", [{**person, "offset": 0, "length": 9}]),
            ("hey bob", [{**person, "offset": 4, "length": 3}]),
            ("@bob", [person | {"offset": 0}, agent_span]),
        ]
    ):
        refused = await chats.send(
            chats.alice, room_id, f"bad{index}", body, mentionSpans=spans
        )
        assert refused.status_code == 422, body
        assert _code(refused) == "INVALID_MENTION"
    stranger = await chats.send(
        chats.alice,
        room_id,
        "bad-member",
        "@admin",
        mentionSpans=[{"kind": "user", "id": chats.admin.id, "offset": 0, "length": 6}],
    )
    assert _code(stranger) == "USER_NOT_IN_CHAT"


async def test_one_request_id_with_two_payloads_on_two_processes_is_one_request(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    other = _second_process(chats)
    both_read = asyncio.Barrier(2)
    for service in (chats.service, other):
        read = service._operation

        async def read_then_wait(
            session: AsyncSession, user_id: str, request_id: str, read: Any = read
        ) -> Any:
            found = await read(session, user_id, request_id)
            # Both read "no operation" before either claims it.
            if found is None:
                await both_read.wait()
            return found

        monkeypatch.setattr(service, "_operation", read_then_wait)

    async def create(service: ChatService, member: User) -> Any:
        try:
            return await service.create_chat(
                "00000000-0000-0000-0000-000000000000",
                chats.alice,
                agent_ids=[agent.id],
                member_user_ids=[member.id],
                kind=None,
                name=None,
                request_id="c1",
                greeting=None,
            )
        except ChatError as refused:
            return refused

    outcomes = await asyncio.gather(
        create(chats.service, chats.bob), create(other, chats.admin)
    )
    rooms = [each for each in outcomes if isinstance(each, Room)]
    refusals = [each for each in outcomes if isinstance(each, ChatError)]
    assert len(rooms) == 1 and len(refusals) == 1
    assert refusals[0].code == "REQUEST_REUSED"
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 1
    members = await chats.client.get(
        f"/chats/{rooms[0].id}/members", headers=chats.as_user(chats.alice)
    )
    assert len({m["userId"] for m in members.json()["members"]}) == 2


# ── Room change notices ──────────────────────────────────────────────────────


class _Published:
    def __init__(self) -> None:
        self.notices: list[tuple[str, str, str]] = []

    def publish(self, tenant_id: str, user_id: str, kind: str, id: str) -> None:
        self.notices.append((user_id, kind, id))


async def test_people_are_told_when_a_room_of_theirs_changes(chats: _Harness) -> None:
    published = _Published()
    changes = RoomChanges(
        session_factory=chats.factory, publisher=published, window_seconds=0.0
    )
    chats.room_service.on_room_changed(changes.room_changed)
    chats.service._provisioning.on_membership_changed(changes.room_changed)  # type: ignore[attr-defined]

    async def told() -> set[str]:
        await asyncio.gather(*changes._tasks)
        users = {user_id for user_id, kind, _ in published.notices if kind == ROOM}
        published.notices.clear()
        return users

    mine = await chats.agent("mine", owner=chats.alice)
    admins = await chats.agent("admins", owner=chats.admin)
    room_id = await chats.new_chat(chats.alice, mine, "c1")
    assert await told() == {chats.alice.id}

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert await told() == {chats.alice.id, chats.bob.id}

    assert (await _add_agent(chats, chats.alice.id, room_id, admins)).status_code == 200
    assert chats.admin.id in await told()

    removed = await chats.client.delete(
        f"/chats/{room_id}/agents/{admins.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert chats.admin.id in await told()

    left = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.bob)
    )
    assert left.status_code == 204
    assert chats.bob.id in await told()

    archived = await chats.client.post(
        f"/chats/{room_id}/archive", headers=chats.as_user(chats.alice)
    )
    assert archived.status_code == 204
    assert await told() == {chats.alice.id}


async def test_changes_to_a_room_within_a_window_make_one_read_and_one_notice_each(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    published = _Published()
    changes = RoomChanges(
        session_factory=chats.factory, publisher=published, window_seconds=0.2
    )
    mine = await chats.agent("mine", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, mine, "c1")
    reads: list[list[str]] = []

    async def counted(
        session: AsyncSession, changed: dict[str, list[str]]
    ) -> dict[str, list[str]]:
        reads.append(changed[room_id])
        return await people_concerned(session, changed)

    monkeypatch.setattr(room_changes_module, "people_concerned", counted)

    changes.rooms_changed(TENANT, [room_id])
    for _ in range(5):
        changes.room_changed(TENANT, room_id, [])
    # The last change in the window names a client that just left.
    left = str(uuid.uuid4())
    changes.room_changed(TENANT, room_id, [left])
    await asyncio.gather(*changes._tasks)
    assert reads == [[left]]
    assert published.notices == [(chats.alice.id, ROOM, room_id)]

    # A change after the window closed opens a window of its own.
    published.notices.clear()
    changes.room_changed(TENANT, room_id, [])
    await asyncio.gather(*changes._tasks)
    assert len(reads) == 2 and published.notices == [(chats.alice.id, ROOM, room_id)]


async def test_renaming_an_agent_tells_everyone_who_sees_its_rooms(
    chats: _Harness,
) -> None:
    published = _Published()
    changes = RoomChanges(
        session_factory=chats.factory, publisher=published, window_seconds=0.0
    )
    chats.service.on_agent_room_changed(changes.rooms_changed)
    agent = await chats.agent("renamed", owner=chats.admin)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert await events.until("ready") == {}

    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.display_name = "QA Blair"
        await session.commit()
    await chats.service.agent_changed("00000000-0000-0000-0000-000000000000", agent.id)
    await asyncio.gather(*changes._tasks)
    assert {(user, kind, id) for user, kind, id in published.notices} == {
        (user, ROOM, room_id) for user in (chats.alice.id, chats.bob.id, chats.admin.id)
    }
    name, summary = await events.next()
    assert (name, summary["roomId"]) == ("chat", room_id)
    assert summary["agents"][0]["displayName"] == "QA Blair"
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_renaming_an_agent_in_many_rooms_reads_them_in_one_query(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    published = _Published()
    changes = RoomChanges(
        session_factory=chats.factory, publisher=published, window_seconds=0.0
    )
    chats.service.on_agent_room_changed(changes.rooms_changed)
    agent = await chats.agent("busy", owner=chats.admin)
    rooms = [await chats.new_chat(chats.alice, agent, f"c{n}") for n in range(6)]
    assert (await chats.invite(chats.alice, rooms[0], chats.bob)).status_code == 200
    reads: list[list[str]] = []

    async def counted(
        session: AsyncSession, changed: dict[str, list[str]]
    ) -> dict[str, list[str]]:
        reads.append(sorted(changed))
        return await people_concerned(session, changed)

    monkeypatch.setattr(room_changes_module, "people_concerned", counted)

    await chats.service.agent_changed(TENANT, agent.id)
    assert len(changes._tasks) == 1
    await asyncio.gather(*changes._tasks)
    assert reads == [sorted(rooms)]
    expected = {
        (user, ROOM, r) for r in rooms for user in (chats.alice.id, chats.admin.id)
    }
    expected.add((chats.bob.id, ROOM, rooms[0]))
    assert set(published.notices) == expected


async def test_only_a_manager_renames_a_group_and_everyone_sees_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def detail(_session: AsyncSession, room: Room, *_args: Any) -> str:
        return room.name

    monkeypatch.setattr(rooms_module, "_build_room_detail", detail)
    chats.room_service.on_room_changed(chats.service.room_changed)
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "memberUserIds": [chats.bob.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    room_id = created.json()["chat"]["roomId"]
    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert await events.until("ready") == {}

    async def rename(user: User, name: str) -> Any:
        async with chats.factory() as session:
            return await rooms_module.patch_room(
                room_id,
                RoomUpdateRequest(name=name),
                session,
                chats.room_service,
                RoomStore(),
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                user,
                False,
            )

    with pytest.raises(HTTPException) as refused:
        await rename(chats.bob, "Bob's name")
    assert refused.value.status_code == 403
    for bad in ("   ", "x" * 201):
        with pytest.raises(HTTPException) as invalid:
            await rename(chats.alice, bad)
        assert invalid.value.status_code == 400

    assert await rename(chats.alice, "  Launch crew  ") == "Launch crew"
    name, summary = await events.next()
    assert (name, summary["roomId"], summary["name"]) == (
        "chat",
        room_id,
        "Launch crew",
    )
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_two_processes_creating_one_persons_identity_share_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = _second_process(chats)
    both_looked = asyncio.Barrier(2)
    for service in (chats.service, other):
        look = service.member_client

        async def look_then_wait(
            session: AsyncSession, user_id: str, look: Any = look
        ) -> Client | None:
            found = await look(session, user_id)
            # Both find none before either creates it.
            if found is None:
                await both_looked.wait()
            return found

        monkeypatch.setattr(service, "member_client", look_then_wait)

    tenant = "00000000-0000-0000-0000-000000000000"
    first, second = await asyncio.gather(
        chats.service.member_actor(tenant, chats.bob),
        other.member_actor(tenant, chats.bob),
    )
    assert first.id == second.id
