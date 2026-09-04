"""A directly-created thread must keep threading past its first reply.

Discord's "Create Thread" flow (not "reply in thread" on an existing message)
mints a thread whose channel id is unrelated to any message id. `msg.root_id`
then carries that thread id, never a message id — so recording the
correlation under the message's own ref (as `_handle_inbound_message` used
to) can never be looked up again by `_matrix_event_for_external_post`, which
keys on `root_id`. `_handle_inbound_command` already anchors on
`root_id or message_ref`; these pin the same anchor for the message path.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundMessage


class _FakePuppet:
    matrix_user_id = "@puppet:s"

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self._next_event = 0

    async def send_message(
        self, matrix_room_id, content, format=None, thread_root_id=None
    ):  # noqa: ANN001, ANN201, A002
        self.messages.append({"content": content, "thread_root_id": thread_root_id})
        event_id = f"$evt-{self._next_event}"
        self._next_event += 1
        return event_id


class _FakeAdapter:
    def translate_inbound(self, content: str) -> str:
        return content


def _fake_bridge(*, matrix_events: dict[str, str]) -> SimpleNamespace:
    """`matrix_events` maps external post id -> already-bridged Matrix event id."""
    puppet = _FakePuppet()
    recorded: list[dict[str, str]] = []

    async def _is_registered_agent(_name: str) -> bool:
        return False

    async def _ensure_user_in_matrix_room(**_kwargs: Any) -> _FakePuppet:
        return puppet

    async def _repair_placeholder_username(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _matrix_event_for_external_post(post_id: str) -> str | None:
        return matrix_events.get(post_id)

    async def _record_message_map(**kwargs: str) -> None:
        recorded.append(kwargs)
        # A real store: recording makes the post resolvable on the next lookup.
        matrix_events[kwargs["external_post_id"]] = kwargs["matrix_event_id"]

    return SimpleNamespace(
        _repair_placeholder_username=_repair_placeholder_username,
        _adapter=_FakeAdapter(),
        _channel_to_room={"chan-1": ("room-1", "!room:s")},
        _is_registered_agent=_is_registered_agent,
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _matrix_event_for_external_post=_matrix_event_for_external_post,
        _record_message_map=_record_message_map,
        puppet=puppet,
        recorded=recorded,
    )


def _msg(
    *, message_ref: str, root_id: str | None, content: str = "hi"
) -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="U1",
        sender_name="alice",
        content=content,
        message_ref=message_ref,
        root_id=root_id,
    )


async def test_directly_created_thread_second_reply_still_threads() -> None:
    # thread id shares no id with any message — the direct-create case.
    thread_id = "thread-999"
    bridge = _fake_bridge(matrix_events={})

    # First reply into the thread: no Matrix event mapped for it yet, so it
    # posts top-level, but the anchor recorded must be the THREAD id (root_id)
    # so the next reply can find it — not this message's own ref.
    await BridgeCore._handle_inbound_message(
        bridge, _msg(message_ref="post-1", root_id=thread_id, content="first")
    )
    assert bridge.puppet.messages[0]["thread_root_id"] is None
    assert bridge.recorded == [
        {
            "external_channel_id": "chan-1",
            "matrix_event_id": "$evt-0",
            "external_post_id": thread_id,
        }
    ]

    # Second reply into the SAME thread now resolves, because the anchor was
    # the thread id, not the first message's own ref.
    await BridgeCore._handle_inbound_message(
        bridge, _msg(message_ref="post-2", root_id=thread_id, content="second")
    )
    assert bridge.puppet.messages[1]["thread_root_id"] == "$evt-0"
    # Anchor already resolved: no re-recording (would just shadow the first).
    assert len(bridge.recorded) == 1


async def test_top_level_message_still_anchors_on_its_own_ref() -> None:
    bridge = _fake_bridge(matrix_events={})

    await BridgeCore._handle_inbound_message(
        bridge, _msg(message_ref="post-1", root_id=None, content="top level")
    )

    assert bridge.recorded == [
        {
            "external_channel_id": "chan-1",
            "matrix_event_id": "$evt-0",
            "external_post_id": "post-1",
        }
    ]
