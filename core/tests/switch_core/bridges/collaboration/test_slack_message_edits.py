"""Slack's `message_changed` events: a person's edit goes to the edit callback,
and nothing else Slack reports as a change does."""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.models import InboundEdit
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)


def _adapter() -> tuple[SlackAdapter, list[InboundEdit]]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    adapter._user_cache["U1"] = SlackUser(name="alice", display_name="Alice")
    edits: list[InboundEdit] = []

    async def on_edit(edit: InboundEdit) -> None:
        edits.append(edit)

    adapter.set_edit_handler(on_edit)
    return adapter, edits


def _changed(
    text: str,
    *,
    previous: str = "fix the bug in pasre.py",
    user: str = "U1",
    edited: bool = True,
    **message: Any,
) -> dict[str, Any]:
    new: dict[str, Any] = {"type": "message", "user": user, "text": text, "ts": "100.1"}
    if edited:
        new["edited"] = {"user": user, "ts": "105.5"}
    new.update(message)
    return {
        "type": "message",
        "subtype": "message_changed",
        "channel": "C123",
        "hidden": True,
        "message": new,
        "previous_message": {"type": "message", "user": user, "text": previous},
        "event_ts": "105.6",
        "ts": "105.6",
    }


def test_an_edit_reaches_the_edit_callback() -> None:
    adapter, edits = _adapter()
    asyncio.run(adapter._handle_message_event(_changed("fix the bug in parse.py")))
    assert edits == [
        InboundEdit(
            channel_id="C123",
            sender_id="U1",
            sender_name="alice",
            content="fix the bug in parse.py",
            message_ref="C123:100.1",
            revision="105.5",
        )
    ]


def test_a_change_without_an_edit_is_not_one() -> None:
    adapter, edits = _adapter()
    # A link preview added: Slack reports the post changed, nobody edited it.
    asyncio.run(adapter._handle_message_event(_changed("see https://x", edited=False)))
    # Edited stamp, but the same text (an attachment unfurled later).
    asyncio.run(adapter._handle_message_event(_changed("same", previous="same")))
    assert edits == []


def test_app_posts_and_the_bridges_own_posts_are_not_edits() -> None:
    adapter, edits = _adapter()
    asyncio.run(adapter._handle_message_event(_changed("redrawn", bot_id="BSELF")))
    asyncio.run(adapter._handle_message_event(_changed("CI: passed", bot_id="BCI")))
    asyncio.run(adapter._handle_message_event(_changed("mine", user="UBOT")))
    assert edits == []


def test_an_edit_is_not_relayed_as_a_new_message() -> None:
    adapter, _ = _adapter()
    messages: list[object] = []

    async def on_message(msg: object) -> None:
        messages.append(msg)

    adapter._on_message = on_message  # type: ignore[assignment]
    asyncio.run(adapter._handle_message_event(_changed("fix the bug in parse.py")))
    assert messages == []
