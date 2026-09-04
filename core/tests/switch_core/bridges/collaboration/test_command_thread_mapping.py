from __future__ import annotations

from types import MethodType, SimpleNamespace

from nio import RoomSendError

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundCommand


def _cmd(
    *,
    message_ref: str | None,
    root_id: str | None = None,
    command: str = "status",
    args: str = "",
) -> InboundCommand:
    return InboundCommand(
        channel_id="chan-1",
        channel_type="channel_private",
        sender_id="ext-user",
        sender_name="louisa",
        command=command,
        args=args,
        message_ref=message_ref,
        root_id=root_id,
    )


def _fake_bridge(
    room_send_result: object,
    *,
    external_to_matrix: dict[str, str] | None = None,
    translate_inbound: object = None,
) -> SimpleNamespace:
    """A minimal BridgeCore stand-in for _handle_inbound_command.

    `external_to_matrix` seeds the (external post -> Matrix event) lookup so we
    can exercise the "thread root already bridged" branch.
    """
    recorded: list[dict[str, str]] = []
    sent_content: list[dict] = []
    pending: dict[str, str] = {}
    lookup = external_to_matrix or {}
    translate = translate_inbound or (lambda raw: raw)

    def _prerecord_message_map(matrix_event_id: str, external_post_id: str) -> None:
        pending[matrix_event_id] = external_post_id

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
        _adapter=SimpleNamespace(translate_inbound=translate),
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _matrix_event_for_external_post=_matrix_event_for_external_post,
        _record_message_map=_record_message_map,
        _prerecord_message_map=_prerecord_message_map,
        _pending_message_maps=pending,
        recorded=recorded,
        sent_content=sent_content,
        pending=pending,
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

    async def test_command_args_translated_via_adapter(self) -> None:
        # A `!command`'s args reach the funnel with the bridge's native mention
        # markup — an agent picked from Slack autocomplete arrives as its group
        # tag `<!subteam^S…>`, not `@name`. The funnel must run args through the
        # adapter's inbound translation (as slash commands already do) so the
        # dispatcher's first-@token targeting resolves the agent. Regression for
        # `!invite-agent @agent` failing while `/invite-agent` worked.
        bridge = _fake_bridge(
            SimpleNamespace(event_id="$cmd-event"),
            translate_inbound=lambda raw: raw.replace(
                "<!subteam^S123>", "@switch-onboarder"
            ),
        )
        await BridgeCore._handle_inbound_command(
            bridge,
            _cmd(
                message_ref="mm-post-1",
                command="invite-agent",
                args="<!subteam^S123>",
            ),
        )

        assert bridge.sent_content[0]["args"] == "@switch-onboarder"


class TestCommandResultThreadingRace:
    async def test_external_post_prefers_pending_anchor_over_db(self) -> None:
        # While the durable row is still being written, the in-memory anchor must
        # resolve without touching the DB. The store raises to prove the DB is
        # not consulted on a pending hit.
        def _boom(*_a: object, **_k: object) -> object:
            raise AssertionError("DB consulted despite a pending anchor")

        bridge = SimpleNamespace(
            _pending_message_maps={"$cmd-event": "chan-1:100.1"},
            _bridge_id="b",
            _bridge_message_map_store=SimpleNamespace(get_by_matrix_event_id=_boom),
            _session_factory=_boom,
        )
        got = await BridgeCore._external_post_for_matrix_event(bridge, "$cmd-event")
        assert got == "chan-1:100.1"

    async def test_top_level_command_result_threads_during_db_write(self) -> None:
        # Regression for the intermittent root-posting of fast system commands
        # (the !help screenshot): the reply is relayed WHILE _record_message_map
        # is still awaiting its write. The anchor set before that await must
        # resolve the command's thread root, and is popped once the write returns.
        resolved: dict[str, str | None] = {}

        async def _ensure_user_in_matrix_room(**_kw: object) -> SimpleNamespace:
            async def _room_send(_room_id: str, _type: str, _content: dict) -> object:
                return SimpleNamespace(event_id="$cmd-event")

            return SimpleNamespace(
                matrix_user_id="@puppet:switch.local",
                client=SimpleNamespace(room_send=_room_send),
            )

        async def _matrix_event_for_external_post(_post: str) -> str | None:
            return None  # top-level command: its own post is not yet bridged

        async def _get_none(*_a: object, **_k: object) -> None:
            return None

        class _NullSession:
            async def __aenter__(self) -> object:
                return object()

            async def __aexit__(self, *_a: object) -> bool:
                return False

        bridge = SimpleNamespace(
            _channel_to_room={"chan-1": ("room-uuid", "!matrix:switch.local")},
            _adapter=SimpleNamespace(translate_inbound=lambda s: s),
            _pending_message_maps={},
            _bridge_id="b",
            _bridge_message_map_store=SimpleNamespace(get_by_matrix_event_id=_get_none),
            _session_factory=lambda: _NullSession(),
            _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
            _matrix_event_for_external_post=_matrix_event_for_external_post,
        )
        bridge._prerecord_message_map = MethodType(
            BridgeCore._prerecord_message_map, bridge
        )
        bridge._external_post_for_matrix_event = MethodType(
            BridgeCore._external_post_for_matrix_event, bridge
        )

        async def _record_message_map(
            *, external_channel_id: str, matrix_event_id: str, external_post_id: str
        ) -> None:
            # Simulate the reply's outbound relay resolving the thread root while
            # this write is still in flight.
            resolved["mid"] = await bridge._external_post_for_matrix_event(
                matrix_event_id
            )

        bridge._record_message_map = _record_message_map

        await BridgeCore._handle_inbound_command(
            bridge, _cmd(message_ref="chan-1:100.1", command="help")
        )

        # Mid-write the anchor resolved to the command post (threads under it)...
        assert resolved["mid"] == "chan-1:100.1"
        # ...and it is cleared once the write returns...
        assert bridge._pending_message_maps == {}
        # ...after which resolution falls through to the DB (empty here).
        assert await bridge._external_post_for_matrix_event("$cmd-event") is None
