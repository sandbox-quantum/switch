"""A `!command` typed in Switch Console chat: posted through
`POST /chats/{room_id}/messages` as the `com.switch.command` event a platform
bridge writes, and run by the same admin-side handlers."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from sqlalchemy import select

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.commands import dispatch_admin_command
from switch_core.bridges.agent.protocol.agent_core import AgentRenameResult
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.clients.consumer import Consumer
from switch_core.db.models import TENANT_ZERO_ID, Agent, Message, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.events import CommandEvent
from switch_core.transport import RoomRef
from switch_core.transport.stored import to_inbound
from tests.switch_core.gateway.conftest import _Harness


@dataclass
class _FakeCore:
    renamed: list[str] = field(default_factory=list)

    async def rename_agent(
        self, *, agent_id: str, new_name: str, display_name: str | None
    ) -> AgentRenameResult:
        self.renamed.append(new_name)
        return AgentRenameResult(
            agent_id=agent_id,
            old_name="helper",
            new_name=new_name,
            display_name=display_name,
            bridge_failures=[],
            templates_mentioning_old_name=[],
        )


@dataclass
class _Admin:
    """The admin client's command handling, with its replies recorded."""

    host: CommandConsumer
    core: _FakeCore
    replies: list[tuple[str, str | None]]


def _admin(chats: _Harness) -> _Admin:
    replies: list[tuple[str, str | None]] = []

    async def reply_command(
        _room_id: str, body: str, *, thread_root_id: str | None = None, **_kw: Any
    ) -> None:
        replies.append((body, thread_root_id))

    async def send_admin(*_args: Any, **_kw: Any) -> None:
        return None

    core = _FakeCore()
    host = object.__new__(CommandConsumer)
    host.actor = SimpleNamespace(  # type: ignore[assignment]
        session_factory=chats.factory,
        client_store=ClientStore(),
        tenant_id=TENANT_ZERO_ID,
        send_admin=send_admin,
    )
    host._room_store = RoomStore()
    host._agent_store = AgentStore()
    host._user_store = UserStore()
    host._external_user_store = ExternalUserStore()
    host._agent_admin = SimpleNamespace(core=core)  # type: ignore[assignment]
    host._room_meta_cache = {}
    host._follow_the_conversation_enabled = True
    host._pending_deletes = {}
    host.reply_command = reply_command  # type: ignore[method-assign]
    return _Admin(host=host, core=core, replies=replies)


async def _rows(chats: _Harness, room_id: str, event_type: str) -> list[Message]:
    async with chats.factory() as session:
        rows = await session.execute(
            select(Message)
            .where(Message.room_id == room_id, Message.event_type == event_type)
            .order_by(Message.seq)
        )
        return list(rows.scalars().all())


async def _commands(chats: _Harness, room_id: str) -> list[Message]:
    return await _rows(chats, room_id, "com.switch.command")


async def _run(chats: _Harness, admin: _Admin, row: Message) -> CommandEvent:
    """Deliver the stored row the way every consumer reads it, to the admin."""
    async with chats.factory() as session:
        room = await session.get(Room, row.room_id)
    assert room is not None
    seen: list[CommandEvent] = []

    async def on_command(ref: RoomRef, event: CommandEvent) -> None:
        seen.append(event)
        await dispatch_admin_command(admin.host, ref, event)

    consumer = SimpleNamespace(
        _EVENT_DISPATCH=Consumer._EVENT_DISPATCH,
        _should_ignore=lambda _room, _event: False,
        on_command=on_command,
    )
    ref = RoomRef(room_id=room.transport_room_id)
    inbound = to_inbound(row, [], transport_room_id=ref.room_id)
    await Consumer._handle_custom_event(consumer, ref, inbound)  # type: ignore[arg-type]
    [event] = seen
    return event


async def _chat(chats: _Harness) -> tuple[Agent, str]:
    agent = await chats.agent("helper", owner=chats.alice)
    return agent, await chats.new_chat(chats.alice, agent, "c1")


async def test_a_typed_command_runs_once_and_is_answered(chats: _Harness) -> None:
    _, room_id = await _chat(chats)
    sent = await chats.send(chats.alice, room_id, "k1", "!list-agents")
    assert sent.status_code == 200, sent.text
    [shown] = sent.json()["messages"]
    assert shown["body"] == "!list-agents"

    [row] = await _commands(chats, room_id)
    assert row.content["command"] == "list-agents"
    assert row.content["args"] == ""
    assert row.content["user_name"] == "alice"
    assert shown["messageId"] == row.transport_event_id

    admin = _admin(chats)
    await _run(chats, admin, row)
    [(reply, thread)] = admin.replies
    assert "**Agents in this room:**" in reply
    assert "helper" in reply
    assert thread == row.transport_event_id


async def test_a_command_is_not_also_an_ordinary_message(chats: _Harness) -> None:
    _, room_id = await _chat(chats)
    before = len(await chats.message_rows(room_id))
    assert (
        await chats.send(chats.alice, room_id, "k1", "!list-agents")
    ).status_code == 200
    assert len(await chats.message_rows(room_id)) == before


async def test_a_retried_command_posts_once(chats: _Harness) -> None:
    _, room_id = await _chat(chats)
    first = await chats.send(chats.alice, room_id, "k1", "!follow-ups off")
    again = await chats.send(chats.alice, room_id, "k1", "!follow-ups off")
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    [row] = await _commands(chats, room_id)

    admin = _admin(chats)
    await _run(chats, admin, row)
    async with chats.factory() as session:
        assert not await RoomStore().follow_ups_enabled(session, room_id)
    assert len(admin.replies) == 1


