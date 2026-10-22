"""`/chats`: membership as the only read authority, retryable creates and
sends, and the live event stream — against real Postgres.

The routes run behind a real `ChatService`, `RoomService` and Postgres
provisioning. Only the running-client registry is faked (no agent consumer
runs here) and the message listener, whose wake-ups the stream tests ring by
hand so a missed notification can be staged. The stream tests across
processes add a second chat service on the same database, each process with
its own signal bus on the real `NOTIFY` channel.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import delete, func, select, update

from switch_core.addressing import owner_only_policy
from switch_core.db.models import (
    Agent,
    AgentEventRow,
    AgentSessionActivityItem,
    ApprovalRequest,
    ChatOperation,
    ChatOwnerGrant,
    Client,
    ClientRoom,
    CollaborationBridge,
    Message,
    Room,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import chats as chats_module
from switch_core.gateway.chats import (
    chat_activity_events,
    chat_events,
)
from switch_core.session_activity.listener import Change
from tests.switch_core.gateway.conftest import _Harness, _Process


def _code(response: httpx.Response) -> str:
    return str(response.json()["detail"]["code"])


# ── Access ───────────────────────────────────────────────────────────────────


async def test_public_room_is_not_readable_without_membership(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    async with chats.factory() as session:
        room = Room(
            transport_room_id="!public:test",
            name="public",
            description="",
            owner_id=chats.alice.id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.flush()
        await session.execute(
            room_agents.insert().values(room_id=room.id, agent_id=agent.id)
        )
        await session.commit()

    response = await chats.client.get(
        f"/chats/{room.id}/messages", headers=chats.as_user(chats.bob)
    )
    assert response.status_code == 403
    assert _code(response) == "NOT_A_MEMBER"

    sent = await chats.send(chats.bob, room.id, "r1", "hello")
    assert sent.status_code == 403
    assert await chats.message_rows(room.id) == []

    missing = await chats.client.get(
        "/chats/no-such-room/messages", headers=chats.as_user(chats.bob)
    )
    assert missing.status_code == 404


async def test_a_member_who_does_not_manage_cannot_join_or_invite(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    self_join = await chats.invite(chats.bob, room_id, chats.bob)
    assert self_join.status_code == 403
    assert _code(self_join) == "NOT_A_MANAGER"

    read = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.bob)
    )
    assert read.status_code == 403


async def test_a_manager_invites_tenant_members_and_may_join_themselves(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    invited = await chats.invite(chats.alice, room_id, chats.bob)
    assert invited.status_code == 200, invited.text
    assert {m["userId"] for m in invited.json()["members"]} == {
        chats.alice.id,
        chats.bob.id,
    }
    read = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.bob)
    )
    assert read.status_code == 200

    outsider = await chats.invite(chats.alice, room_id, chats.carol)
    assert outsider.status_code == 422
    assert _code(outsider) == "NOT_A_TENANT_MEMBER"

    # A tenant admin manages every room, so may add themselves to this one.
    joined = await chats.invite(chats.admin, room_id, chats.admin)
    assert joined.status_code == 200
    members = await chats.client.get(
        f"/chats/{room_id}/members", headers=chats.as_user(chats.admin)
    )
    assert [m for m in members.json()["members"] if m["isOwner"]] == [
        {"userId": chats.alice.id, "name": "alice", "isOwner": True}
    ]


async def test_losing_the_tenant_role_revokes_access(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    async with chats.factory() as session:
        await session.execute(
            delete(TenantMember).where(TenantMember.user_id == chats.bob.id)
        )
        await session.commit()

    read = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.bob)
    )
    assert read.status_code == 403
    listed = await chats.client.get("/chats", headers=chats.as_user(chats.bob))
    assert listed.json() == {"chats": []}


async def test_removing_a_member_and_leaving(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert (await chats.invite(chats.alice, room_id, chats.admin)).status_code == 200

    refused = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.admin.id}", headers=chats.as_user(chats.bob)
    )
    assert refused.status_code == 403

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    read = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.bob)
    )
    assert read.status_code == 403

    left = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.admin.id}", headers=chats.as_user(chats.admin)
    )
    assert left.status_code == 204
    members = await chats.client.get(
        f"/chats/{room_id}/members", headers=chats.as_user(chats.alice)
    )
    assert [m["userId"] for m in members.json()["members"]] == [chats.alice.id]


# ── Creating a chat ──────────────────────────────────────────────────────────


async def test_a_new_chat_is_a_private_direct_room_owned_by_its_creator(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    response = await chats.create_chat(chats.alice, agent, "c1")
    assert response.status_code == 200, response.text
    chat = response.json()["chat"]
    assert chat["channelType"] == "direct"
    assert chat["bridgeType"] is None
    assert chat["canManage"] is True
    assert [a["id"] for a in chat["agents"]] == [agent.id]
    assert chat["lastMessage"] is None

    async with chats.factory() as session:
        room = await session.get(Room, chat["roomId"])
        assert room is not None
        assert room.bridge_id is None
        assert room.read_visibility == "private"
        assert room.write_visibility == "private"
        assert room.owner_id == chats.alice.id
        assert room.created_by == chats.alice.id
        members = set(
            (
                await session.execute(
                    select(ClientRoom.client_id).where(ClientRoom.room_id == room.id)
                )
            ).scalars()
        )
        member = await chats.service.member_client(session, chats.alice.id)
        assert member is not None
        assert {member.id, agent.client_id} <= members

    listed = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    assert [c["roomId"] for c in listed.json()["chats"]] == [chat["roomId"]]


async def test_a_registered_agent_reports_its_provider(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.metadata_ = {"known_agent_type": "claude-code"}
        await session.commit()
    other = await chats.agent("plain", owner=chats.alice)

    first = await chats.create_chat(chats.alice, agent, "c1")
    second = await chats.create_chat(chats.alice, other, "c2")
    assert first.json()["chat"]["agents"][0]["provider"] == "claude"
    assert second.json()["chat"]["agents"][0]["provider"] is None


async def test_an_owner_only_agent_refuses_a_chat_from_anyone_else(
    chats: _Harness,
) -> None:
    agent = await chats.agent(
        "private", owner=chats.alice, policy=owner_only_policy([]).model_dump()
    )
    refused = await chats.create_chat(chats.bob, agent, "c1")
    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 0

    allowed = await chats.create_chat(chats.alice, agent, "c1")
    assert allowed.status_code == 200


async def test_creating_twice_with_one_request_id_creates_one_chat(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    first = await chats.new_chat(chats.alice, agent, "c1")
    second = await chats.new_chat(chats.alice, agent, "c1")
    assert first == second

    reused = await chats.create_chat(chats.alice, other, "c1")
    assert reused.status_code == 409
    assert _code(reused) == "REQUEST_REUSED"
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 1


async def test_several_agents_make_a_private_channel_with_all_of_them(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    response = await chats.client.post(
        "/chats",
        json={"agentIds": [helper.id, other.id, helper.id], "requestId": "c1"},
        headers=chats.as_user(chats.alice),
    )
    assert response.status_code == 200, response.text
    chat = response.json()["chat"]
    assert chat["channelType"] == "channel_private"
    assert chat["bridgeType"] is None
    assert sorted(a["id"] for a in chat["agents"]) == sorted([helper.id, other.id])
    assert chat["name"] == "New Chat"

    async with chats.factory() as session:
        clients = set(await RoomStore().get_client_ids(session, chat["roomId"]))
        member = await chats.service.member_client(session, chats.alice.id)
        assert member is not None
        assert {member.id, helper.client_id, other.client_id} <= clients

    sent = await chats.send(
        chats.alice, chat["roomId"], "s1", "your turn", mentionAgentId=other.id
    )
    assert sent.json()["messages"][0]["body"] == "@other your turn"


async def test_a_chat_with_several_agents_needs_every_one_allowed(
    chats: _Harness,
) -> None:
    open_agent = await chats.agent("helper", owner=chats.alice)
    private = await chats.agent(
        "private", owner=chats.alice, policy=owner_only_policy([]).model_dump()
    )
    refused = await chats.client.post(
        "/chats",
        json={"agentIds": [open_agent.id, private.id], "requestId": "c1"},
        headers=chats.as_user(chats.bob),
    )
    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 0


async def test_the_agents_are_part_of_a_create_request(chats: _Harness) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)

    def create(agent_ids: list[str]) -> Any:
        return chats.client.post(
            "/chats",
            json={"agentIds": agent_ids, "requestId": "c1"},
            headers=chats.as_user(chats.alice),
        )

    first = await create([helper.id, other.id])
    assert first.status_code == 200, first.text
    again = await create([helper.id, other.id])
    assert again.json()["chat"]["roomId"] == first.json()["chat"]["roomId"]
    changed = await create([helper.id])
    assert changed.status_code == 409
    assert _code(changed) == "REQUEST_REUSED"


async def test_a_create_names_its_agents_one_way(chats: _Harness) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    for body in (
        {"requestId": "c1"},
        {"requestId": "c2", "agentIds": []},
        {"requestId": "c3", "agentId": helper.id, "agentIds": [helper.id]},
    ):
        response = await chats.client.post(
            "/chats", json=body, headers=chats.as_user(chats.alice)
        )
        assert response.status_code == 422, body
        assert _code(response) == "AGENTS_REQUIRED"


async def test_a_create_that_stopped_after_the_room_committed_is_repaired(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)

    async def crash(*_args: object) -> None:
        raise RuntimeError("process died")

    with monkeypatch.context() as patch:
        patch.setattr(chats.room_service, "_invite_clients", crash)
        with pytest.raises(RuntimeError):
            await chats.create_chat(chats.alice, agent, "c1")

    async with chats.factory() as session:
        operation = await session.get(
            ChatOperation,
            ("00000000-0000-0000-0000-000000000000", chats.alice.id, "c1"),
        )
        assert operation is not None and operation.state == "pending"
        rooms = list((await session.execute(select(Room))).scalars())
        assert len(rooms) == 1
        assert await RoomStore().get_client_ids(session, rooms[0].id) == []

    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert room_id == rooms[0].id
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 1
        clients = set(await RoomStore().get_client_ids(session, room_id))
        assert agent.client_id in clients
        member = await chats.service.member_client(session, chats.alice.id)
        assert member is not None and member.id in clients


# ── Sending ──────────────────────────────────────────────────────────────────


async def test_a_sent_message_reads_back_as_the_console_member(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    sent = await chats.send(chats.alice, room_id, "s1", "hello **there**")
    assert sent.status_code == 200, sent.text
    [message] = sent.json()["messages"]
    assert message["source"] == "console"
    assert message["sender"]["kind"] == "human"
    assert message["sender"]["userId"] == chats.alice.id
    assert message["sender"]["name"] == "alice"
    assert message["clientTxn"] == "s1:0"
    assert message["format"] == "org.matrix.custom.html"
    assert message["threadRootId"] is None

    page = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    body = page.json()
    assert [m["messageId"] for m in body["messages"]] == [message["messageId"]]
    assert body["headSeq"] >= message["seq"]
    assert body["hasMore"] is False


async def test_a_sent_message_is_an_event_of_the_agent_in_the_chat(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    sent = await chats.send(chats.alice, room_id, "s1", "hello")
    assert sent.status_code == 200, sent.text
    [message] = sent.json()["messages"]

    assert (room_id, message["seq"]) in await _events_of(chats, agent)


async def test_a_plain_sent_message_carries_no_html(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    sent = await chats.send(chats.alice, room_id, "s1", "just a plain line\nand a < b")
    assert sent.status_code == 200, sent.text
    [message] = sent.json()["messages"]
    assert message["format"] is None
    assert message["body"] == "just a plain line\nand a < b"


async def test_paging_walks_back_by_seq(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    for i in range(3):
        assert (
            await chats.send(chats.alice, room_id, f"s{i}", f"m{i}")
        ).status_code == 200

    newest = await chats.client.get(
        f"/chats/{room_id}/messages?limit=2", headers=chats.as_user(chats.alice)
    )
    page = newest.json()
    assert [m["body"] for m in page["messages"]] == ["m1", "m2"]
    assert page["hasMore"] is True
    older = await chats.client.get(
        f"/chats/{room_id}/messages?limit=2&beforeSeq={page['messages'][0]['seq']}",
        headers=chats.as_user(chats.alice),
    )
    assert [m["body"] for m in older.json()["messages"]] == ["m0"]
    assert older.json()["hasMore"] is False


async def test_a_send_that_failed_before_commit_posts_once_on_retry(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    for upload_id in ("u1", "u2", "u3"):
        staged = await chats.upload(
            chats.alice, room_id, upload_id, b"png", f"{upload_id}.png"
        )
        assert staged.status_code == 200, staged.text

    original = MessageStore.create
    calls = 0

    async def fail_on_second(self: MessageStore, *args: Any, **kwargs: Any) -> Message:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("database went away")
        return await original(self, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(MessageStore, "create", fail_on_second)
        with pytest.raises(RuntimeError):
            await chats.send(
                chats.alice, room_id, "s1", "three files", uploadIds=["u1", "u2", "u3"]
            )
    assert await chats.message_rows(room_id) == []

    retried = await chats.send(
        chats.alice, room_id, "s1", "three files", uploadIds=["u1", "u2", "u3"]
    )
    assert retried.status_code == 200, retried.text
    parts = retried.json()["messages"]
    assert [p["clientTxn"] for p in parts] == ["s1:0", "s1:1", "s1:2"]
    assert parts[0]["body"] == "three files"
    assert [p["attachments"][0]["filename"] for p in parts] == [
        "u1.png",
        "u2.png",
        "u3.png",
    ]

    again = await chats.send(
        chats.alice, room_id, "s1", "three files", uploadIds=["u1", "u2", "u3"]
    )
    assert [p["messageId"] for p in again.json()["messages"]] == [
        p["messageId"] for p in parts
    ]
    rows = await chats.message_rows(room_id)
    assert len(rows) == 3
    groups = {row.content["com.switch.attachment_group"]["id"] for row in rows}
    assert len(groups) == 1


async def test_one_request_id_from_two_users_is_two_sends(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    from_alice = await chats.send(chats.alice, room_id, "same", "from alice")
    from_bob = await chats.send(chats.bob, room_id, "same", "from bob")
    assert from_alice.status_code == 200 and from_bob.status_code == 200
    assert [m.body for m in await chats.message_rows(room_id)] == [
        "from alice",
        "from bob",
    ]


async def test_reusing_a_request_id_for_another_room_is_refused(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    first = await chats.new_chat(chats.alice, agent, "c1")
    second = await chats.new_chat(chats.alice, agent, "c2")
    assert (await chats.send(chats.alice, first, "s1", "hi")).status_code == 200

    reused = await chats.send(chats.alice, second, "s1", "hi")
    assert reused.status_code == 409
    assert _code(reused) == "REQUEST_REUSED"
    assert await chats.message_rows(second) == []


async def test_concurrent_duplicate_sends_post_once(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    results = await asyncio.gather(
        *(chats.send(chats.alice, room_id, "s1", "only once") for _ in range(4))
    )
    assert {r.status_code for r in results} == {200}
    assert len({r.json()["messages"][0]["messageId"] for r in results}) == 1
    assert len(await chats.message_rows(room_id)) == 1


async def test_a_reply_goes_into_the_thread_of_its_root(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    root = (await chats.send(chats.alice, room_id, "s1", "root")).json()["messages"][0]

    reply = await chats.send(
        chats.alice, room_id, "s2", "reply", threadRootId=root["messageId"]
    )
    assert reply.json()["messages"][0]["threadRootId"] == root["messageId"]
    nested = await chats.send(
        chats.alice,
        room_id,
        "s3",
        "reply to reply",
        threadRootId=reply.json()["messages"][0]["messageId"],
    )
    assert nested.json()["messages"][0]["threadRootId"] == root["messageId"]
    [row] = [r for r in await chats.message_rows(room_id) if r.body == "reply to reply"]
    assert row.content["m.relates_to"] == {
        "rel_type": "m.thread",
        "event_id": root["messageId"],
    }

    unknown = await chats.send(chats.alice, room_id, "s4", "x", threadRootId="sw_nope")
    assert unknown.status_code == 422


async def test_mentioning_an_agent_prefixes_its_name_once(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    plain = await chats.send(
        chats.alice, room_id, "s1", "do it", mentionAgentId=agent.id
    )
    assert plain.json()["messages"][0]["body"] == "@helper do it"
    tagged = await chats.send(
        chats.alice, room_id, "s2", "ask @helper now", mentionAgentId=agent.id
    )
    assert tagged.json()["messages"][0]["body"] == "ask @helper now"


async def test_uploads_are_idempotent_and_media_is_scoped_to_the_room(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    other_room = await chats.new_chat(chats.alice, agent, "c2")

    staged = await chats.upload(chats.alice, room_id, "u1", b"bytes", "a.png")
    again = await chats.upload(chats.alice, room_id, "u1", b"bytes", "a.png")
    assert staged.json() == again.json()
    conflict = await chats.upload(chats.alice, room_id, "u1", b"other", "a.png")
    assert conflict.status_code == 409
    too_big = await chats.upload(chats.alice, room_id, "u2", b"x" * 2048, "b.png")
    assert too_big.status_code == 422

    uri = staged.json()["uri"]
    unsent = await chats.client.get(
        f"/chats/{room_id}/media",
        params={"uri": uri},
        headers=chats.as_user(chats.alice),
    )
    assert unsent.status_code == 404

    wrong_room = await chats.send(chats.alice, other_room, "s0", "", uploadIds=["u1"])
    assert wrong_room.status_code == 422
    sent = await chats.send(chats.alice, room_id, "s1", "", uploadIds=["u1"])
    [part] = sent.json()["messages"]
    assert part["attachments"] == [
        {
            "uri": uri,
            "filename": "a.png",
            "mimetype": "image/png",
            "size": 5,
            "msgtype": "m.image",
        }
    ]

    media = await chats.client.get(
        f"/chats/{room_id}/media",
        params={"uri": uri},
        headers=chats.as_user(chats.alice),
    )
    assert media.status_code == 200
    assert media.content == b"bytes"
    assert media.headers["content-type"] == "image/png"
    elsewhere = await chats.client.get(
        f"/chats/{other_room}/media",
        params={"uri": uri},
        headers=chats.as_user(chats.alice),
    )
    assert elsewhere.status_code == 404
    stranger = await chats.client.get(
        f"/chats/{room_id}/media", params={"uri": uri}, headers=chats.as_user(chats.bob)
    )
    assert stranger.status_code == 403


async def test_a_member_removed_after_a_failed_send_cannot_retry_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    async def fail(self: MessageStore, *args: Any, **kwargs: Any) -> Message:
        raise RuntimeError("database went away")

    with monkeypatch.context() as patch:
        patch.setattr(MessageStore, "create", fail)
        with pytest.raises(RuntimeError):
            await chats.send(chats.bob, room_id, "s1", "hi")

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    retried = await chats.send(chats.bob, room_id, "s1", "hi")
    assert retried.status_code == 403
    assert await chats.message_rows(room_id) == []


# ── Hiding and archiving ─────────────────────────────────────────────────────


async def test_a_hidden_chat_returns_when_something_new_is_said(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert (await chats.send(chats.alice, room_id, "s1", "before")).status_code == 200

    hidden = await chats.client.put(
        f"/chats/{room_id}/hidden", headers=chats.as_user(chats.alice)
    )
    assert hidden.status_code == 204
    listed = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    assert listed.json()["chats"] == []
    still_bobs = await chats.client.get("/chats", headers=chats.as_user(chats.bob))
    assert len(still_bobs.json()["chats"]) == 1

    assert (await chats.send(chats.bob, room_id, "s2", "news")).status_code == 200
    back = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    [chat] = back.json()["chats"]
    assert chat["lastMessage"]["preview"] == "news"
    assert chat["lastMessage"]["senderName"] == "bob"

    await chats.client.put(
        f"/chats/{room_id}/hidden", headers=chats.as_user(chats.alice)
    )
    shown = await chats.client.delete(
        f"/chats/{room_id}/hidden", headers=chats.as_user(chats.alice)
    )
    assert shown.status_code == 204
    again = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    assert len(again.json()["chats"]) == 1


async def test_only_a_manager_archives_a_chat(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    refused = await chats.client.post(
        f"/chats/{room_id}/archive", headers=chats.as_user(chats.bob)
    )
    assert refused.status_code == 403
    assert _code(refused) == "NOT_A_MANAGER"

    archived = await chats.client.post(
        f"/chats/{room_id}/archive", headers=chats.as_user(chats.alice)
    )
    assert archived.status_code == 204
    listed = await chats.client.get("/chats", headers=chats.as_user(chats.alice))
    assert listed.json()["chats"] == []


# ── Live updates ─────────────────────────────────────────────────────────────


class _Events:
    """Reads one stream's frames as `(event, data)` pairs, skipping pings."""

    def __init__(self, stream: AsyncIterator[bytes]) -> None:
        self.stream = stream

    async def next(self, timeout: float = 3.0) -> tuple[str, Any]:
        while True:
            frame = (await asyncio.wait_for(anext(self.stream), timeout)).decode()
            if frame.startswith(":"):
                continue
            event_line, data_line = frame.strip().split("\n")
            return event_line.removeprefix("event: "), json.loads(
                data_line.removeprefix("data: ")
            )

    async def until(self, event: str) -> Any:
        while True:
            name, data = await self.next()
            if name == event:
                return data


