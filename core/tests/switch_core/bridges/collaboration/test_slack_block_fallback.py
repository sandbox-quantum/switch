from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)


def refusal(code):
    return SlackApiError(code, {"ok": False, "error": code})


@pytest.fixture
def adapter():
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            workspace_id="workspace-demo", bot_token="", app_token=""
        )
    )
    adapter._web_client = SimpleNamespace(
        chat_postMessage=AsyncMock(return_value={"ts": "2.0"}),
        chat_update=AsyncMock(return_value={"ts": "2.0"}),
        conversations_replies=AsyncMock(),
        conversations_history=AsyncMock(),
    )
    adapter.agent_rendering = AsyncMock(
        return_value=SimpleNamespace(field_label="worker", icon_url=None)
    )
    adapter._bot_user_id = "bot-demo"
    return adapter


BLOCKS = [{"type": "context", "block_id": "switch-request:delivery-demo"}]
TEXT = "Request R42: Run checks. Reply with !answer R42 1."


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["invalid_blocks", "invalid_blocks_format"])
async def test_rejected_blocks_publish_one_threaded_recoverable_text_card(
    adapter, code
):
    client = adapter._web_client
    client.chat_postMessage.side_effect = [refusal(code), {"ts": "2.0"}]

    assert (
        await adapter.post_blocks(
            "channel-demo", "worker", TEXT, BLOCKS, "channel-demo:1.0"
        )
        == "channel-demo:2.0"
    )

    first, fallback = [call.kwargs for call in client.chat_postMessage.call_args_list]
    assert first["blocks"] == BLOCKS
    assert "blocks" not in fallback
    assert fallback["text"] == TEXT
    assert fallback["thread_ts"] == "1.0"
    assert fallback.get("reply_broadcast", False) is False
    assert fallback["unfurl_links"] is False
    assert fallback["metadata"] == first["metadata"]
    # A restart can recover the accepted fallback after its response was lost.
    client.conversations_replies.return_value = {
        "messages": [
            {"ts": "1.5", "user": "other-user", "metadata": fallback["metadata"]},
            {"ts": "2.0", "user": "bot-demo", "metadata": fallback["metadata"]},
        ]
    }
    assert (
        await adapter.find_request_card(
            "channel-demo", "channel-demo:1.0", "delivery-demo", datetime.now(UTC), "R7"
        )
        == "channel-demo:2.0"
    )
    assert client.conversations_replies.call_args.kwargs["include_all_metadata"] is True


@pytest.mark.asyncio
async def test_format_rejected_update_clears_buttons_on_the_same_message(adapter):
    client = adapter._web_client
    client.chat_update.side_effect = [refusal("invalid_blocks"), {"ts": "2.0"}]
    await adapter.update_blocks(
        "channel-demo", "channel-demo:2.0", "Request R42: Answered.", BLOCKS
    )
    original, fallback = [call.kwargs for call in client.chat_update.call_args_list]
    assert fallback["ts"] == original["ts"] == "2.0"
    assert fallback["blocks"] == []
    assert fallback["text"] == "Request R42: Answered."
    assert fallback["metadata"] == original["metadata"]
    client.chat_postMessage.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["ratelimited", "invalid_auth", "missing_scope"])
async def test_definitive_nonformat_post_refusal_does_not_retry_as_text(adapter, code):
    client = adapter._web_client
    client.chat_postMessage.side_effect = refusal(code)
    assert (
        await adapter.post_blocks("channel-demo", "worker", TEXT, BLOCKS, "1.0") is None
    )
    client.chat_postMessage.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error", [refusal("request_timeout"), TimeoutError("lost response")]
)
async def test_uncertain_post_is_not_repeated_as_text(adapter, error):
    client = adapter._web_client
    client.chat_postMessage.side_effect = error
    with pytest.raises(type(error)):
        await adapter.post_blocks("channel-demo", "worker", TEXT, BLOCKS, "1.0")
    client.chat_postMessage.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["ratelimited", "invalid_auth", "request_timeout"])
async def test_nonformat_update_error_propagates_without_a_second_message(
    adapter, code
):
    client = adapter._web_client
    client.chat_update.side_effect = refusal(code)
    with pytest.raises(SlackApiError):
        await adapter.update_blocks("channel-demo", "channel-demo:2.0", TEXT, BLOCKS)
    client.chat_update.assert_called_once()
    client.chat_postMessage.assert_not_called()
