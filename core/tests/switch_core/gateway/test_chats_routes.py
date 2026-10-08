"""`/chats`: membership as the only read authority, retryable creates and
sends, and the live event stream — against real Postgres.

The routes run behind a real `ChatService`, `RoomService` and Postgres
provisioning. Only the running-client registry is faked (no agent consumer
runs here) and the message listener, whose wake-ups the stream tests ring by
hand so a missed notification can be staged.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.chats.service import ChatError, ChatService
from switch_core.db.models import (
    Agent,
    ChatOperation,
    Client,
    ClientRoom,
    Message,
    Room,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.chats import (
    chat_error_response,
    chat_events,
    router,
)
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.transport.invites import InviteBus
from tests.switch_core.gateway.agent_route_harness import add_agent

_MESSAGE_STORE = MessageStore()


class _FakeLifecycle:
    """The running-client registry, for agents that have no consumer here."""

    def __init__(self) -> None:
        self.agents: dict[str, SimpleNamespace] = {}

    def get_by_agent_id(self, agent_id: str) -> SimpleNamespace | None:
        return self.agents.get(agent_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _FakeListener:
    """Records subscriptions; a test rings a room by hand, or deliberately not."""

    def __init__(self) -> None:
        self.wakers: dict[str, set[Callable[[str], Awaitable[None]]]] = {}

    def subscribe(self, room_id: str, waker: Callable[[str], Awaitable[None]]) -> None:
        self.wakers.setdefault(room_id, set()).add(waker)

    def unsubscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None:
        self.wakers.get(room_id, set()).discard(waker)

    async def ring(self, room_id: str) -> None:
        for waker in list(self.wakers.get(room_id, ())):
            await waker(room_id)


class _Harness(SimpleNamespace):
    client: httpx.AsyncClient
    factory: async_sessionmaker[AsyncSession]
    service: ChatService
    room_service: RoomService
    listener: _FakeListener
    lifecycle: _FakeLifecycle
    alice: User
    bob: User
    carol: User
    admin: User

    def as_user(self, user: User) -> dict[str, str]:
        return {"x-user": user.id}

    async def agent(
        self, name: str, *, owner: User, policy: dict | None = None
    ) -> Agent:
        async with self.factory() as session:
            agent = await add_agent(session, name=name, owner_id=owner.id)
            agent.addressing_policy = policy
            client = await session.get(Client, agent.client_id)
            assert client is not None
            self.lifecycle.agents[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )
            await session.commit()
            return agent

    async def create_chat(
        self, user: User, agent: Agent, request_id: str, name: str | None = None
    ) -> httpx.Response:
        return await self.client.post(
            "/chats",
            json={"agentId": agent.id, "name": name, "requestId": request_id},
            headers=self.as_user(user),
        )

    async def new_chat(self, user: User, agent: Agent, request_id: str) -> str:
        response = await self.create_chat(user, agent, request_id)
        assert response.status_code == 200, response.text
        return str(response.json()["chat"]["roomId"])

    async def send(
        self, user: User, room_id: str, request_id: str, body: str, **extra: Any
    ) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/messages",
            json={"requestId": request_id, "body": body, **extra},
            headers=self.as_user(user),
        )

    async def invite(self, manager: User, room_id: str, user: User) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/members",
            json={"userId": user.id},
            headers=self.as_user(manager),
        )

    async def upload(
        self, user: User, room_id: str, upload_id: str, data: bytes, name: str
    ) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/attachments",
            data={"uploadId": upload_id},
            files={"file": (name, data, "image/png")},
            headers=self.as_user(user),
        )

    async def message_rows(self, room_id: str) -> list[Message]:
        async with self.factory() as session:
            rows = await session.execute(
                select(Message)
                .where(
                    Message.room_id == room_id, Message.event_type == "m.room.message"
                )
                .order_by(Message.seq)
            )
            return list(rows.scalars().all())


async def _user(session: AsyncSession, name: str, role: str | None) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    if role is not None:
        await UserStore().add_membership(
            session,
            tenant_id="00000000-0000-0000-0000-000000000000",
            user_id=user.id,
            role=role,
        )
    return user


@pytest.fixture
async def chats(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[_Harness]:
    async with session_factory() as session:
        alice = await _user(session, "alice", "member")
        bob = await _user(session, "bob", "member")
        carol = await _user(session, "carol", None)
        admin = await _user(session, "admin", "admin")
        await session.commit()

    room_store = RoomStore()
    lifecycle = _FakeLifecycle()
    provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=room_store,
        client_store=ClientStore(),
        message_store=_MESSAGE_STORE,
        invites=InviteBus(),
    )
    room_service = RoomService(
        provisioning=provisioning,
        room_store=room_store,
        agent_store=AgentStore(),
        client_lifecycle=lifecycle,  # type: ignore[arg-type]
        collab_lifecycle=None,  # type: ignore[arg-type]
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=None,  # type: ignore[arg-type]
        session_factory=session_factory,
    )
    listener = _FakeListener()
    service = ChatService(
        session_factory=session_factory,
        room_service=room_service,
        provisioning=provisioning,
        listener=listener,  # type: ignore[arg-type]
        room_store=room_store,
        agent_store=AgentStore(),
        user_store=UserStore(),
        message_store=_MESSAGE_STORE,
        media_store=MediaStore(),
        usage_store=UsageStore(),
        id_server_name="switch.test",
        media_max_bytes=1024,
    )

    app = FastAPI()
    app.state.chat_service = service
    app.add_exception_handler(ChatError, chat_error_response)
    app.include_router(router, prefix="/chats")

    async def user_from_header(request: Request) -> User:
        async with session_factory() as session:
            user = await session.get(User, request.headers["x-user"])
            assert user is not None
            return user

    app.dependency_overrides[get_current_user] = user_from_header
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://switch.test"
    ) as client:
        yield _Harness(
            client=client,
            factory=session_factory,
            service=service,
            room_service=room_service,
            listener=listener,
            lifecycle=lifecycle,
            alice=alice,
            bob=bob,
            carol=carol,
            admin=admin,
        )


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
    assert chat["name"] == "Chat with helper, other"

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
    assert await events.next() == ("chat.removed", {"roomId": "gone-room"})
    assert (await events.next())[0] == "ready"

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    name, summary = await events.next()
    assert name == "chat" and summary["roomId"] == room_id

    removed = await chats.client.delete(
        f"/chats/{room_id}/members/{chats.bob.id}", headers=chats.as_user(chats.alice)
    )
    assert removed.status_code == 204
    assert await events.next() == ("chat.removed", {"roomId": room_id})

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
    assert await events.next() == ("chat.removed", {"roomId": room_id})
    with pytest.raises(StopAsyncIteration):
        await anext(events.stream)


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
