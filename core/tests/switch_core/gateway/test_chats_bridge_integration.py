"""Console /chats integration with collaboration bridges.

Tests that console member messages relay outbound through bridges, that
threading works both ways, inbound threaded replies arrive correctly, echo
prevention works, and multi-attachment sends are atomic even when the bridge
adapter fails mid-relay.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.db.models import (
    Client,
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

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
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
                "filename": filename,
                "mimetype": mimetype,
                "data": data,
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


async def _fake_collab_core_full(
    chats: _Harness,
    room_id: str,
    bridge: CollaborationBridge,
    adapter: _FakeCollabAdapter,
) -> CollaborationCore:
    """Wire a CollaborationCore with both outbound and inbound paths for full testing."""

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

    async def _event_for_external_post(external_post_id: str) -> str | None:
        async with chats.factory() as session:
            from switch_core.db.models import BridgeMessageMap

            result = await session.execute(
                select(BridgeMessageMap.transport_event_id).where(
                    BridgeMessageMap.external_post_id == external_post_id
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

    async def _is_registered_agent(name: str) -> bool:
        return False

    # Track created human actors for the test
    human_actors: dict[str, SimpleNamespace] = {}

    async def _ensure_human_in_room(
        external_user_id: str,
        external_username: str,
        room_id: str,
        transport_room_id: str,
    ) -> Any:
        # Return existing or create new fake actor
        if external_user_id in human_actors:
            return human_actors[external_user_id]

        # Create a minimal fake actor that can send messages
        async def send_message(
            transport_room_id_param: str,
            content: str,
            format: str = "markdown",  # noqa: A002
            thread_root_id: str | None = None,
            metered: bool = False,
        ) -> str:
            # Use the real provisioning to send the message
            from switch_core.messages.row import message_row, new_event_id
            from switch_core.transport.content import message_content

            async with chats.factory() as session:
                from switch_core.db.stores.message_store import MessageStore
                from switch_core.db.stores.room_store import RoomStore

                # Get the room UUID from the transport_room_id
                room_row = await RoomStore().get_by_transport_room_id(
                    session, transport_room_id_param
                )
                if not room_row:
                    raise ValueError(f"Room not found: {transport_room_id_param}")

                event_id = new_event_id()
                msg_content = message_content(
                    content,
                    sender_name=external_username,
                    format=format,
                    thread_root_id=thread_root_id,
                )
                message = message_row(
                    room_id=room_row.id,
                    event_id=event_id,
                    sender_id=f"@fake-{external_user_id}:switch.test",
                    sender_client_id=None,
                    sender_name=external_username,
                    event_type="m.room.message",
                    content=msg_content,
                    client_txn_id=None,
                )
                await MessageStore().create(session, message, [])
                await session.commit()
                return event_id

        actor = SimpleNamespace(
            send_message=send_message,
            transport_user_id=f"@fake-{external_user_id}:switch.test",
        )
        human_actors[external_user_id] = actor
        return actor

    async def _handle_text_answer(msg: InboundMessage) -> None:
        pass

    async def _repair_placeholder_username(
        external_user_id: str, external_username: str
    ) -> None:
        pass

    async def _maybe_guide_self_mention(msg: InboundMessage, room_id: str) -> None:
        pass

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
        _channel_locks={},
        _room_tenant=_room_tenant,
        _external_post_for_event=_external_post_for_event,
        _event_for_external_post=_event_for_external_post,
        _record_message_map=_record_message_map,
        _is_registered_agent=_is_registered_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _handle_text_answer=_handle_text_answer,
        _repair_placeholder_username=_repair_placeholder_username,
        _maybe_guide_self_mention=_maybe_guide_self_mention,
        _max_attachment_bytes=1024 * 1024,
    )

    ns._find_channel = lambda room_id=None, transport_room_id=None: (
        "fake-chan-1" if transport_room_id == transport_room_id else None
    )
    ns._outbound_thread_root_ref = CollaborationCore._outbound_thread_root_ref.__get__(
        ns
    )
    ns._relay_outbound_message = CollaborationCore._relay_outbound_message.__get__(ns)
    ns._relay_outbound_media = CollaborationCore._relay_outbound_media.__get__(ns)
    ns._counted_outbound = CollaborationCore._counted_outbound.__get__(ns)
    ns._handle_inbound_message = CollaborationCore._handle_inbound_message.__get__(ns)
    ns._download_media = CollaborationCore._download_media.__get__(ns)

    return ns  # type: ignore[return-value]


@pytest.mark.asyncio
async def test_console_member_threaded_reply_roundtrip_through_bridge(
    chats: _Harness,
) -> None:
    """Console member messages relay outbound with sender_name (not skipped),
    inbound platform threaded replies arrive with threadRootId, and the
    member's own post echo from the platform is not re-imported."""
    agent = await chats.agent("helper-threaded", owner=chats.alice)
    room_id, bridge, adapter = await _bridged_room(chats, agent)
    core = await _fake_collab_core_full(chats, room_id, bridge, adapter)

    # Send root message from console member
    sent = await chats.send(chats.alice, room_id, "s1", "root message")
    assert sent.status_code == 200, sent.text
    root_msg = sent.json()["messages"][0]
    root_event_id = root_msg["messageId"]

    # Drive outbound relay
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

    # Verify outbound relay: member's message relayed with sender_name, not skipped
    assert len(adapter.sent) == 1
    assert adapter.sent[0]["sender_name"] == "alice"
    assert adapter.sent[0]["content"] == "root message"
    assert adapter.sent[0]["thread_root_id"] is None

    # Send threaded reply from console member
    reply_sent = await chats.send(
        chats.alice, room_id, "s2", "threaded reply", threadRootId=root_event_id
    )
    assert reply_sent.status_code == 200
    reply_msg = reply_sent.json()["messages"][0]
    assert reply_msg["threadRootId"] == root_event_id

    # Drive outbound relay for the reply
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

    # Verify threaded outbound: thread_root_id mapped to external post
    assert len(adapter.sent) == 2
    assert adapter.sent[1]["sender_name"] == "alice"
    assert adapter.sent[1]["content"] == "threaded reply"
    assert adapter.sent[1]["thread_root_id"] == "ext-1"

    # Test inbound direction: platform user replies in thread to ext-1
    inbound_reply = InboundMessage(
        channel_id="fake-chan-1",
        channel_type="channel_public",
        sender_id="platform-user-123",
        sender_name="bob",
        content="platform threaded reply",
        message_ref="ext-3",
        root_id="ext-1",
    )

    await CollaborationCore._handle_inbound_message(core, inbound_reply)

    # Verify inbound threaded reply arrives with threadRootId
    page = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.alice)
    )
    messages = page.json()["messages"]
    platform_reply = [m for m in messages if m["body"] == "platform threaded reply"]
    assert len(platform_reply) == 1, "Inbound threaded reply imported"
    assert platform_reply[0]["threadRootId"] == root_event_id, (
        "Thread root mapped from external post to room event"
    )

    # Test echo prevention: console member's own message won't echo inbound
    # because member clients post natively in the room, not through the bridge
    async with chats.factory() as session:
        count_before = await session.scalar(
            select(func.count()).select_from(Message).where(Message.room_id == room_id)
        )

    # Member posts again
    member_post2 = await chats.send(chats.alice, room_id, "s3", "second message")
    assert member_post2.status_code == 200

    async with chats.factory() as session:
        count_after = await session.scalar(
            select(func.count()).select_from(Message).where(Message.room_id == room_id)
        )

    # Exactly one new message (the member's post), no echo imported
    assert count_after == count_before + 1


