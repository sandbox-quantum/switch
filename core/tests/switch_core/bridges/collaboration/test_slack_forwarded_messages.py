from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)


def _adapter() -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )
    adapter.set_tenant_id("tenant-1")
    return adapter


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _capture_messages(adapter: SlackAdapter) -> list[InboundMessage]:
    captured: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        captured.append(msg)

    adapter._on_message = on_message
    adapter._channel_name_cache["C123"] = "general"
    return captured


def test_forwarded_message_with_comment_appends_attachment_body() -> None:
    """A forwarded message with commentary delivers both comment and original body."""
    adapter = _adapter()
    messages = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "100.1",
        "user": "U1",
        "text": "@sme test attached from you in my onboarding room",
        "channel_type": "channel",
        "blocks": [
            {
                "type": "rich_text",
                "elements": [
                    {
                        "type": "rich_text_section",
                        "elements": [
                            {"type": "text", "text": "@sme test attached from you in my onboarding room"}
                        ],
                    }
                ],
            }
        ],
        "attachments": [
            {
                "is_share": True,
                "author_name": "sme",
                "text": "Here is the architectural overview document.",
            }
        ],
    }

    _run(adapter._handle_message_event(event))

    assert len(messages) == 1
    assert messages[0].content == (
        "@sme test attached from you in my onboarding room\n\n"
        "Here is the architectural overview document."
    )


def test_bare_forward_without_comment_delivers_attachment_body() -> None:
    """A bare forward without any typed commentary delivers the shared message body."""
    adapter = _adapter()
    messages = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "100.2",
        "user": "U1",
        "text": "",
        "channel_type": "channel",
        "attachments": [
            {
                "is_share": True,
                "author_name": "sme",
                "text": "Shared standalone message content.",
            }
        ],
    }

    _run(adapter._handle_message_event(event))

    assert len(messages) == 1
    assert messages[0].content == "Shared standalone message content."


def test_forward_with_text_and_author_name_is_treated_as_share() -> None:
    """Attachments with author_name and text are treated as shared messages."""
    adapter = _adapter()
    messages = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "100.3",
        "user": "U1",
        "text": "FYI from team chat",
        "channel_type": "channel",
        "attachments": [
            {
                "author_name": "alice",
                "text": "Deployment scheduled for 3pm UTC",
            }
        ],
    }

    _run(adapter._handle_message_event(event))

    assert len(messages) == 1
    assert messages[0].content == "FYI from team chat\n\nDeployment scheduled for 3pm UTC"


def test_forward_with_title_and_link_formats_properly() -> None:
    """Share attachments with title and link retain link markdown."""
    adapter = _adapter()
    messages = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "100.4",
        "user": "U1",
        "text": "Look at this reference",
        "channel_type": "channel",
        "attachments": [
            {
                "is_share": True,
                "title": "RFC 42 Specification",
                "title_link": "https://example.com/rfc42",
                "text": "Full text of RFC 42.",
            }
        ],
    }

    _run(adapter._handle_message_event(event))

    assert len(messages) == 1
    assert "<https://example.com/rfc42|RFC 42 Specification>" in messages[0].content
    assert "Full text of RFC 42." in messages[0].content
