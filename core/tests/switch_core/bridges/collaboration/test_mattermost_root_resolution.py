import asyncio
from unittest.mock import MagicMock

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.session_activity.publisher import _MAX_RETRY_ATTEMPTS, _Backoff


@pytest.fixture
def mm_adapter():
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm.example",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    return adapter


@pytest.mark.asyncio
async def test_post_or_raise_resolves_reply_to_actual_thread_root(mm_adapter):
    mm_adapter._main_loop = asyncio.get_running_loop()
    driver = MagicMock()

    # First create_post call fails with "Invalid RootId parameter"
    # Second create_post call succeeds
    def mock_create_post(post):
        if post.get("root_id") == "reply-post-123":
            raise RuntimeError("Invalid RootId parameter.")
        return {"id": "new-post-456"}

    driver.posts.create_post.side_effect = mock_create_post
    driver.posts.get_post.return_value = {
        "id": "reply-post-123",
        "root_id": "root-post-001",
    }

    post_id = await mm_adapter._post_or_raise(
        driver, "chan-1", "Test message", "reply-post-123", None
    )

    assert post_id == "new-post-456"
    assert driver.posts.get_post.call_count == 1
    driver.posts.get_post.assert_called_with("reply-post-123")
    assert driver.posts.create_post.call_count == 2
    # Second call should have used the resolved root_id
    second_call_post = driver.posts.create_post.call_args_list[1][0][0]
    assert second_call_post["root_id"] == "root-post-001"


@pytest.mark.asyncio
async def test_post_or_raise_re_raises_if_not_resolvable(mm_adapter):
    mm_adapter._main_loop = asyncio.get_running_loop()
    driver = MagicMock()
    driver.posts.create_post.side_effect = RuntimeError("Invalid RootId parameter.")
    driver.posts.get_post.return_value = {"id": "reply-post-123", "root_id": ""}

    with pytest.raises(RuntimeError, match="Invalid RootId parameter"):
        await mm_adapter._post_or_raise(
            driver, "chan-1", "Test message", "reply-post-123", None
        )


def test_publisher_backoff_caps_retries():
    backoff = _Backoff()
    key = ("turn", "agent-1", "session-1", "turn-1")

    delays = []
    for _ in range(_MAX_RETRY_ATTEMPTS):
        d = backoff.next(key)
        assert d is not None
        delays.append(d)

    assert len(delays) == _MAX_RETRY_ATTEMPTS
    assert delays == [5.0, 10.0, 20.0, 40.0, 80.0]

    # The next attempt exceeds _MAX_RETRY_ATTEMPTS and returns None, clearing the backoff
    assert backoff.next(key) is None
    assert key not in backoff.waits
    assert key not in backoff.attempts