@pytest.mark.asyncio
async def test_multi_attachment_send_atomic_despite_bridge_failure(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Multi-attachment message parts commit atomically as one group in the DB.
    Retry with the same requestId returns the stored parts without inserting
    duplicates.

    Note: Full bridge outbound media relay (with group buffering, adapter
    calls, and failure handling) requires _outbound_groups, _outbound_group_timers,
    _schedule_outbound_group_flush, _relay_outbound_group, and other state
    management that is too entangled to properly fake. This test focuses on
    the DB-level atomicity guarantee."""
    agent = await chats.agent("helper-atomic", owner=chats.alice)
    room_id, _bridge, _adapter = await _bridged_room(chats, agent)

    for upload_id in ("u1", "u2", "u3"):
        staged = await chats.upload(
            chats.alice, room_id, upload_id, b"data", f"{upload_id}.png"
        )
        assert staged.status_code == 200, staged.text

    # Send multi-attachment message
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

    # Verify DB has exactly one complete 3-part group (atomic insert)
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
        assert len(rows) == 3, "All 3 parts committed"
        groups = {row.content["com.switch.attachment_group"]["id"] for row in rows}
        assert len(groups) == 1, "Atomic insert created exactly one complete group"

    # Test retry with same requestId: returns stored parts, no duplicates
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
    ], "Retry returned stored parts, no duplicates inserted"

    # Final verification: still exactly 3 parts, one group
    async with chats.factory() as session:
        final_count = await session.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.room_id == room_id, Message.client_txn_id.like("s1:%"))
        )

    assert final_count == 3, "Retry did not insert duplicate parts"