async def test_a_command_in_a_thread_is_answered_there(chats: _Harness) -> None:
    _, room_id = await _chat(chats)
    root = await chats.send(chats.alice, room_id, "k1", "hello")
    root_id = root.json()["messages"][0]["messageId"]

    sent = await chats.send(
        chats.alice, room_id, "k2", "!list-agents", threadRootId=root_id
    )
    assert sent.status_code == 200, sent.text
    [row] = await _commands(chats, room_id)
    assert row.thread_root_event_id == root_id

    admin = _admin(chats)
    event = await _run(chats, admin, row)
    assert event.thread_id == root_id
    [(_, thread)] = admin.replies
    assert thread == root_id


async def test_an_unknown_command_is_named(chats: _Harness) -> None:
    _, room_id = await _chat(chats)
    await chats.send(chats.alice, room_id, "k1", "!frobnicate now")
    [row] = await _commands(chats, room_id)

    admin = _admin(chats)
    await _run(chats, admin, row)
    assert admin.replies == [("Unknown command: `frobnicate`", row.transport_event_id)]


async def test_the_owner_renames_from_console_and_others_are_refused(
    chats: _Harness,
) -> None:
    _, room_id = await _chat(chats)
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200

    await chats.send(chats.bob, room_id, "k1", "!rename-agent @helper hijacked")
    await chats.send(chats.alice, room_id, "k2", "!rename-agent @helper scribe")
    by_bob, by_alice = await _commands(chats, room_id)

    admin = _admin(chats)
    await _run(chats, admin, by_bob)
    assert admin.core.renamed == []
    assert "Only the agent's owner or a workspace admin" in admin.replies[0][0]

    await _run(chats, admin, by_alice)
    assert admin.core.renamed == ["scribe"]


async def _command(
    chats: _Harness, admin: _Admin, user: User, room_id: str, key: str, body: str
) -> str:
    sent = await chats.send(user, room_id, key, body)
    assert sent.status_code == 200, sent.text
    await _run(chats, admin, (await _commands(chats, room_id))[-1])
    return admin.replies[-1][0]


async def _room(chats: _Harness, room_id: str) -> Room:
    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        return room


def _console_admin(chats: _Harness) -> _Admin:
    admin = _admin(chats)
    admin.host._room_service = chats.room_service
    return admin


async def test_invite_from_console_needs_what_adding_an_agent_needs(
    chats: _Harness,
) -> None:
    _, room_id = await _chat(chats)
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    await chats.agent("bobs", owner=chats.bob)
    await chats.agent(
        "private", owner=chats.carol, policy=owner_only_policy([]).model_dump()
    )
    admin = _console_admin(chats)

    assert "Only the room's owner or a workspace admin" in await _command(
        chats, admin, chats.bob, room_id, "k1", "!invite-agent @bobs"
    )
    assert "You may not chat with this agent" in await _command(
        chats, admin, chats.alice, room_id, "k2", "!invite-agent @private"
    )
    async with chats.factory() as session:
        assert len(await RoomStore().get_agent_ids(session, room_id)) == 1
    assert "Added" in await _command(
        chats, admin, chats.alice, room_id, "k3", "!invite-agent @bobs"
    )
    async with chats.factory() as session:
        assert len(await RoomStore().get_agent_ids(session, room_id)) == 2


async def test_inviting_a_second_agent_makes_a_direct_chat_a_group(
    chats: _Harness,
) -> None:
    _, room_id = await _chat(chats)
    assert (await _room(chats, room_id)).channel_type == "direct"
    await chats.agent("second", owner=chats.alice)

    await _command(
        chats,
        _console_admin(chats),
        chats.alice,
        room_id,
        "k1",
        "!invite-agent @second",
    )

    assert (await _room(chats, room_id)).channel_type == "channel_private"


async def test_only_a_manager_removes_an_agent_from_console(chats: _Harness) -> None:
    _, room_id = await _chat(chats)
    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    admin = _console_admin(chats)

    assert "Only the room's owner or a workspace admin" in await _command(
        chats, admin, chats.bob, room_id, "k1", "!remove-agent @helper"
    )
    async with chats.factory() as session:
        assert len(await RoomStore().get_agent_ids(session, room_id)) == 1
    assert "Removed" in await _command(
        chats, admin, chats.alice, room_id, "k2", "!remove-agent @helper"
    )
    async with chats.factory() as session:
        assert await RoomStore().get_agent_ids(session, room_id) == []


async def test_text_that_only_looks_like_a_command_stays_a_message(
    chats: _Harness,
) -> None:
    _, room_id = await _chat(chats)
    bodies = [
        "!!!",
        "! hi",
        "```\n!list-agents\n```",
        "please run !list-agents",
        "!!list",
        "    !delete-agent @helper",
        "\t!delete-agent @helper",
    ]
    for index, body in enumerate(bodies):
        sent = await chats.send(chats.alice, room_id, f"k{index}", body)
        assert sent.status_code == 200, sent.text
    assert await _commands(chats, room_id) == []
    sent_bodies = [row.content.get("body") for row in await chats.message_rows(room_id)]
    for body in bodies:
        assert body in sent_bodies
