"""Mattermost threads a post only under a thread's root.

Given a reply's id as `root_id` it answers 400 "Invalid RootId parameter", and
Switch is handed a reply to thread under whenever what it answers was itself
posted in a thread: an activity card under a kickoff reply, a refusal notice
under a card that is a reply. Each such post is retried under the root of the
reply's thread.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
import requests
from mattermostdriver.exceptions import (
    FeatureDisabled,
    InvalidOrMissingParameters,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)

from switch_core.bridges.collaboration.adapter import (
    RichContentFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import OutboundAttachment

ROOT = "root-post"
REPLY = "reply-post"


class _FakePosts:
    """Posts the way Mattermost threads them: under a root, never a reply."""

    def __init__(self) -> None:
        self.known: dict[str, str] = {ROOT: "", REPLY: ROOT}
        self.created: list[dict[str, Any]] = []
        self.ephemeral: list[dict[str, Any]] = []
        self.refused: list[str] = []
        self.lookups: list[str] = []
        self.lookup_error: Exception | None = None

    def _check_root(self, post: dict[str, Any]) -> None:
        root = post.get("root_id")
        if root is not None and self.known.get(root, "") != "":
            self.refused.append(root)
            raise InvalidOrMissingParameters("Invalid RootId parameter.")

    def create_post(self, post: dict[str, Any]) -> dict[str, str]:
        self._check_root(post)
        self.created.append(post)
        post_id = f"post-{len(self.created)}"
        self.known[post_id] = post.get("root_id") or ""
        return {"id": post_id}

    def create_ephemeral_post(self, body: dict[str, Any]) -> dict[str, str]:
        self._check_root(body["post"])
        self.ephemeral.append(body)
        return {"id": f"ephemeral-{len(self.ephemeral)}"}

    def get_post(self, post_id: str) -> dict[str, str]:
        self.lookups.append(post_id)
        if self.lookup_error is not None:
            raise self.lookup_error
        if post_id not in self.known:
            raise ResourceNotFound("Unable to find the post.")
        return {"id": post_id, "root_id": self.known[post_id]}


class _FakeFiles:
    def upload_file(self, channel_id: str, files: dict[str, Any]) -> dict[str, Any]:
        return {"file_infos": [{"id": f"file-{files['files'][0]}"}]}


class _FakeDriver:
    def __init__(self, posts: _FakePosts) -> None:
        self.posts = posts
        self.files = _FakeFiles()


@pytest.fixture
def posts() -> _FakePosts:
    return _FakePosts()


@pytest.fixture
async def adapter(posts: _FakePosts) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    driver = _FakeDriver(posts)
    adapter._bot_drivers["worker"] = driver  # type: ignore[assignment]
    adapter._admin_driver = driver  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_running_loop()
    return adapter


async def test_a_message_under_a_reply_goes_into_the_replys_thread(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    ref = await adapter.send_message("chan", "worker", "hello", REPLY)

    assert ref == "post-1"
    assert [post["root_id"] for post in posts.created] == [ROOT]
    assert posts.lookups == [REPLY]


async def test_a_message_under_a_root_is_posted_without_a_lookup(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    await adapter.send_message("chan", "worker", "hello", ROOT)

    assert [post["root_id"] for post in posts.created] == [ROOT]
    assert posts.lookups == []


async def test_every_part_of_a_split_message_goes_under_the_root(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    adapter._max_post_size = 4000
    content = "\n\n".join(["x" * 3000] * 3)

    await adapter.send_message("chan", "worker", content, REPLY)

    assert len(posts.created) == 3
    assert {post["root_id"] for post in posts.created} == {ROOT}
    assert posts.refused == [REPLY]
    assert posts.lookups == [REPLY]


async def test_a_private_notice_under_a_reply_goes_into_its_thread(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    await adapter.notify_privately(
        channel_id="chan",
        channel_name=None,
        user_id="user-1",
        content="You cannot answer this card.",
        thread_root_id=REPLY,
    )

    [notice] = posts.ephemeral
    assert notice["user_id"] == "user-1"
    assert notice["post"]["root_id"] == ROOT


async def test_an_attachment_under_a_reply_goes_into_its_thread(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    ref = await adapter.send_attachment(
        "chan", "worker", "plot.png", "image/png", b"bytes", "the plot", REPLY
    )

    assert ref == "post-1"
    assert [post["root_id"] for post in posts.created] == [ROOT]


async def test_attachments_under_a_reply_go_into_its_thread(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    files = [
        OutboundAttachment(filename="a.txt", mimetype="text/plain", data=b"a"),
        OutboundAttachment(filename="b.txt", mimetype="text/plain", data=b"b"),
    ]

    ref = await adapter.send_attachments("chan", "worker", files, None, REPLY)

    assert ref == "post-1"
    [post] = posts.created
    assert post["root_id"] == ROOT
    assert post["file_ids"] == ["file-a.txt", "file-b.txt"]


async def test_a_resolved_root_is_remembered(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    await adapter.send_message("chan", "worker", "one", REPLY)
    await adapter.send_message("chan", "worker", "two", REPLY)

    assert posts.lookups == [REPLY]
    assert posts.refused == [REPLY]
    assert [post["root_id"] for post in posts.created] == [ROOT, ROOT]


async def test_a_failed_lookup_raises_the_refusal_and_is_not_remembered(
    adapter: MattermostAdapter, posts: _FakePosts, caplog: pytest.LogCaptureFixture
) -> None:
    posts.lookup_error = requests.exceptions.ConnectionError("down")

    with pytest.raises(InvalidOrMissingParameters, match="RootId") as raised:
        await adapter._post_or_raise(adapter._admin_driver, "chan", "hi", REPLY, None)  # type: ignore[arg-type]
    assert REPLY in caplog.text
    assert not MattermostAdapter.refused_for_good(_wrapped(raised.value))

    posts.lookup_error = None
    await adapter._post_or_raise(adapter._admin_driver, "chan", "hi", REPLY, None)  # type: ignore[arg-type]
    assert posts.lookups == [REPLY, REPLY]
    assert [post["root_id"] for post in posts.created] == [ROOT]


async def test_a_reference_that_is_no_reply_raises_the_refusal(
    adapter: MattermostAdapter, posts: _FakePosts, caplog: pytest.LogCaptureFixture
) -> None:
    def refuse(post_id: str) -> dict[str, str]:
        posts.lookups.append(post_id)
        return {"id": post_id, "root_id": ""}

    posts.get_post = refuse  # type: ignore[method-assign]

    with pytest.raises(InvalidOrMissingParameters, match="RootId") as raised:
        await adapter._post_or_raise(adapter._admin_driver, "chan", "hi", REPLY, None)  # type: ignore[arg-type]
    assert "not a reply" in caplog.text
    assert MattermostAdapter.refused_for_good(_wrapped(raised.value))
    assert adapter._thread_roots == {}
    assert posts.created == []


async def test_another_bad_parameter_is_raised_without_a_lookup(
    adapter: MattermostAdapter, posts: _FakePosts
) -> None:
    def refuse(post: dict[str, Any]) -> dict[str, str]:
        raise InvalidOrMissingParameters("model.post.is_valid.message_length")

    posts.create_post = refuse  # type: ignore[method-assign]

    with pytest.raises(InvalidOrMissingParameters, match="message_length"):
        await adapter._post_or_raise(adapter._admin_driver, "chan", "hi", REPLY, None)  # type: ignore[arg-type]
    assert posts.lookups == []


def _http_error(status: int) -> requests.exceptions.HTTPError:
    response = requests.Response()
    response.status_code = status
    return requests.exceptions.HTTPError(f"{status}", response=response)


def _wrapped(cause: BaseException) -> RichContentFailed:
    try:
        raise RichContentFailed("Mattermost refused the post", text="") from cause
    except RichContentFailed as error:
        return error


@pytest.mark.parametrize(
    "cause",
    [
        InvalidOrMissingParameters("Invalid RootId parameter."),
        NotEnoughPermissions("forbidden"),
        ResourceNotFound("not found"),
        _http_error(409),
    ],
)
def test_a_client_error_is_refused_for_good(cause: BaseException) -> None:
    assert MattermostAdapter.refused_for_good(_wrapped(cause))
    assert MattermostAdapter.refused_for_good(cause)


@pytest.mark.parametrize(
    "error",
    [
        _wrapped(NoAccessTokenProvided("expired")),
        _wrapped(FeatureDisabled("disabled")),
        _wrapped(_http_error(429)),
        _wrapped(_http_error(503)),
        requests.exceptions.ConnectionError("down"),
        requests.exceptions.Timeout("slow"),
        RichContentFailed("No Mattermost bot for agent", text=""),
        RichContentThrottled(retry_after=1.0, text=""),
    ],
)
def test_anything_else_is_worth_another_attempt(error: BaseException) -> None:
    assert not MattermostAdapter.refused_for_good(error)
