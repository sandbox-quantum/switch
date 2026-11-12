"""Slack reports a channel rename as a system line posted into the channel,
on the message subscriptions the app already has. The bridge hands the new
name to the room, never relays the line as chat, and uses the new name for the
channel from then on."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)


def _adapter() -> tuple[SlackAdapter, list[tuple[str, str, str]], list[Any]]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._bot_user_id = "UBOT"
    adapter._channel_name_cache["C123"] = "payments"
    renamed: list[tuple[str, str, str]] = []
    relayed: list[InboundMessage] = []

    async def named(channel_id: str, old: str, new: str) -> None:
        renamed.append((channel_id, old, new))

    async def message(msg: InboundMessage) -> None:
        relayed.append(msg)

    adapter.set_channel_rename_handler(named)
    adapter._on_message = message
    return adapter, renamed, relayed


def _rename_event(subtype: str, channel: str) -> dict[str, Any]:
    return {
        "event": {
            "type": "message",
            "subtype": subtype,
            "channel": channel,
            "user": "U1",
            "old_name": "payments",
            "name": "payments-squad",
            "text": "renamed the channel from “payments” to “payments-squad”",
            "ts": "1731240000.000100",
        }
    }


@pytest.mark.parametrize(
    ("subtype", "channel"),
    [
        ("channel_name", "C123"),
        # A private channel arrives on `message.groups` with the same subtype.
        ("channel_name", "G456"),
        # A private channel from before Slack made them channels.
        ("group_name", "G789"),
    ],
)
async def test_a_rename_reaches_the_room_and_is_not_relayed(
    subtype: str, channel: str
) -> None:
    adapter, renamed, relayed = _adapter()
    await adapter.dispatch_event(
        envelope_type="events_api", payload=_rename_event(subtype, channel)
    )
    assert renamed == [(channel, "payments", "payments-squad")]
    assert relayed == []


async def test_a_channel_link_shows_the_new_name_after_a_rename() -> None:
    adapter, _, _ = _adapter()
    assert adapter.translate_inbound("see <#C123>") == "see #payments"
    await adapter.dispatch_event(
        envelope_type="events_api", payload=_rename_event("channel_name", "C123")
    )
    assert adapter.translate_inbound("see <#C123>") == "see #payments-squad"


async def test_a_rename_without_a_new_name_is_skipped_loudly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, renamed, relayed = _adapter()
    payload = _rename_event("channel_name", "C123")
    del payload["event"]["name"]
    await adapter.dispatch_event(envelope_type="events_api", payload=payload)
    assert renamed == [] and relayed == []
    assert "without a channel or a new name" in caplog.text
