"""Mattermost splits a message longer than the server's `MaxPostSize`.

Mattermost refuses a longer post with a 400, so an unsplit agent reply never
reached the channel. The limit is the server's own, read from its client
config, because current installs accept four times the old default.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest
from mattermostdriver.exceptions import InvalidOrMissingParameters

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


class _FakePosts:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.patched: list[tuple[str, dict[str, Any]]] = []
        self.refuse_from: int | None = None
        self.limit: int | None = None

    def create_post(self, post: dict[str, Any]) -> dict[str, str]:
        if self.limit is not None and len(post["message"]) > self.limit:
            raise InvalidOrMissingParameters("model.post.is_valid.message_length")
        if self.refuse_from is not None and len(self.created) >= self.refuse_from:
            if not post["message"].startswith("_Only "):
                raise InvalidOrMissingParameters("refused")
        self.created.append(post)
        return {"id": f"post-{len(self.created)}"}

    def patch_post(self, post_id: str, body: dict[str, Any]) -> dict[str, str]:
        self.patched.append((post_id, body))
        return {"id": post_id}


class _Response:
    def __init__(self, body: Any) -> None:
        self._body = body

    def json(self) -> Any:
        return self._body


class _FakeClient:
    def __init__(self, client_config: dict[str, Any] | Exception) -> None:
        self.client_config = client_config
        self.requests: list[tuple[str, str]] = []

    def make_request(
        self, method: str, endpoint: str, options: Any = None
    ) -> _Response:
        self.requests.append((method, endpoint))
        if isinstance(self.client_config, Exception):
            raise self.client_config
        return _Response(self.client_config)


class _FakeDriver:
    def __init__(self, posts: _FakePosts, client: _FakeClient) -> None:
        self.posts = posts
        self.client = client


def _adapter(
    client_config: dict[str, Any] | Exception,
) -> tuple[MattermostAdapter, _FakePosts, _FakeClient]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    posts = _FakePosts()
    client = _FakeClient(client_config)
    adapter._bot_drivers["worker"] = _FakeDriver(posts, client)  # type: ignore[assignment]
    adapter._admin_driver = _FakeDriver(posts, client)  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_event_loop()
    return adapter, posts, client


def _paragraphs(total: int) -> str:
    line = "word " * 19 + "end"
    return "\n".join(line for _ in range(total // (len(line) + 1) + 1))


async def test_a_long_message_is_posted_in_parts_in_the_thread() -> None:
    adapter, posts, _ = _adapter({"MaxPostSize": "16383"})
    posts.limit = 16383
    body = _paragraphs(40_000)

    first = await adapter.send_message("chan", "worker", body, "root-1")

    assert len(posts.created) == 3
    assert all(len(p["message"]) <= 16383 for p in posts.created)
    assert all(p["root_id"] == "root-1" for p in posts.created)
    assert all(p["channel_id"] == "chan" for p in posts.created)
    assert "\n".join(p["message"] for p in posts.created) == body
    assert first == "post-1"


async def test_parts_outside_a_thread_are_posted_to_the_channel() -> None:
    adapter, posts, _ = _adapter({"MaxPostSize": "4000"})
    body = _paragraphs(9_000)

    first = await adapter.send_message("chan", "worker", body)

    assert len(posts.created) == 3
    assert all("root_id" not in p for p in posts.created)
    assert first == "post-1"


async def test_a_code_block_stays_balanced_across_parts() -> None:
    adapter, posts, _ = _adapter({"MaxPostSize": "4000"})
    code = "\n".join(f"value_{i} = {i}" for i in range(600))
    body = f"Here:\n```python\n{code}\n```\nDone."

    await adapter.send_message("chan", "worker", body, "root-1")

    assert len(posts.created) > 1
    for post in posts.created:
        assert post["message"].count("```") % 2 == 0
    assert posts.created[1]["message"].startswith("```python")


async def test_a_short_message_is_one_post_and_does_not_read_the_config() -> None:
    adapter, posts, client = _adapter({"MaxPostSize": "16383"})

    first = await adapter.send_message("chan", "worker", "hello", "root-1")

    assert [p["message"] for p in posts.created] == ["hello"]
    assert first == "post-1"
    assert client.requests == []


async def test_the_server_limit_is_read_once_from_the_client_config() -> None:
    adapter, posts, client = _adapter({"MaxPostSize": "16383"})
    body = _paragraphs(10_000)

    await adapter.send_message("chan", "worker", body)
    await adapter.send_message("chan", "worker", body)

    # 10,000 characters fit one post on this server.
    assert len(posts.created) == 2
    assert client.requests == [("get", "/config/client?format=old")]


@pytest.mark.parametrize(
    "client_config",
    [
        RuntimeError("connection reset"),
        {"Version": "9.0.0"},
        {"MaxPostSize": "not a number"},
        {"MaxPostSize": "0"},
    ],
)
async def test_an_unknown_limit_falls_back_to_the_default_and_says_so(
    client_config: dict[str, Any] | Exception, caplog: pytest.LogCaptureFixture
) -> None:
    adapter, posts, client = _adapter(client_config)
    body = _paragraphs(9_000)

    with caplog.at_level(logging.WARNING):
        await adapter.send_message("chan", "worker", body)
        await adapter.send_message("chan", "worker", body)

    assert len(posts.created) == 6
    assert all(len(p["message"]) <= 4000 for p in posts.created)
    assert "MaxPostSize" in caplog.text
    assert len(client.requests) == 1


async def test_a_part_refused_mid_message_is_disclosed() -> None:
    adapter, posts, _ = _adapter({"MaxPostSize": "4000"})
    posts.refuse_from = 1
    body = _paragraphs(9_000)

    first = await adapter.send_message("chan", "worker", body, "root-1")

    assert first == "post-1"
    assert len(posts.created) == 2
    assert posts.created[1]["message"].startswith("_Only 1 of 3 parts")
    assert posts.created[1]["root_id"] == "root-1"


async def test_admin_messages_are_split_too() -> None:
    adapter, posts, _ = _adapter({"MaxPostSize": "4000"})
    adapter._admin_bot_driver = adapter._admin_driver
    adapter._admin_bot_id = "admin-bot"

    async def channel_type(channel_id: str) -> str:
        return "public"

    async def in_channel(channel_id: str) -> None:
        return None

    adapter.get_channel_type = channel_type  # type: ignore[method-assign,assignment]
    adapter._ensure_admin_bot_in_channel = in_channel  # type: ignore[method-assign]

    first = await adapter.admin_message("chan", _paragraphs(9_000), "root-1")

    assert first == "post-1"
    assert len(posts.created) == 3
    assert all(len(p["message"]) <= 4000 for p in posts.created)


async def test_an_edit_too_long_for_one_post_writes_the_first_part_and_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, posts, _ = _adapter({"MaxPostSize": "4000"})
    body = _paragraphs(9_000)

    with caplog.at_level(logging.WARNING):
        await adapter.update_message("chan", "post-1", body)

    assert len(posts.patched) == 1
    post_id, patch = posts.patched[0]
    assert post_id == "post-1"
    assert len(patch["message"]) <= 4000
    assert body.startswith(patch["message"])
    assert "not updated" in caplog.text


async def test_an_edit_that_fits_is_written_whole() -> None:
    adapter, posts, client = _adapter({"MaxPostSize": "16383"})

    await adapter.update_message("chan", "post-1", "edited")

    assert posts.patched == [("post-1", {"message": "edited"})]
    assert client.requests == []
