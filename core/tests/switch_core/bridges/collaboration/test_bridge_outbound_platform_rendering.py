"""A platform message on its way out of Matrix renders as the Switch app, and
says whose authority it carries when it was sent on a person's behalf.

The kickoff a template posts is the case this exists for: the room has to see
that Switch posted it for the creator, not a bare notice from the app and not
a message pretending to be the person.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.transport import InboundMessage, RoomRef

BODY = "@scout kicking off **task-1**."


class _RecordingAdapter:
    def __init__(self) -> None:
        self.admin_calls: list[str] = []
        self.message_calls: list[str] = []

    def translate_outbound(self, content: str) -> str:
        return content

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
        self.admin_calls.append(content)
        return "ref-admin"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        self.message_calls.append(content)
        return "ref-msg"


async def _noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "tenant-1"


def _bridge(adapter: _RecordingAdapter) -> BridgeCore:
    core = object.__new__(BridgeCore)
    core._adapter = adapter  # type: ignore[assignment]
    core._puppet_matrix_ids = set()  # type: ignore[assignment]
    core._bridge_client_matrix_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", "!r:switch.local")}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    core._record_message_map = _noop  # type: ignore[assignment]
    core._move_indicator_for_sender = _noop  # type: ignore[assignment]
    core._outbound_thread_root_ref = _noop  # type: ignore[assignment]
    return core


def _event(marker: dict[str, Any]) -> InboundMessage:
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$e1",
        sender="@switch-admin:switch.local",
        timestamp=1700000000000,
        content={PLATFORM_MARKER: marker},
        body=BODY,
        sender_name=None,
    )


async def test_a_bare_platform_message_renders_as_the_app() -> None:
    adapter = _RecordingAdapter()
    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event({})
    )
    assert adapter.admin_calls == [BODY]
    assert adapter.message_calls == []


async def test_a_message_on_someones_behalf_says_so() -> None:
    adapter = _RecordingAdapter()
    marker = {"on_behalf_of": {"user_id": "user-9", "name": "Abel"}}
    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(marker)
    )
    assert adapter.admin_calls == [f"On behalf of @Abel:\n\n{BODY}"]
    assert adapter.message_calls == []
