from __future__ import annotations

from types import SimpleNamespace

from nio import RoomSendError

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundCommand


def _cmd(*, message_ref: str | None, root_id: str | None = None) -> InboundCommand:
    return InboundCommand(
        channel_id="chan-1",
        channel_type="channel_private",
        sender_id="ext-user",
        sender_name="louisa",
        command="status",
        args="",
        message_ref=message_ref,
        root_id=root_id,
    )


def _fake_bridge(
    room_send_result: object,
    *,
    external_to_matrix: dict[str, str] | None = None,
) -> SimpleNamespace:
    """A minimal BridgeCore stand-in for _handle_inbound_command.

    `external_to_matrix` seeds the (external post -> Matrix event) lookup so we
    can exercise the "thread root already bridged" branch.
    """
    recorded: list[dict[str, str]] = []
    sent_content: list[dict] = []
    lookup = external_to_matrix or {}

    async def _ensure_user_in_matrix_room(**_kw: object) -> SimpleNamespace:
        async def _room_send(_room_id: str, _type: str, content: dict) -> object:
            sent_content.append(content)
            return room_send_result

        return SimpleNamespace(
            matrix_user_id="@puppet:switch.local",
            client=SimpleNamespace(room_send=_room_send),
        )

    async def _matrix_event_for_external_post(external_post_id: str) -> str | None:
        return lookup.get(external_post_id)

    async def _record_message_map(**kwargs: str) -> None:
        recorded.append(kwargs)

    return SimpleNamespace(
        _channel_to_room={"chan-1": ("room-uuid", "!matrix:switch.local")},
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _matrix_event_for_external_post=_matrix_event_for_external_post,
        _record_message_map=_record_message_map,
        recorded=recorded,
        sent_content=sent_content,
    )


class TestCommandThreadMapping:
    async def test_top_level_command_maps_to_its_own_post(self) -> None:
        # No root_id: the command starts its own thread, rooted at its post.
        bridge = _fake_bridge(SimpleNamespace(event_id="$cmd-event"))
        await BridgeCore._handle_inbound_command(bridge, _cmd(message_ref="mm-post-1"))

        assert bridge.recorded == [
            {
                "external_channel_id": "chan-1",
                "matrix_event_id": "$cmd-event",
                "external_post_id": "mm-post-1",
            }
        ]
        # No thread relation on the command event — it anchors its own thread.
        assert "m.relates_to" not in bridge.sent_content[0]

    async def test_in_thread_command_relates_to_existing_root(self) -> None:
        # Command typed inside a thread whose root post is already bridged: the
        # command event relates to the existing Matrix root, and we do NOT remap
        # the (already-mapped) root post.
        bridge = _fake_bridge(
            SimpleNamespace(event_id="$cmd-event"),
            external_to_matrix={"mm-root": "$matrix-root"},
        )
        await BridgeCore._handle_inbound_command(
            bridge, _cmd(message_ref="mm-reply", root_id="mm-root")
        )

        assert bridge.recorded == []
        assert bridge.sent_content[0]["m.relates_to"] == {
            "rel_type": "m.thread",
            "event_id": "$matrix-root",
        }

    async def test_in_thread_command_maps_root_when_unbridged(self) -> None:
        # Thread root not yet bridged: map the command event to the thread root
        # (a valid Mattermost root post), NOT to the mid-thread command post.
        bridge = _fake_bridge(SimpleNamespace(event_id="$cmd-event"))
        await BridgeCore._handle_inbound_command(
            bridge, _cmd(message_ref="mm-reply", root_id="mm-root")
        )

        assert bridge.recorded == [
            {
                "external_channel_id": "chan-1",
                "matrix_event_id": "$cmd-event",
                "external_post_id": "mm-root",
            }
        ]
        assert "m.relates_to" not in bridge.sent_content[0]

    async def test_no_mapping_without_external_post_ref(self) -> None:
        # Native (non-bridged) command: no external post to thread under.
        bridge = _fake_bridge(SimpleNamespace(event_id="$cmd-event"))
        await BridgeCore._handle_inbound_command(bridge, _cmd(message_ref=None))

        assert bridge.recorded == []

    async def test_no_mapping_when_send_fails(self) -> None:
        err = RoomSendError("boom")
        bridge = _fake_bridge(err)
        await BridgeCore._handle_inbound_command(bridge, _cmd(message_ref="mm-post-1"))

        assert bridge.recorded == []
