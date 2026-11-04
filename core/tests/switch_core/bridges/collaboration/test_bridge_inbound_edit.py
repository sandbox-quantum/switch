from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.db.models import Message


class _FakeHumanActor:
    client_id = "human-actor-client"
    transport_user_id = "@human:s"

    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []

    async def send_event(
        self, transport_room_id: str, event_type: str, content: dict[str, Any]
    ) -> str:
        self.events.append((transport_room_id, event_type, content))
        return "$edit-event-id"


class _FakeAdapter:
    def translate_inbound(self, content: str) -> str:
        return content


class _FakeQueryResult:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any:
        return self._value


class _FakeSession:
    def __init__(self, original_row: Any) -> None:
        self.original_row = original_row

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass

    async def execute(self, _query: Any) -> _FakeQueryResult:
        return _FakeQueryResult(self.original_row)


def _fake_bridge(
    original_row: Any = None, original_event_id: str | None = "$orig-1"
) -> SimpleNamespace:
    human_actor = _FakeHumanActor()

    async def _ensure_human_in_room(**_kwargs: Any) -> _FakeHumanActor:
        return human_actor

    async def _repair_placeholder_username(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _event_for_external_post(_post_id: str) -> str | None:
        return original_event_id

    def session_factory() -> _FakeSession:
        return _FakeSession(original_row)

    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _handle_text_answer(_msg: InboundMessage) -> None:
        return None

    ns = SimpleNamespace(
        _bridge_tenant_id="tenant-1",
        _bridge_id="bridge-1",
        _handle_text_answer=_handle_text_answer,
        _repair_placeholder_username=_repair_placeholder_username,
        _adapter=_FakeAdapter(),
        _channel_to_room={"chan-1": ("room-1", "!room:s")},
        _is_registered_agent=_is_registered_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _event_for_external_post=_event_for_external_post,
        _session_factory=session_factory,
        human_actor=human_actor,
    )
    ns._handle_inbound_edit = CollaborationCore._handle_inbound_edit.__get__(ns)
    return ns


def _edit_message() -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="U1",
        sender_name="alice",
        content="corrected message",
        message_ref="chan-1:100.1",
        edit_revision=123456789,
    )


async def test_inbound_edit_sends_message_edit_when_sender_matches() -> None:
    original = Message(
        tenant_id="tenant-1",
        room_id="room-1",
        transport_event_id="$orig-1",
        sender_id="human-actor-client",
        event_type="m.room.message",
        body="original message",
        content={"body": "original message"},
    )
    bridge = _fake_bridge(original_row=original, original_event_id="$orig-1")

    await CollaborationCore._handle_inbound_message(bridge, _edit_message())

    assert len(bridge.human_actor.events) == 1
    room_id, event_type, content = bridge.human_actor.events[0]
    assert room_id == "!room:s"
    assert event_type == "com.switch.message_edit"
    assert content["m.relates_to"] == {"rel_type": "m.replace", "event_id": "$orig-1"}
    assert content["m.new_content"] == {"body": "corrected message"}
    assert content["revision"] == 123456789


async def test_inbound_edit_rejected_when_editor_mismatches_original_sender() -> None:
    # Different sender wrote the original message (e.g. an admin editing another user's post)
    original = Message(
        tenant_id="tenant-1",
        room_id="room-1",
        transport_event_id="$orig-1",
        sender_id="someone-else-client",
        event_type="m.room.message",
        body="original message",
        content={"body": "original message"},
    )
    bridge = _fake_bridge(original_row=original, original_event_id="$orig-1")

    await CollaborationCore._handle_inbound_message(bridge, _edit_message())

    assert bridge.human_actor.events == []


async def test_inbound_edit_ignored_when_original_not_found() -> None:
    bridge = _fake_bridge(original_row=None, original_event_id=None)

    await CollaborationCore._handle_inbound_message(bridge, _edit_message())

    assert bridge.human_actor.events == []
