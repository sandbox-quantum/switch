"""Which puppet messages the outbound relay forwards to the platform.

A puppet's message normally came FROM the platform, so relaying it back would
duplicate it — the relay skips puppet senders for that reason. `post_as_user`
(the template-kickoff path) is the exception: it sends on a person's behalf
from the Switch side, stamps `SWITCH_ORIGINATED_MARKER` on the event, and the
platform must receive it or the person's own channel never shows what was
posted in their name.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.bridge_core import (
    SWITCH_ORIGINATED_MARKER,
    BridgeCore,
)
from switch_core.transport import InboundMessage, RoomRef

PUPPET = "@switch-slack-b1-abel-dantas:switch.local"


class _RecordingAdapter:
    def __init__(self) -> None:
        self.message_calls: list[tuple[str, str]] = []

    def translate_outbound(self, content: str) -> str:
        return content

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        self.message_calls.append((sender_name, content))
        return "ref-msg"


def _bridge(adapter: _RecordingAdapter) -> BridgeCore:
    core = object.__new__(BridgeCore)
    core._adapter = adapter  # type: ignore[assignment]
    core._puppet_matrix_ids = {PUPPET}  # type: ignore[assignment]
    core._bridge_client_matrix_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", "!r:switch.local")}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    core._record_message_map = _noop  # type: ignore[assignment]
    core._move_indicator_for_sender = _noop  # type: ignore[assignment]
    core._outbound_thread_root_ref = _none  # type: ignore[assignment]
    return core


async def _noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _none(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "00000000-0000-0000-0000-000000000000"


def _puppet_event(*, switch_originated: bool) -> InboundMessage:
    content: dict[str, Any] = {}
    if switch_originated:
        content[SWITCH_ORIGINATED_MARKER] = True
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$e1",
        sender=PUPPET,
        timestamp=1700000000000,
        content=content,
        body="@coder start on the brief.",
        sender_name="abel.dantas",
    )


async def test_platform_originated_puppet_message_is_not_echoed_back() -> None:
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _puppet_event(switch_originated=False)
    )

    assert adapter.message_calls == []


async def test_switch_originated_puppet_message_reaches_the_platform() -> None:
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _puppet_event(switch_originated=True)
    )

    assert adapter.message_calls == [("abel.dantas", "@coder start on the brief.")]