def _stream(
    chats: _Harness, user: User, after: dict[str, int], recheck: float
) -> _Events:
    return _Events(
        chat_events(
            chats.service,
            "00000000-0000-0000-0000-000000000000",
            user,
            after,
            ping_seconds=60.0,
            recheck_seconds=recheck,
        )
    )


async def test_the_stream_catches_up_then_says_ready_then_pushes(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    first = (await chats.send(chats.alice, room_id, "s1", "one")).json()["messages"][0]
    assert (await chats.send(chats.alice, room_id, "s2", "two")).status_code == 200

    second = await _read_back(chats, room_id, "two")

    events = _stream(chats, chats.alice, {room_id: first["seq"]}, recheck=60.0)
    assert await events.next() == ("message", second)
    assert (await events.next())[0] == "ready"

    assert (await chats.send(chats.alice, room_id, "s3", "three")).status_code == 200
    await chats.listener.ring(room_id)
    name, data = await events.next()
    assert name == "message" and data["body"] == "three"
    await events.stream.aclose()  # type: ignore[attr-defined]
    assert all(not wakers for wakers in chats.listener.wakers.values())


async def _read_back(chats: _Harness, room_id: str, body: str) -> dict[str, Any]:
    page = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    [message] = [m for m in page.json()["messages"] if m["body"] == body]
    return message  # type: ignore[no-any-return]


async def test_the_stream_announces_new_chats_and_removals(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    events = _stream(chats, chats.bob, {"gone-room": 3}, recheck=60.0)
    assert await events.next() == (
        "chat.removed",
        {"roomId": "gone-room", "reason": "access"},
    )
    assert (await events.next())[0] == "ready"

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )

    # Nothing more about the room reaches someone no longer in it.
    assert (await chats.send(chats.alice, room_id, "s1", "secret")).status_code == 200
    await chats.listener.ring(room_id)
    with pytest.raises(TimeoutError):
        await events.next(timeout=0.3)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_stream_ends_when_the_tenant_role_is_gone(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    async with chats.factory() as session:
        await session.execute(
            delete(TenantMember).where(TenantMember.user_id == chats.bob.id)
        )
        await session.commit()
    await chats.listener.ring(room_id)
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )
    with pytest.raises(StopAsyncIteration):
        await anext(events.stream)


async def test_an_invited_member_keeps_a_chat_that_loses_its_last_agent(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    room_id = await _room(chats, [agent], owner=chats.alice)
    assert room_id not in await _listed(chats, chats.bob)
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=0.2)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    await chats.room_service.remove_agents_from_room(room_id, [agent.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "unlisted"},
    )
    assert await _reads(chats, chats.bob, room_id) == 200
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_unlisted_room_still_delivers_messages_to_invited_member(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    await chats.room_service.remove_agents_from_room(room_id, [agent.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "unlisted"},
    )

    assert (
        await chats.send(chats.alice, room_id, "s1", "hello after unlisted")
    ).status_code == 200
    await chats.listener.ring(room_id)
    name, data = await events.next()
    assert name == "message" and data["body"] == "hello after unlisted"
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_unlisted_then_revoked_room_emits_access_removal(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    await chats.room_service.remove_agents_from_room(room_id, [agent.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "unlisted"},
    )

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )

    assert (await chats.send(chats.alice, room_id, "s1", "secret")).status_code == 200
    await chats.listener.ring(room_id)
    with pytest.raises(TimeoutError):
        await events.next(timeout=0.3)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_an_unlisted_chat_is_announced_again_when_an_agent_returns(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    await chats.room_service.remove_agents_from_room(room_id, [agent.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "unlisted"},
    )

    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    assert room_id in await _listed(chats, chats.bob)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_periodic_recheck_announces_a_chat_that_regains_an_agent(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    async with chats.factory() as session:
        await session.execute(
            delete(room_agents).where(room_agents.c.room_id == room_id)
        )
        await session.commit()

    events = _stream(chats, chats.bob, {room_id: 0}, recheck=0.2)
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "unlisted"},
    )
    assert (await events.next())[0] == "ready"

    # Written straight to the table: no hook runs and no signal is sent, as
    # when another process's signal is missed.
    async with chats.factory() as session:
        await session.execute(
            room_agents.insert().values(room_id=room_id, agent_id=agent.id)
        )
        await session.commit()
    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_an_owner_only_member_loses_access_with_the_last_agent(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.bob)
    room_id = await _left_chat(chats, chats.bob)
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    assert room_id in await _listed(chats, chats.bob)

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    await chats.room_service.remove_agents_from_room(room_id, [agent.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )
    assert await _reads(chats, chats.bob, room_id) == 403
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_archiving_a_chat_removes_it_for_access(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=0.2)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    archived = await chats.client.post(
        f"/chats/{room_id}/archive", headers=chats.as_user(chats.alice)
    )
    assert archived.status_code == 204
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_periodic_recheck_recovers_a_missed_notification(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    events = _stream(chats, chats.alice, {room_id: 0}, recheck=0.2)
    assert (await events.next())[0] == "ready"

    # Written without ringing the listener: the notification never arrives.
    assert (
        await chats.send(chats.alice, room_id, "s1", "unannounced")
    ).status_code == 200
    name, data = await events.next()
    assert name == "message" and data["body"] == "unannounced"
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_a_changed_agent_resends_the_chats_it_is_in(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _stream(chats, chats.bob, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    async with chats.factory() as session:
        await AgentStore().update(
            session,
            agent.id,
            icon_url="https://example.com/new.png",
            display_name="Helper",
        )
        await session.commit()
    await chats.service.agent_changed(TENANT, agent.id)

    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    assert summary["agents"][0]["iconUrl"] == "https://example.com/new.png"
    assert summary["agents"][0]["displayName"] == "Helper"
    await events.stream.aclose()  # type: ignore[attr-defined]


def _stream_on(process: _Process, user: User) -> _Events:
    """A stream held by `process` that re-reads on its own only after an hour,
    so whatever it says before then, something woke it to say."""
    return _Events(
        chat_events(
            process.service,
            TENANT,
            user,
            {},
            ping_seconds=60.0,
            recheck_seconds=3600.0,
        )
    )


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(10.0):
        while not check():
            await asyncio.sleep(0.02)


async def _join_unannounced(chats: _Harness, user: User, room_id: str) -> None:
    """Put the user in the room without waking any stream or sending any
    signal, as a change whose signal was lost."""
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
    await chats.service._join(
        TENANT, room, await chats.service.member_actor(TENANT, user)
    )


async def test_a_change_through_another_process_reaches_the_stream_at_once(
    chats: _Harness, two_processes: tuple[_Process, _Process]
) -> None:
    """Bob's Console streams from one process while Alice invites him through
    the other: his stream announces the chat at once, not at its re-read."""
    _, there = two_processes
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    events = _stream_on(there, chats.bob)
    assert (await events.next())[0] == "ready"

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_every_stream_re_reads_when_its_signal_connection_comes_back(
    chats: _Harness, two_processes: tuple[_Process, _Process]
) -> None:
    """A signal sent while a process's signal connection is down never reaches
    it, so once the connection is back every stream it holds re-reads."""
    _, there = two_processes
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    events = _stream_on(there, chats.bob)
    assert (await events.next())[0] == "ready"

    await there.bus.stop()
    await _join_unannounced(chats, chats.bob, room_id)
    await there.bus.start()

    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_a_change_concerning_more_people_than_one_signal_holds_reaches_them_all(
    two_processes: tuple[_Process, _Process],
) -> None:
    """The people a change concerns are split over as many signals as it takes
    to stay under the `NOTIFY` limit, and each one's streams are woken."""
    here, there = two_processes
    user_ids = [str(uuid.uuid4()) for _ in range(500)]
    woken: list[str] = []
    for user_id in user_ids:
        there.service.watch_memberships(
            TENANT, user_id, lambda user_id=user_id: woken.append(user_id)
        )

    here.signals.memberships_changed(TENANT, user_ids)

    await _eventually(lambda: len(woken) == len(user_ids))
    assert sorted(woken) == sorted(user_ids)


# ── Agent owners ─────────────────────────────────────────────────────────────

TENANT = "00000000-0000-0000-0000-000000000000"


async def _room(
    chats: _Harness,
    agents: list[Agent],
    *,
    name: str = "room",
    owner: User | None = None,
    bridge: str | None = None,
    channel_type: str = "channel_public",
    archived: bool = False,
) -> str:
    """A room someone else set up, holding `agents`, with no member clients."""
    async with chats.factory() as session:
        bridge_id: str | None = None
        if bridge is not None:
            bridge_client = Client(
                transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.test",
                display_name="bridge",
                type="bridge",
            )
            session.add(bridge_client)
            await session.flush()
            row = CollaborationBridge(
                type=bridge,
                display_name="Acme",
                client_id=bridge_client.id,
                status="active",
            )
            session.add(row)
            await session.flush()
            bridge_id = row.id
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name=f"Acme: {name}" if bridge is not None else name,
            description="",
            owner_id=(owner or chats.bob).id,
            read_visibility="private",
            write_visibility="private",
            bridge_id=bridge_id,
            external_channel_id=f"C{uuid.uuid4().hex[:6]}" if bridge else None,
            channel_type=channel_type,
            archived_at=datetime.now(UTC) if archived else None,
        )
        session.add(room)
        await session.flush()
        for agent in agents:
            await session.execute(
                room_agents.insert().values(room_id=room.id, agent_id=agent.id)
            )
        await session.commit()
        return room.id


async def _listed(chats: _Harness, user: User) -> dict[str, dict[str, Any]]:
    response = await chats.client.get("/chats", headers=chats.as_user(user))
    assert response.status_code == 200, response.text
    return {chat["roomId"]: chat for chat in response.json()["chats"]}


async def _reads(chats: _Harness, user: User, room_id: str) -> int:
    response = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(user)
    )
    return response.status_code


async def _left_chat(chats: _Harness, user: User) -> str:
    """A chat `user` started with someone else's agent, then left."""
    guest = await chats.agent(f"guest-{uuid.uuid4().hex[:8]}", owner=chats.admin)
    room_id = await chats.new_chat(user, guest, uuid.uuid4().hex)
    left = await chats.client.delete(
        f"/chats/{room_id}/members/{user.id}", headers=chats.as_user(user)
    )
    assert left.status_code == 204, left.text
    return room_id


async def _grants(chats: _Harness) -> int:
    async with chats.factory() as session:
        return int(
            await session.scalar(select(func.count()).select_from(ChatOwnerGrant)) or 0
        )


async def test_an_agent_owner_is_not_joined_to_bridged_rooms_holding_their_agent(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    channel = await _room(chats, [agent], name="general", bridge="slack")
    dm = await _room(chats, [agent], name="dm", bridge="discord", channel_type="direct")

    assert await _reads(chats, chats.alice, channel) == 403
    assert await _reads(chats, chats.alice, dm) == 403
    assert await _listed(chats, chats.alice) == {}
    await chats.room_service.room_agents_changed(TENANT, channel)
    assert await _listed(chats, chats.alice) == {}
    assert await _grants(chats) == 0


async def _grant_as_before(chats: _Harness, user: User, room_id: str) -> None:
    """An owner membership made by the earlier, wider rule."""
    client = await chats.service.member_actor(TENANT, user)
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        session.add(ChatOwnerGrant(tenant_id=TENANT, user_id=user.id, room_id=room_id))
        await session.commit()
    await chats.service._join(TENANT, room, client)


async def _in_room(chats: _Harness, user: User, room_id: str) -> bool:
    async with chats.factory() as session:
        client = await chats.service.member_client(session, user.id)
        assert client is not None
        return await chats.service._is_in_room(session, client.id, room_id)


async def test_an_owner_grant_on_a_bridged_room_is_taken_back(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    channel = await _room(chats, [agent], name="general", bridge="slack")
    await _grant_as_before(chats, chats.alice, channel)
    assert await _in_room(chats, chats.alice, channel)

    assert await _listed(chats, chats.alice) == {}
    assert not await _in_room(chats, chats.alice, channel)
    assert await _reads(chats, chats.alice, channel) == 403
    assert await _grants(chats) == 0


async def test_with_agent_chats_off_owner_grants_are_taken_back(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    assert await _grants(chats) == 1

    chats.service.agent_chats_enabled = False
    assert await _listed(chats, chats.alice) == {}
    assert not await _in_room(chats, chats.alice, room_id)
    assert await _grants(chats) == 0


async def test_an_agent_owner_is_not_joined_to_someone_elses_chat(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.bob, agent, "c1")

    assert room_id not in await _listed(chats, chats.alice)
    assert await _reads(chats, chats.alice, room_id) == 403
    assert await _grants(chats) == 0

    assert (await chats.invite(chats.bob, room_id, chats.alice)).status_code == 200
    assert room_id in await _listed(chats, chats.alice)
    left = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.alice.id}",
        headers=chats.as_user(chats.alice),
    )
    assert left.status_code == 204


async def test_with_agent_chats_off_owning_an_agent_joins_nothing(
    chats: _Harness,
) -> None:
    chats.service.agent_chats_enabled = False
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])

    assert await _listed(chats, chats.alice) == {}
    assert await _reads(chats, chats.alice, room_id) == 403
    assert await _grants(chats) == 0


async def test_an_agent_owner_rejoins_a_chat_they_started_when_their_agent_arrives(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    assert await _reads(chats, chats.alice, room_id) == 403

    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    listed = await _listed(chats, chats.alice)
    assert set(listed) == {room_id}
    assert listed[room_id]["ownsAgent"] is True
    assert await _reads(chats, chats.alice, room_id) == 200
    assert await _grants(chats) == 1


async def test_owning_an_agent_in_an_archived_room_grants_nothing(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _room(chats, [agent], archived=True)

    assert await _listed(chats, chats.alice) == {}
    assert await _reads(chats, chats.alice, room_id) == 403


async def test_owner_membership_is_granted_once(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    async with chats.factory() as session:
        await session.execute(
            room_agents.insert().values(room_id=room_id, agent_id=agent.id)
        )
        await session.commit()

    for _ in range(3):
        assert set(await _listed(chats, chats.alice)) == {room_id}
    assert await _reads(chats, chats.alice, room_id) == 200

    async with chats.factory() as session:
        client = await chats.service.member_client(session, chats.alice.id)
        assert client is not None
        memberships = await session.scalar(
            select(func.count())
            .select_from(ClientRoom)
            .where(ClientRoom.client_id == client.id)
        )
        arrivals = await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(
                Message.room_id == room_id,
                Message.sender_client_id == client.id,
                Message.event_type == "m.room.member",
            )
        )
    # One arrival from starting the chat, one from the owner rejoin.
    assert (memberships, arrivals, await _grants(chats)) == (1, 2, 1)


async def test_a_room_that_gains_the_owners_agent_is_announced_at_once(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)

    events = _stream(chats, chats.alice, {}, recheck=60.0)
    assert (await events.next())[0] == "ready"

    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    assert await _reads(chats, chats.alice, room_id) == 200

    await chats.room_service.remove_agents_from_room(room_id, [agent.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )
    assert await _reads(chats, chats.alice, room_id) == 403
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_periodic_recheck_finds_a_chat_the_agent_joined_elsewhere(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)

    events = _stream(chats, chats.alice, {}, recheck=0.2)
    assert (await events.next())[0] == "ready"

    # Written straight to the table: no hook runs and no signal is sent, as
    # when another process's signal is missed.
    async with chats.factory() as session:
        await session.execute(
            room_agents.insert().values(room_id=room_id, agent_id=agent.id)
        )
        await session.commit()
    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_an_agent_owner_cannot_leave_or_be_removed(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await _listed(chats, chats.alice))[room_id]["ownsAgent"] is True

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.alice.id}",
        headers=chats.as_user(chats.admin),
    )
    assert removed.status_code == 409
    assert _code(removed) == "AGENT_OWNER"
    left = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.alice.id}",
        headers=chats.as_user(chats.alice),
    )
    assert left.status_code == 409
    assert _code(left) == "AGENT_OWNER"
    assert "remove it from your list" in left.json()["detail"]["message"]

    hidden = await chats.client.put(
        f"/chats/{room_id}/hidden", headers=chats.as_user(chats.alice)
    )
    assert hidden.status_code == 204
    assert room_id not in await _listed(chats, chats.alice)
    assert await _reads(chats, chats.alice, room_id) == 200


async def test_losing_the_last_owned_agent_ends_the_owners_access(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    await chats.room_service.add_agents_to_room(
        room_id, agent_ids=[helper.id, other.id]
    )
    assert room_id in await _listed(chats, chats.alice)

    events = _stream(chats, chats.alice, {}, recheck=60.0)
    assert (await events.next())[0] == "chat"
    assert (await events.next())[0] == "ready"

    # One of two owned agents gone: still a member, and nothing is announced.
    await chats.room_service.remove_agents_from_room(room_id, [helper.id])
    assert await _reads(chats, chats.alice, room_id) == 200

    await chats.room_service.remove_agents_from_room(room_id, [other.id])
    assert await events.next() == (
        "chat.removed",
        {"roomId": room_id, "reason": "access"},
    )
    assert await _reads(chats, chats.alice, room_id) == 403
    assert await _listed(chats, chats.alice) == {}
    assert await _grants(chats) == 0
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_handing_an_agent_to_someone_else_ends_the_owners_access(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    assert room_id in await _listed(chats, chats.alice)

    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.owner_id = chats.bob.id
        await session.commit()

    assert await _listed(chats, chats.alice) == {}
    assert await _reads(chats, chats.alice, room_id) == 403
    # Not a chat Bob started, so the new owner is not joined either.
    assert await _listed(chats, chats.bob) == {}
    assert await _reads(chats, chats.bob, room_id) == 403


async def test_a_deleted_agent_takes_its_owners_access_with_it(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await _left_chat(chats, chats.alice)
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[agent.id])
    assert room_id in await _listed(chats, chats.alice)

    async with chats.factory() as session:
        await AgentStore().delete(session, agent.id)
        await session.commit()
    await chats.room_service.room_agents_changed(TENANT, room_id)

    assert await _reads(chats, chats.alice, room_id) == 403


async def test_an_owner_who_created_the_chat_keeps_it_when_the_agent_goes(
    chats: _Harness,
) -> None:
    helper = await chats.agent("helper", owner=chats.alice)
    other = await chats.agent("other", owner=chats.bob)
    room_id = await chats.new_chat(chats.alice, helper, "c1")
    await chats.room_service.add_agents_to_room(room_id, agent_ids=[other.id])
    await chats.room_service.remove_agents_from_room(room_id, [helper.id])

    assert await _reads(chats, chats.alice, room_id) == 200


# ── Turn activity and approval requests ──────────────────────────────────────


async def _step(
    chats: _Harness, agent: Agent, room_id: str, turn_id: str, item_id: str, rev: int
) -> None:
    async with chats.factory() as session:
        await session.merge(
            AgentSessionActivityItem(
                tenant_id="00000000-0000-0000-0000-000000000000",
                agent_id=agent.id,
                session_id="s1",
                turn_id=turn_id,
                item_id=item_id,
                kind="turn" if item_id == "turn" else "tool-activity",
                revision=rev,
                status="running" if item_id == "turn" else "in-progress",
                title=f"{item_id} r{rev}",
                text="",
                room_id=room_id,
                occurred_at=datetime.now(UTC),
            )
        )
        await session.commit()


async def _request(
    chats: _Harness, agent: Agent, room_id: str, request_id: str, state: str
) -> None:
    async with chats.factory() as session:
        session.add(
            ApprovalRequest(
                tenant_id="00000000-0000-0000-0000-000000000000",
                agent_id=agent.id,
                session_id="s1",
                request_id=request_id,
                turn_id="t1",
                kind="approval",
                room_id=room_id,
                title="Run it?",
                options=[{"id": "y", "label": "Yes", "decision": "accept"}],
                questions=[],
                state=state,
                answer="y" if state == "answered" else None,
            )
        )
        await session.commit()


def _turn_change(agent: Agent, room_id: str, turn_id: str) -> Change:
    return Change(
        kind="activity",
        tenant_id="00000000-0000-0000-0000-000000000000",
        agent_id=agent.id,
        session_id="s1",
        key=turn_id,
        room_id=room_id,
        row=None,
    )


def _activity_stream(
    chats: _Harness,
    user: User,
    queue_max: int = 64,
    ping_seconds: float = 60.0,
    recheck_seconds: float = 60.0,
) -> _Events:
    return _Events(
        chat_activity_events(
            chats.service,
            "00000000-0000-0000-0000-000000000000",
            user,
            ping_seconds=ping_seconds,
            recheck_seconds=recheck_seconds,
            queue_max=queue_max,
        )
    )


async def _silently_leave(chats: _Harness, user: User, room_id: str) -> None:
    """Take the user out of the room without telling any stream."""
    async with chats.factory() as session:
        client = await chats.service.member_client(session, user.id)
        assert client is not None
        await session.execute(
            delete(ClientRoom).where(
                ClientRoom.client_id == client.id, ClientRoom.room_id == room_id
            )
        )
        await session.commit()


async def test_room_activity_is_the_rooms_steps_and_requests_in_every_state(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    mine = await chats.new_chat(chats.alice, agent, "c1")
    other_agent = await chats.agent("other", owner=chats.bob)
    other = await chats.new_chat(chats.bob, other_agent, "c2")
    await _step(chats, agent, mine, "t1", "turn", 1)
    await _step(chats, agent, mine, "t1", "tool-1", 2)
    await _step(chats, other_agent, other, "t9", "turn", 1)
    await _request(chats, agent, mine, "r-open", "open")
    await _request(chats, agent, mine, "r-done", "answered")
    await _request(chats, other_agent, other, "r-other", "open")

    response = await chats.client.get(
        f"/chats/{mine}/activity", headers=chats.as_user(chats.alice)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [(i["turnId"], i["itemId"], i["revision"]) for i in body["items"]] == [
        ("t1", "turn", 1),
        ("t1", "tool-1", 2),
    ]
    assert {(a["requestId"], a["state"]) for a in body["approvals"]} == {
        ("r-open", "open"),
        ("r-done", "answered"),
    }

    refused = await chats.client.get(
        f"/chats/{mine}/activity", headers=chats.as_user(chats.bob)
    )
    assert refused.status_code == 403


async def test_room_activity_keeps_open_requests_past_retention(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    await _request(chats, agent, room_id, "r-old-open", "open")
    await _request(chats, agent, room_id, "r-old-done", "answered")
    async with chats.factory() as session:
        await session.execute(
            update(ApprovalRequest).values(
                updated_at=datetime.now(UTC) - timedelta(days=8)
            )
        )
        await session.commit()

    response = await chats.client.get(
        f"/chats/{room_id}/activity", headers=chats.as_user(chats.alice)
    )
    assert response.status_code == 200, response.text
    assert [a["requestId"] for a in response.json()["approvals"]] == ["r-old-open"]


async def test_the_activity_stream_sends_only_readable_rooms_and_moved_steps(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    other_agent = await chats.agent("other", owner=chats.alice)
    hidden = await chats.new_chat(chats.alice, other_agent, "c2")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    events = _activity_stream(chats, chats.bob)
    assert (await events.next())[0] == "ready"

    await _step(chats, agent, room_id, "t1", "turn", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    name, item = await events.next()
    assert name == "activity" and item["roomId"] == room_id and item["revision"] == 1

    # A reread of the turn resends only the step that moved.
    await _step(chats, agent, room_id, "t1", "tool-1", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    name, item = await events.next()
    assert (name, item["itemId"]) == ("activity", "tool-1")

    # A room the reader is not in is never sent: the next frame is the request.
    await _step(chats, other_agent, hidden, "t2", "turn", 1)
    await chats.activity.change(_turn_change(other_agent, hidden, "t2"))
    await _request(chats, agent, room_id, "r1", "answered")
    await chats.activity.change(
        Change(
            kind="approval.answered",
            tenant_id="00000000-0000-0000-0000-000000000000",
            agent_id=agent.id,
            session_id="s1",
            key="r1",
            room_id=room_id,
            row=None,
        )
    )
    name, request = await events.next()
    assert (name, request["requestId"], request["state"]) == (
        "approval",
        "r1",
        "answered",
    )

    [subscription] = chats.activity.room_subscriptions
    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    await _step(chats, agent, room_id, "t1", "turn", 2)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    with pytest.raises(TimeoutError):
        await events.next(timeout=0.3)
    assert room_id not in subscription.rooms
    await events.stream.aclose()  # type: ignore[attr-defined]
    assert chats.activity.room_subscriptions == []


async def test_the_activity_stream_says_resync_when_changes_may_be_lost(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    await _step(chats, agent, room_id, "t1", "turn", 1)

    events = _activity_stream(chats, chats.alice, queue_max=2)
    assert (await events.next())[0] == "ready"

    await chats.activity.resync()
    assert await events.next() == ("resync", {})

    # Falling behind drops what was queued and asks for a reload instead.
    for _ in range(3):
        await chats.activity.change(_turn_change(agent, room_id, "t1"))
    assert await events.next() == ("resync", {})
    with pytest.raises(TimeoutError):
        await events.next(timeout=0.3)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_activity_stream_rereads_its_rooms_on_a_resync(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    events = _activity_stream(chats, chats.bob)
    assert (await events.next())[0] == "ready"
    [subscription] = chats.activity.room_subscriptions
    assert subscription.rooms == {room_id}

    await _silently_leave(chats, chats.bob, room_id)
    await chats.activity.resync()
    assert await events.next() == ("resync", {})
    assert subscription.rooms == set()
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_activity_stream_wakes_only_for_the_readers_rooms(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    other_agent = await chats.agent("other", owner=chats.bob)
    unrelated = await chats.new_chat(chats.bob, other_agent, "c2")
    events = _activity_stream(chats, chats.alice)
    assert (await events.next())[0] == "ready"
    [subscription] = chats.activity.room_subscriptions

    wakes: list[str] = []
    turn_reads: list[str] = []
    frames_of = chats_module._activity_frames
    turn_items = chats.service.turn_items

    async def counted_frames(*args: Any) -> Any:
        wakes.append(args[3].key)
        return await frames_of(*args)

    async def counted_turn_items(*args: Any) -> Any:
        turn_reads.append(args[3])
        return await turn_items(*args)

    monkeypatch.setattr(chats_module, "_activity_frames", counted_frames)
    monkeypatch.setattr(chats.service, "turn_items", counted_turn_items)

    await _step(chats, other_agent, unrelated, "t9", "turn", 1)
    await chats.activity.change(_turn_change(other_agent, unrelated, "t9"))
    assert subscription.delivered == 0

    await _step(chats, agent, room_id, "t1", "turn", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    name, item = await events.next()
    assert (name, item["turnId"]) == ("activity", "t1")
    assert subscription.delivered == 1
    assert wakes == ["t1"]
    assert turn_reads == ["t1"]
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_activity_stream_follows_a_room_the_reader_joins(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    events = _activity_stream(chats, chats.bob)
    assert (await events.next())[0] == "ready"

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    assert await events.next() == ("resync", {})
    await _step(chats, agent, room_id, "t1", "turn", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    name, item = await events.next()
    assert (name, item["roomId"]) == ("activity", room_id)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_a_room_joined_while_the_stream_reads_its_rooms_is_not_missed(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    readable_rooms = chats.service.readable_rooms
    joined: list[bool] = []

    async def join_after_reading(*args: Any) -> Any:
        rooms = await readable_rooms(*args)
        if not joined:
            joined.append(True)
            invited = await chats.invite(chats.alice, room_id, chats.bob)
            assert invited.status_code == 200
        return rooms

    monkeypatch.setattr(chats.service, "readable_rooms", join_after_reading)
    events = _activity_stream(chats, chats.bob)
    assert (await events.next())[0] == "ready"
    assert room_id not in chats.activity.room_subscriptions[0].rooms

    assert await events.next() == ("resync", {})
    await _step(chats, agent, room_id, "t1", "turn", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    name, item = await events.next()
    assert (name, item["roomId"]) == ("activity", room_id)
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_a_stale_room_index_sends_nothing_from_a_room_left(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    left = await chats.new_chat(chats.alice, agent, "c1")
    kept = await chats.new_chat(chats.alice, agent, "c2")
    for room_id in (left, kept):
        assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    events = _activity_stream(chats, chats.bob)
    assert (await events.next())[0] == "ready"
    [subscription] = chats.activity.room_subscriptions

    await _silently_leave(chats, chats.bob, left)
    await _step(chats, agent, left, "t1", "turn", 1)
    await chats.activity.change(_turn_change(agent, left, "t1"))
    await _step(chats, agent, kept, "t2", "turn", 1)
    await chats.activity.change(_turn_change(agent, kept, "t2"))
    name, item = await events.next()
    assert (name, item["roomId"]) == ("activity", kept)
    assert subscription.delivered == 2
    await events.stream.aclose()  # type: ignore[attr-defined]


async def test_the_activity_stream_rechecks_its_rooms_under_steady_traffic(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    events = _activity_stream(chats, chats.bob, recheck_seconds=0.2)
    assert (await events.next())[0] == "ready"
    [subscription] = chats.activity.room_subscriptions

    await _silently_leave(chats, chats.bob, room_id)
    reading = asyncio.create_task(events.next(timeout=10))
    deadline = asyncio.get_running_loop().time() + 5
    while room_id in subscription.rooms:
        assert asyncio.get_running_loop().time() < deadline
        await chats.activity.change(_turn_change(agent, room_id, "t1"))
        await asyncio.sleep(0.01)
    assert subscription.delivered > 5
    reading.cancel()
    await asyncio.gather(reading, return_exceptions=True)
    assert chats.activity.room_subscriptions == []


async def _drop_tenant_role(chats: _Harness, user: User) -> None:
    async with chats.factory() as session:
        await session.execute(
            delete(TenantMember).where(TenantMember.user_id == user.id)
        )
        await session.commit()


async def test_the_activity_stream_ends_when_the_tenant_role_is_gone(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    on_change = _activity_stream(chats, chats.bob)
    assert (await on_change.next())[0] == "ready"
    on_recheck = _activity_stream(chats, chats.bob, recheck_seconds=0.05)
    assert (await on_recheck.next())[0] == "ready"

    await _drop_tenant_role(chats, chats.bob)
    await _step(chats, agent, room_id, "t1", "turn", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    with pytest.raises(StopAsyncIteration):
        await on_change.next()
    with pytest.raises(StopAsyncIteration):
        await on_recheck.next()
    assert chats.activity.room_subscriptions == []


async def test_the_activity_stream_forgets_revisions_past_its_cap(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chats_module, "_ACTIVITY_SENT_MAX", 1)
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    events = _activity_stream(chats, chats.alice)
    assert (await events.next())[0] == "ready"

    await _step(chats, agent, room_id, "t1", "turn", 1)
    await _step(chats, agent, room_id, "t1", "tool-1", 1)
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    assert [(await events.next())[1]["itemId"] for _ in range(2)] == ["turn", "tool-1"]

    # Over the cap, the next reread starts from nothing and resends the turn.
    await chats.activity.change(_turn_change(agent, room_id, "t1"))
    assert [(await events.next())[1]["itemId"] for _ in range(2)] == ["turn", "tool-1"]
    await events.stream.aclose()  # type: ignore[attr-defined]


async def _events_of(chats: _Harness, agent: Agent) -> list[tuple[str, int]]:
    """The rows stored as the agent's own events, by room and place."""
    async with chats.factory() as session:
        rows = await session.execute(
            select(AgentEventRow.room_id, AgentEventRow.room_seq).where(
                AgentEventRow.agent_id == agent.id
            )
        )
        return [(room_id, room_seq) for room_id, room_seq in rows.all()]
