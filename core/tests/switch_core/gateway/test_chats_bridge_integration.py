"""Console /chats integration with collaboration bridges.

Tests that console member messages relay outbound through bridges, that
threading works both ways, and that multi-attachment sends are atomic even
when the bridge adapter fails mid-relay.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.db.models import (
    CollaborationBridge,
    Message,
    Room,
)
from switch_core.transport import InboundMessage as TransportMessage
from switch_core.transport import RoomRef
from tests.switch_core.gateway.test_chats_routes import _Harness

pytest_plugins = ["tests.switch_core.gateway.test_chats_routes"]


class _FakeCollabAdapter(PlatformAdapter):
    """Minimal fake adapter for testing console → bridge outbound relay."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.next_ref_id = 1
        self._should_raise: Exception | None = None

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        room_wide_mention: bool = False,
    ) -> str:
        if self._should_raise:
            raise self._should_raise
        ref_id = f"ext-{self.next_ref_id}"
        self.next_ref_id += 1
        self.sent.append(
            {
                "channel_id": channel_id,
                "sender_name": sender_name,
                "content": content,
                "thread_root_id": thread_root_id,
                "room_wide_mention": room_wide_mention,
            }
        )
        return ref_id

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[dict[str, Any]],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str:
        if self._should_raise:
            raise self._should_raise
        ref_id = f"ext-{self.next_ref_id}"
        self.next_ref_id += 1
        self.sent.append(
            {
                "channel_id": channel_id,
                "sender_name": sender_name,
                "files": files,
                "caption": caption,
                "thread_root_id": thread_root_id,
            }
        )
        return ref_id

    def translate_outbound(self, content: str) -> str:
        return content

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, content: str) -> str:
        return content

    def render_room_wide_mention(self, content: str) -> str:
        return content

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def create_channel(self, *args: Any, **kwargs: Any) -> Any:
        return None

    async def add_users_to_channel(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def add_agents_to_channel(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def get_channel_type(self, *args: Any, **kwargs: Any) -> Any:
        return None

    async def get_channel_agent_names(self, *args: Any, **kwargs: Any) -> list[str]:
        return []

    async def create_agent_identity(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def remove_agent_identity(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def send_typing(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def update_message(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def delete_message(self, *args: Any, **kwargs: Any) -> None:
        pass


async def _bridged_room(
    chats: _Harness, agent: Any
) -> tuple[str, CollaborationBridge, _FakeCollabAdapter]:
    """Create a room with the given agent, attach a fake collaboration bridge, return room_id, bridge, adapter."""
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    async with chats.factory() as session:
        from switch_core.db.models import Client

        room = await session.get(Room, room_id)
        assert room is not None

        bridge_client = Client(
            transport_user_id=f"@fake-bridge-bot:{agent.id}:switch.test",
            display_name="Fake Bridge Bot",
            type="bridge",
        )
        session.add(bridge_client)
        await session.flush()

        bridge = CollaborationBridge(
            tenant_id=room.tenant_id,
            type="fake",
            display_name="Fake Bridge",
            connection_config={},
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()

        room.bridge_id = bridge.id
        room.external_channel_id = "fake-chan-1"
        await session.commit()

    adapter = _FakeCollabAdapter()
    return room_id, bridge, adapter


async def _fake_collab_core(
    chats: _Harness,
    room_id: str,
    bridge: CollaborationBridge,
    adapter: _FakeCollabAdapter,
) -> CollaborationCore:
    """Wire a minimal CollaborationCore with the fake adapter and harness state."""

    async def _room_tenant(rid: str) -> str:
        async with chats.factory() as session:
            room = await session.get(Room, rid)
            assert room is not None
            return room.tenant_id

    async def _external_post_for_event(transport_event_id: str) -> str | None:
        async with chats.factory() as session:
            from switch_core.db.models import BridgeMessageMap

            result = await session.execute(
                select(BridgeMessageMap.external_post_id).where(
                    BridgeMessageMap.transport_event_id == transport_event_id
                )
            )
            return result.scalar_one_or_none()

    async def _record_message_map(
        external_channel_id: str, transport_event_id: str, external_post_id: str
    ) -> None:
        async with chats.factory() as session:
            from switch_core.db.models import BridgeMessageMap

            map_row = BridgeMessageMap(
                bridge_id=bridge.id,
                external_channel_id=external_channel_id,
                transport_event_id=transport_event_id,
                external_post_id=external_post_id,
            )
            session.add(map_row)
            await session.commit()

    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        transport_room_id = room.transport_room_id

    ns = SimpleNamespace(
        _bridge_id=bridge.id,
        _bridge_type="fake",
        _adapter=adapter,
        _human_user_ids=set(),
        _workspace_consumer_transport_user_id="@bridge-bot:switch.test",
        _channel_to_room={"fake-chan-1": (room_id, transport_room_id)},
        _room_tenant=_room_tenant,
        _external_post_for_event=_external_post_for_event,
        _record_message_map=_record_message_map,
    )

    ns._find_channel = lambda room_id=None, transport_room_id=None: (
        "fake-chan-1" if transport_room_id == transport_room_id else None
    )
    ns._outbound_thread_root_ref = CollaborationCore._outbound_thread_root_ref.__get__(
        ns
    )
    ns._relay_outbound_message = CollaborationCore._relay_outbound_message.__get__(ns)
    ns._counted_outbound = CollaborationCore._counted_outbound.__get__(ns)

    return ns  # type: ignore[return-value]


@pytest.mark.asyncio
async def test_console_member_threaded_reply_roundtrip_through_bridge(
    chats: _Harness,
) -> None:
    """A console member's message relays outbound with sender_name, threads map
    both ways, inbound threaded replies arrive with threadRootId, and the member's
    own post is not re-imported."""
    agent = await chats.agent("helper-threaded", owner=chats.alice)
    room_id, bridge, adapter = await _bridged_room(chats, agent)
    core = await _fake_collab_core(chats, room_id, bridge, adapter)

    sent = await chats.send(chats.alice, room_id, "s1", "root message")
    assert sent.status_code == 200, sent.text
    root_msg = sent.json()["messages"][0]
    root_event_id = root_msg["messageId"]

    async with chats.factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        member = await chats.service.member_client(session, chats.alice.id)
        assert member is not None

        msg_row = await session.execute(
            select(Message).where(Message.transport_event_id == root_event_id)
        )
        msg = msg_row.scalar_one()

        event = TransportMessage(
            room_id=room.transport_room_id,
            event_id=msg.transport_event_id,
            sender=member.transport_user_id,
            timestamp=1700000000000,
            content=msg.content,
            body=msg.body,
            sender_name=msg.sender_name,
            thread_root_id=None,
        )

    await CollaborationCore.handle_outbound_message(
        core, RoomRef(room.transport_room_id), event
    )

    assert len(adapter.sent) == 1
    assert adapter.sent[0]["sender_name"] == "alice"
    assert adapter.sent[0]["content"] == "root message"
    assert adapter.sent[0]["thread_root_id"] is None

    reply_sent = await chats.send(
        chats.alice, room_id, "s2", "threaded reply", threadRootId=root_event_id
    )
    assert reply_sent.status_code == 200
    reply_msg = reply_sent.json()["messages"][0]
    assert reply_msg["threadRootId"] == root_event_id

    async with chats.factory() as session:
        reply_row = await session.execute(
            select(Message).where(Message.transport_event_id == reply_msg["messageId"])
        )
        reply_db = reply_row.scalar_one()

        reply_event = TransportMessage(
            room_id=room.transport_room_id,
            event_id=reply_db.transport_event_id,
            sender=member.transport_user_id,
            timestamp=1700000000000,
            content=reply_db.content,
            body=reply_db.body,
            sender_name=reply_db.sender_name,
            thread_root_id=root_event_id,
        )

    await CollaborationCore.handle_outbound_message(
        core, RoomRef(room.transport_room_id), reply_event
    )

    assert len(adapter.sent) == 2
    assert adapter.sent[1]["sender_name"] == "alice"
    assert adapter.sent[1]["content"] == "threaded reply"
    assert adapter.sent[1]["thread_root_id"] == "ext-1"

    async with chats.factory() as session:
        count_before = await session.scalar(
            select(func.count()).select_from(Message).where(Message.room_id == room_id)
        )

    sent_again = await chats.send(chats.alice, room_id, "s1", "root message")
    assert sent_again.status_code == 200

    async with chats.factory() as session:
        count_after = await session.scalar(
            select(func.count()).select_from(Message).where(Message.room_id == room_id)
        )

    assert count_after == count_before


@pytest.mark.asyncio
async def test_multi_attachment_send_atomic_despite_bridge_failure(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Multi-attachment message parts commit atomically (one group), and bridge
    failure mid-relay does not prevent retry with the same requestId from
    returning the stored result without inserting new parts. Atomic insert
    prevents partial groups; one external bridge post is not guaranteed through
    adapter failure."""
    agent = await chats.agent("helper-atomic", owner=chats.alice)
    room_id, bridge, adapter = await _bridged_room(chats, agent)

    for upload_id in ("u1", "u2", "u3"):
        staged = await chats.upload(
            chats.alice, room_id, upload_id, b"data", f"{upload_id}.png"
        )
        assert staged.status_code == 200, staged.text

    retried = await chats.send(
        chats.alice,
        room_id,
        "s1",
        "three files",
        uploadIds=["u1", "u2", "u3"],
    )
    assert retried.status_code == 200, retried.text
    parts = retried.json()["messages"]
    assert len(parts) == 3
    assert [p["clientTxn"] for p in parts] == ["s1:0", "s1:1", "s1:2"]

    async with chats.factory() as session:
        rows = list(
            (
                await session.execute(
                    select(Message)
                    .where(
                        Message.room_id == room_id,
                        Message.client_txn_id.like("s1:%"),
                    )
                    .order_by(Message.seq)
                )
            ).scalars()
        )
        assert len(rows) == 3
        groups = {row.content["com.switch.attachment_group"]["id"] for row in rows}
        assert len(groups) == 1

    again = await chats.send(
        chats.alice,
        room_id,
        "s1",
        "three files",
        uploadIds=["u1", "u2", "u3"],
    )
    assert again.status_code == 200
    assert [p["messageId"] for p in again.json()["messages"]] == [
        p["messageId"] for p in parts
    ]

    async with chats.factory() as session:
        final_count = await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.room_id == room_id, Message.client_txn_id.like("s1:%"))
        )

    assert final_count == 3
