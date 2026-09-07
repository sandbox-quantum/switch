"""Who renders an admin/system message on its way out of Matrix.

`admin_message` takes Switch Markdown and renders it itself, because most of
its callers are notices composed in `bridge_core` with no adapter in reach. The
relay path here has to respect that and pass the body unrendered.

It did not, and the two halves each did the conversion: a `!list-agents` reply
reached Telegram reading `&lt;b&gt;Agents in this room:&lt;/b&gt;`, because the
second pass escaped the markup the first one had produced. Nothing covered the
relay path at the time, so nothing caught it.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.bridge_core import ADMIN_MARKER, BridgeCore
from switch_core.transport import InboundMessage, RoomRef

BODY = "**Agents in this room:**\n- **scout** — Claude Code"


class _RecordingAdapter:
    """Records what each send path was handed, and renders like a real adapter.

    `translate_outbound` escapes first, exactly as the HTML-producing adapters
    do, so a body run through it twice comes back with visible entities — which
    is what makes the double conversion detectable here rather than merely
    counted.
    """

    def __init__(self) -> None:
        self.admin_calls: list[str] = []
        self.message_calls: list[str] = []

    def translate_outbound(self, content: str) -> str:
        escaped = (
            content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        out, parts = "", escaped.split("**")
        for index, part in enumerate(parts):
            out += part if index % 2 == 0 else f"<b>{part}</b>"
        return out

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


def _bridge(adapter: _RecordingAdapter) -> BridgeCore:
    core = object.__new__(BridgeCore)
    core._adapter = adapter  # type: ignore[assignment]
    core._puppet_matrix_ids = set()  # type: ignore[assignment]
    core._bridge_client_matrix_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._record_message_map = _noop  # type: ignore[assignment]
    core._move_indicator_for_sender = _noop  # type: ignore[assignment]
    core._outbound_thread_root_ref = _none  # type: ignore[assignment]
    return core


async def _noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _none(*_args: Any, **_kwargs: Any) -> None:
    return None


def _event(*, admin: bool) -> InboundMessage:
    content: dict[str, Any] = {}
    if admin:
        content[ADMIN_MARKER] = {"type": "command_result"}
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$e1",
        sender="@someone:switch.local",
        timestamp=1700000000000,
        content=content,
        body=BODY,
        sender_name=None if admin else "scout",
    )


async def test_an_admin_event_reaches_the_adapter_unrendered() -> None:
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(admin=True)
    )

    # Handed on as written, for admin_message to render once.
    assert adapter.admin_calls == [BODY]
    assert adapter.message_calls == []


async def test_an_admin_event_is_not_rendered_twice() -> None:
    # The failure this file exists for, stated as its symptom: whatever the
    # adapter renders must not contain escaped tags.
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(admin=True)
    )

    rendered = adapter.translate_outbound(adapter.admin_calls[0])
    assert "<b>Agents in this room:</b>" in rendered
    assert "&lt;b&gt;" not in rendered


async def test_an_agent_message_is_still_rendered_by_the_relay() -> None:
    # The other half of the contract, and the reason this is not simply
    # "never render in the relay": send_message takes rendered content.
    adapter = _RecordingAdapter()

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event(admin=False)
    )

    assert adapter.admin_calls == []
    assert adapter.message_calls == [
        "<b>Agents in this room:</b>\n- <b>scout</b> — Claude Code"
    ]
