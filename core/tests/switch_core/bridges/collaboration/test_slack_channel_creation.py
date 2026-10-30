"""Channel creation retries collisions, and reports other Slack refusals."""

from unittest.mock import AsyncMock

import pytest
from slack_sdk.errors import SlackApiError
from slack_sdk.web.async_client import AsyncWebClient

from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)


@pytest.fixture
def slack() -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="workspace-test"
        )
    )
    adapter._web_client = AsyncMock(spec=AsyncWebClient)
    adapter._web_client.conversations_create.return_value = {
        "channel": {"id": "channel-test"}
    }
    return adapter


async def _create(slack: SlackAdapter, kind: str) -> str:
    if kind == "direct":
        return await slack.create_dm_channel(
            agent_name="agent", user_name="user", user_external_id="user-test"
        )
    return await slack.create_channel(
        "Engineering",
        "Topic",
        channel_type=kind,  # type: ignore[arg-type]
    )


def _error(reason: str) -> SlackApiError:
    return SlackApiError("Slack refused the request", response={"error": reason})


@pytest.mark.parametrize("kind", ["channel_public", "channel_private", "direct"])
async def test_success_creates_once(slack, kind):
    assert await _create(slack, kind) == "channel-test"
    client = slack._web_client
    client.conversations_create.assert_awaited_once_with(
        name="dm-user-agent" if kind == "direct" else "engineering",
        is_private=kind != "channel_public",
    )
    if kind == "direct":
        client.conversations_invite.assert_awaited_once_with(
            channel="channel-test", users="user-test"
        )
    else:
        client.conversations_setTopic.assert_awaited_once_with(
            channel="channel-test", topic="Topic"
        )


@pytest.mark.parametrize("kind", ["channel_public", "channel_private", "direct"])
async def test_name_collision_retries_with_a_new_name(slack, kind):
    client = slack._web_client
    client.conversations_create.side_effect = [
        _error("name_taken"),
        {"channel": {"id": "channel-test"}},
    ]
    assert await _create(slack, kind) == "channel-test"
    first, second = client.conversations_create.await_args_list
    assert second.kwargs["name"].startswith(first.kwargs["name"] + "-")
    assert second.kwargs["name"] != first.kwargs["name"]
    assert len(second.kwargs["name"]) <= 80
    assert second.kwargs["is_private"] == first.kwargs["is_private"]


@pytest.mark.parametrize("kind", ["channel_public", "channel_private", "direct"])
@pytest.mark.parametrize(
    "reason",
    [
        "missing_scope",
        "restricted_action",
        "not_allowed_token_type",
        "ratelimited",
        "invalid_name_specials",
    ],
)
async def test_non_collision_is_not_retried(slack, kind, reason):
    client = slack._web_client
    refusal = _error(reason)
    client.conversations_create.side_effect = refusal
    with pytest.raises(BridgeOperationError, match=reason) as caught:
        await _create(slack, kind)
    assert caught.value.__cause__ is refusal
    client.conversations_create.assert_awaited_once()
    client.conversations_invite.assert_not_awaited()
    client.conversations_setTopic.assert_not_awaited()


@pytest.mark.parametrize("kind", ["channel_public", "channel_private", "direct"])
@pytest.mark.parametrize("reason", ["name_taken", "missing_scope", "ratelimited"])
async def test_retry_failure_reports_the_final_reason(slack, kind, reason):
    client = slack._web_client
    final_refusal = _error(reason)
    client.conversations_create.side_effect = [_error("name_taken"), final_refusal]
    with pytest.raises(BridgeOperationError, match=reason) as caught:
        await _create(slack, kind)
    assert caught.value.__cause__ is final_refusal
    assert client.conversations_create.await_count == 2
    client.conversations_invite.assert_not_awaited()
    client.conversations_setTopic.assert_not_awaited()


async def test_programming_errors_are_not_reported_as_slack_refusals(slack):
    slack._web_client.conversations_create.return_value = {}
    with pytest.raises(KeyError):
        await _create(slack, "channel_public")
