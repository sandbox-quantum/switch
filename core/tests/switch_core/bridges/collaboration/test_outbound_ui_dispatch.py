"""An agent message carrying a card goes out through `send_ui_message`, with
the same text `send_message` would have posted as its fallback. A card that
does not parse once it has crossed the transport, or that the platform refused
before posting it, is reported and the text is posted instead. Any other
failure may have left the card posted, so it takes the path a plain send's
failure takes and the text is never posted after it."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CardRejectedError
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.transport import InboundMessage, RoomRef
from switch_core.ui_spec import UI_CONTENT_KEY, UISpec, parse_ui_spec
from tests.switch_core.bridges.collaboration.outbound_fakes import (
    posting_without_a_database,
)

_CARD = {
    "root": "c",
    "elements": {"c": {"type": "Card", "props": {"title": "Status"}, "children": []}},
}


class _Adapter:
    def __init__(self, ui_error: Exception | None = None) -> None:
        self.ui_error = ui_error
        self.sent: list[str] = []
        self.ui_sent: list[tuple[UISpec, str]] = []

    def translate_outbound(self, content: str) -> str:
        return f"<{content}>"

    def render_room_wide_mention(self, body: str) -> str:
        return body

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        self.sent.append(content)
        return "text-ref"

    async def send_ui_message(
        self,
        channel_id: str,
        sender_name: str,
        spec: UISpec,
        fallback_text: str,
        thread_root_id: str | None,
        *,
        room_wide_mention: bool,
    ) -> str | None:
        self.ui_sent.append((spec, fallback_text))
        if self.ui_error is not None:
            raise self.ui_error
        return "card-ref"


async def _noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "tenant-1"


def _bridge(adapter: _Adapter) -> tuple[CollaborationCore, list[dict[str, str]]]:
    core = object.__new__(CollaborationCore)
    core._bridge_type = "slack"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[assignment]
    core._human_user_ids = set()  # type: ignore[assignment]
    core._workspace_consumer_transport_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", "!r:switch.local")}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    recorded = posting_without_a_database(core)
    core._move_indicator_for_sender = _noop  # type: ignore[assignment]
    core._outbound_thread_root_ref = _noop  # type: ignore[assignment]
    return core, recorded


async def _relay(
    adapter: _Adapter, content: dict[str, Any], released: list[str]
) -> list[dict[str, str]]:
    core, recorded = _bridge(adapter)
    release = core._release_outbound

    async def recording_release(transport_event_id: str) -> None:
        released.append(transport_event_id)
        await release(transport_event_id)

    core._release_outbound = recording_release  # type: ignore[method-assign]
    await core.handle_outbound_message(
        RoomRef("!r:switch.local"),
        InboundMessage(
            room_id="!r:switch.local",
            event_id="$e1",
            sender="@switch-agent-scout:switch.local",
            timestamp=1700000000000,
            content={"body": "hi", **content},
            body="hi",
            sender_name="scout",
        ),
    )
    return recorded


async def test_a_card_goes_through_send_ui_message() -> None:
    adapter = _Adapter()

    recorded = await _relay(adapter, {UI_CONTENT_KEY: _CARD}, [])

    assert adapter.ui_sent == [(parse_ui_spec(_CARD), "<hi>")]
    assert adapter.sent == []
    assert recorded[0]["external_post_id"] == "card-ref"


async def test_no_card_goes_through_send_message() -> None:
    adapter = _Adapter()

    await _relay(adapter, {}, [])

    assert adapter.sent == ["<hi>"]
    assert adapter.ui_sent == []


async def test_an_invalid_card_falls_back_to_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _Adapter()

    recorded = await _relay(adapter, {UI_CONTENT_KEY: {"root": "c"}}, [])

    assert adapter.sent == ["<hi>"]
    assert adapter.ui_sent == []
    assert recorded[0]["external_post_id"] == "text-ref"
    assert "card on $e1 was not posted" in caplog.text


async def test_a_card_the_platform_refused_falls_back_to_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _Adapter(ui_error=CardRejectedError("invalid_blocks"))

    recorded = await _relay(adapter, {UI_CONTENT_KEY: _CARD}, [])

    assert adapter.sent == ["<hi>"]
    assert recorded[0]["external_post_id"] == "text-ref"
    assert "card on $e1 was not posted" in caplog.text
    assert "invalid_blocks" in caplog.text


async def test_a_card_whose_answer_was_lost_is_not_posted_again_as_text() -> None:
    """The platform may have posted it, so this is a plain send's failure: the
    claim is let go and the error raised, and no text follows."""
    adapter = _Adapter(ui_error=TimeoutError("no response"))
    released: list[str] = []

    with pytest.raises(TimeoutError):
        await _relay(adapter, {UI_CONTENT_KEY: _CARD}, released)

    assert len(adapter.ui_sent) == 1
    assert adapter.sent == []
    assert released == ["$e1"]
