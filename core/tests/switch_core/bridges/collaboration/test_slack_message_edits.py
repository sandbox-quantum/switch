"""A person editing a post on Slack is passed on as an edit.

Slack sends `message_changed` for changes nobody typed as well (a link
unfurled, a thread's reply count moving); only an edit carries `edited`. The
bridge's own posts and apps' posts are edited all the time and are not a
person's.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.models import InboundEdit, InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)


def _adapter() -> tuple[SlackAdapter, list[InboundEdit], list[InboundMessage]]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    adapter._user_cache["U1"] = SlackUser(name="ada", display_name="Ada")
    edits: list[InboundEdit] = []
    messages: list[InboundMessage] = []

    async def on_edit(edit: InboundEdit) -> None:
        edits.append(edit)

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    adapter.set_edit_handler(on_edit)
    adapter._on_message = on_message
    return adapter, edits, messages


def _changed(**message: Any) -> dict[str, Any]:
    return {
        "type": "message",
        "subtype": "message_changed",
        "hidden": True,
        "channel": "C123",
        "channel_type": "channel",
        "ts": "1700000005.000200",
        "message": {
            "type": "message",
            "user": "U1",
            "text": "fix the typo in <@U2>'s README",
            "ts": "1700000000.000100",
            "edited": {"user": "U1", "ts": "1700000005.000000"},
            **message,
        },
    }


def _deliver(adapter: SlackAdapter, event: dict[str, Any]) -> None:
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(
            adapter.dispatch_event(envelope_type="events_api", payload={"event": event})
        )
    finally:
        loop.close()


def test_a_persons_edit_is_passed_on() -> None:
    adapter, edits, messages = _adapter()

    _deliver(adapter, _changed())

    assert edits == [
        InboundEdit(
            channel_id="C123",
            sender_id="U1",
            sender_name="ada",
            content="fix the typo in <@U2>'s README",
            message_ref="C123:1700000000.000100",
            root_id=None,
            edited_at=1_700_000_005_000,
        )
    ]
    assert messages == []


def test_an_edit_in_a_thread_names_its_root() -> None:
    adapter, edits, _messages = _adapter()

    _deliver(adapter, _changed(thread_ts="1699999999.000900"))

    [edit] = edits
    assert edit.root_id == "C123:1699999999.000900"


def test_a_change_nobody_typed_is_not_an_edit() -> None:
    """An unfurl or a thread's reply count arrives without `edited`."""
    adapter, edits, messages = _adapter()

    _deliver(adapter, _changed(edited=None, reply_count=3))

    assert edits == []
    assert messages == []


def test_the_bridges_own_posts_are_not_passed_on() -> None:
    adapter, edits, _messages = _adapter()

    _deliver(adapter, _changed(user="UBOT"))
    _deliver(adapter, _changed(user="", bot_id="BSELF"))

    assert edits == []


def test_an_apps_post_is_not_a_persons_edit() -> None:
    adapter, edits, _messages = _adapter()

    _deliver(adapter, _changed(user="", bot_id="BDATADOG"))

    assert edits == []
