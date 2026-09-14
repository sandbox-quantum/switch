"""Mattermost publishes SDK sessions, and the legacy renderer no longer runs.

What is under test here is the rich-content seam: the compact status and the
plain-text request form, posted as the agent's own bot, edited in place, found
again after an uncertain delivery, and — unlike the old status line — loud when
any of that fails.

The old runtime-state renderer is still in the file (removing it is its own
task) but nothing routes to it any more. The first test holds that line: the
two renderers must not both draw, or every turn appears twice.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)

from .test_session_activity import _item, _items, _turn

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

_MARKER = "switch_publication"


class _FakePosts:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.patched: list[tuple[str, dict[str, Any]]] = []
        self.thread: dict[str, dict[str, Any]] = {}
        self.channel: dict[str, dict[str, Any]] = {}
        self.create_error: Exception | None = None
        self.patch_error: Exception | None = None
        self.read_error: Exception | None = None
        self.thread_calls: list[str] = []
        self.channel_calls: list[tuple[str, dict[str, Any] | None]] = []
        self._next = iter(f"post-{n}" for n in range(1, 50))

    def create_post(self, post: dict[str, Any]) -> dict[str, str]:
        if self.create_error:
            raise self.create_error
        self.created.append(post)
        return {"id": next(self._next)}

    def patch_post(self, post_id: str, body: dict[str, Any]) -> dict[str, str]:
        if self.patch_error:
            raise self.patch_error
        self.patched.append((post_id, body))
        return {"id": post_id}

    def get_thread(self, root_id: str) -> dict[str, Any]:
        self.thread_calls.append(root_id)
        if self.read_error:
            raise self.read_error
        return {"posts": self.thread}

    def get_posts_for_channel(
        self, channel_id: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.channel_calls.append((channel_id, params))
        if self.read_error:
            raise self.read_error
        return {"posts": self.channel}


class _FakeUsers:
    def __init__(self, **users: str) -> None:
        self.users = users
        self.calls: list[str] = []
        self.error: Exception | None = None

    def get_user(self, user_id: str) -> dict[str, str]:
        self.calls.append(user_id)
        if self.error:
            raise self.error
        return {"id": user_id, "username": self.users[user_id]}


class _FakeReactions:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str]] = []

    def create_reaction(self, options: dict[str, str]) -> dict[str, str]:
        self.calls.append(
            ("add", options["user_id"], options["post_id"], options["emoji_name"])
        )
        return options

    def delete_reaction(
        self, user_id: str, post_id: str, emoji_name: str
    ) -> dict[str, str]:
        self.calls.append(("remove", user_id, post_id, emoji_name))
        return {"status": "OK"}


class _FakeDriver:
    def __init__(self, posts: _FakePosts, users: _FakeUsers) -> None:
        self.posts = posts
        self.users = users
        self.reactions = _FakeReactions()


def _adapter(*agents: str, **users: str) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    posts = _FakePosts()
    directory = _FakeUsers(**users)
    for name in agents or ("worker",):
        adapter._agent_bots[name] = {"user_id": f"bot-{name}"}
        adapter._bot_drivers[name] = _FakeDriver(posts, directory)  # type: ignore[assignment]
        adapter._bridge_bot_ids.add(f"bot-{name}")
    adapter._admin_driver = _FakeDriver(posts, directory)  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_event_loop()
    return adapter


def _posts(adapter: MattermostAdapter) -> _FakePosts:
    driver: Any = adapter._admin_driver
    return driver.posts


def _users(adapter: MattermostAdapter) -> _FakeUsers:
    driver: Any = adapter._admin_driver
    return driver.users


def _activity(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    return TurnActivity(items, _turn("running"), **kwargs)


async def _card(**kwargs: Any) -> RequestCard:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, "session-demo")
    request = projection.open_requests()[0]
    return RequestCard(request, RequestReference(token="tok-1", handle="R7"), **kwargs)


# ── The legacy renderer is off ───────────────────────────────────────────────


async def test_the_legacy_renderer_no_longer_draws_alongside_the_sdk_one() -> None:
    """Both would draw the same turn, and the channel would show it twice."""
    adapter = _adapter()

    for state in ("working", "awaiting-input", "idle"):
        await adapter.apply_runtime_state(
            "chan-1",
            "worker",
            state,
            mention_handle="@owner",
            thread_root_id="root-1",
            detail="Private legacy status",
        )
        await adapter.reposition_runtime_state("chan-1", "worker", "root-2")

    assert _posts(adapter).created == []
    assert _posts(adapter).patched == []
    assert adapter._working_msg == {}
    assert adapter._runtime_locks == {}


# ── Posting ──────────────────────────────────────────────────────────────────


async def test_a_publication_is_posted_by_the_agents_own_bot_in_its_thread() -> None:
    adapter = _adapter("worker", "other")

    ref = await adapter.post_rich(
        "chan-1", "worker", _activity(publication_token="tok-turn"), "root-1"
    )

    created = _posts(adapter).created
    assert len(created) == 1
    assert created[0]["channel_id"] == "chan-1"
    assert created[0]["root_id"] == "root-1"
    assert adapter._rich_authors[ref] == "worker"


async def test_the_recovery_marker_travels_in_props_where_no_reader_sees_it() -> None:
    """A marker in the message body would be visible noise on every status."""
    adapter = _adapter()

    await adapter.post_rich("chan-1", "worker", _activity(publication_token="tok-turn"))

    created = _posts(adapter).created[0]
    assert created["props"] == {_MARKER: "tok-turn"}
    assert "tok-turn" not in created["message"]


async def test_a_card_carries_the_token_a_recovery_search_looks_for() -> None:
    adapter = _adapter()

    await adapter.post_rich("chan-1", "worker", await _card())

    assert _posts(adapter).created[0]["props"] == {_MARKER: "tok-1"}


async def test_an_agent_with_no_bot_is_a_failure_and_not_a_quiet_skip() -> None:
    """`send_message` would fall back to the admin account. A publication must
    not: the post would be attributed to Switch rather than to the agent whose
    turn it is, and every later edit would look for a bot that is not there."""
    adapter = _adapter("worker")

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.post_rich("chan-1", "ghost", _activity())

    assert "ghost" in str(excinfo.value)
    assert excinfo.value.text
    assert _posts(adapter).created == []


async def test_a_refused_post_raises_with_what_mattermost_said() -> None:
    adapter = _adapter()
    _posts(adapter).create_error = RuntimeError("403 permission denied")

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.post_rich("chan-1", "worker", _activity())

    assert isinstance(excinfo.value.__cause__, RuntimeError)
    assert "403" in str(excinfo.value)


# ── Editing ──────────────────────────────────────────────────────────────────


async def test_a_redraw_is_patched_by_the_bot_that_posted_it() -> None:
    adapter = _adapter("worker", "other")
    ref = await adapter.post_rich("chan-1", "worker", _activity())

    await adapter.update_rich("chan-1", ref, _activity())

    driver: Any = adapter._bot_drivers["worker"]
    assert driver.posts.patched[0][0] == ref


async def test_a_failed_redraw_raises_rather_than_leaving_a_stale_card() -> None:
    """`update_message` logs and returns, which would leave a settled request
    showing its open form with nobody told."""
    adapter = _adapter()
    ref = await adapter.post_rich("chan-1", "worker", await _card())
    _posts(adapter).patch_error = RuntimeError("404 post not found")

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.update_rich("chan-1", ref, await _card())

    assert isinstance(excinfo.value.__cause__, RuntimeError)
    assert excinfo.value.text


async def test_a_redraw_does_not_mention_the_recipient_a_second_time() -> None:
    """An edit does not notify, so repeating the handle only adds noise to a
    message the person it names has already been told about."""
    adapter = _adapter(**{"u-owner": "owner"})
    card = await _card(notify_external_id="u-owner")
    ref = await adapter.post_rich("chan-1", "worker", card)
    assert "@owner" in _posts(adapter).created[0]["message"]

    await adapter.update_rich("chan-1", ref, card)

    assert "@owner" not in _posts(adapter).patched[0][1]["message"]


async def test_an_unresolvable_mention_is_dropped_rather_than_shown_raw() -> None:
    """A Mattermost user id in the message notifies nobody and reads as noise."""
    adapter = _adapter()
    _users(adapter).error = RuntimeError("404 user not found")

    await adapter.post_rich(
        "chan-1", "worker", await _card(notify_external_id="u-missing")
    )

    assert "u-missing" not in _posts(adapter).created[0]["message"]


async def test_a_resolved_handle_is_looked_up_once_and_then_remembered() -> None:
    adapter = _adapter(**{"u-owner": "owner"})
    card = await _card(notify_external_id="u-owner")

    await adapter.post_rich("chan-1", "worker", card)
    await adapter.post_rich("chan-1", "worker", card)

    assert _users(adapter).calls == ["u-owner"]


# ── Recovery ─────────────────────────────────────────────────────────────────


async def test_an_uncertain_post_is_found_again_by_its_marker() -> None:
    adapter = _adapter()
    _posts(adapter).thread = {
        "post-9": {"id": "post-9", "user_id": "bot-worker", "props": {_MARKER: "tok-1"}}
    }

    found = await adapter.find_request_card(
        "chan-1", "root-1", "tok-1", datetime.now(UTC)
    )

    assert found == "post-9"
    assert _posts(adapter).thread_calls == ["root-1"]


async def test_a_token_quoted_by_a_person_is_not_the_post_that_carries_it() -> None:
    """Props are settable by anyone posting through the API. Matching the
    author as well is what keeps a forged or echoed marker from binding a
    reservation to a message the bridge never sent."""
    adapter = _adapter()
    _posts(adapter).thread = {
        "post-8": {"id": "post-8", "user_id": "u-someone", "props": {_MARKER: "tok-1"}}
    }

    assert (
        await adapter.find_request_card("chan-1", "root-1", "tok-1", datetime.now(UTC))
        is None
    )


async def test_a_rootless_search_asks_the_channel_from_just_before_the_post() -> None:
    adapter = _adapter()
    created_at = datetime(2026, 9, 14, 12, 0, tzinfo=UTC)

    await adapter.find_request_card("chan-1", None, "tok-1", created_at)

    channel_id, params = _posts(adapter).channel_calls[0]
    assert channel_id == "chan-1"
    assert params is not None
    assert params["since"] == int(created_at.timestamp() * 1000) - 60_000


async def test_a_search_that_could_not_run_is_not_found_rather_than_a_guess() -> None:
    """`None` keeps the reservation and asks again. Anything else risks a
    second copy of a card that is meant to be answered exactly once."""
    adapter = _adapter()
    _posts(adapter).read_error = RuntimeError("500 server error")

    assert (
        await adapter.find_request_card("chan-1", "root-1", "tok-1", datetime.now(UTC))
        is None
    )


# ── Reactions ────────────────────────────────────────────────────────────────


async def test_two_agents_on_one_message_are_two_independent_marks() -> None:
    adapter = _adapter("worker", "other")

    await adapter.mark_activity("chan-1", "post-1", agent_name="worker", working=True)
    await adapter.mark_activity("chan-1", "post-1", agent_name="other", working=True)
    await adapter.mark_activity("chan-1", "post-1", agent_name="worker", working=False)

    worker: Any = adapter._bot_drivers["worker"]
    other: Any = adapter._bot_drivers["other"]
    assert worker.reactions.calls == [
        ("add", "bot-worker", "post-1", "eyes"),
        ("remove", "bot-worker", "post-1", "eyes"),
    ]
    assert other.reactions.calls == [("add", "bot-other", "post-1", "eyes")]


async def test_a_mark_left_over_from_before_a_restart_is_still_cleared() -> None:
    """After a restart the in-process record is empty, but the 👀 is still in
    the channel. Without `force` the removal is skipped as already done."""
    adapter = _adapter()

    await adapter.mark_activity(
        "chan-1", "post-1", agent_name="worker", working=False, force=True
    )

    driver: Any = adapter._bot_drivers["worker"]
    assert driver.reactions.calls == [("remove", "bot-worker", "post-1", "eyes")]


# ── Bare answers in a thread ─────────────────────────────────────────────────


async def test_the_first_reply_is_the_oldest_one_not_the_first_returned() -> None:
    """Thread order is not part of the API's contract, and a bare "yes"
    deciding a permission is not worth resting on a field that may change."""
    adapter = _adapter()
    _posts(adapter).thread = {
        "post-c": {"id": "post-c", "create_at": 300},
        "post-a": {"id": "post-a", "create_at": 100},
        "root-1": {"id": "root-1", "create_at": 50},
    }

    assert await adapter.is_first_reply("chan-1", "root-1", "post-a")
    assert not await adapter.is_first_reply("chan-1", "root-1", "post-c")


async def test_a_deleted_first_reply_does_not_hold_the_position() -> None:
    adapter = _adapter()
    _posts(adapter).thread = {
        "root-1": {"id": "root-1", "create_at": 50},
        "post-a": {"id": "post-a", "create_at": 100, "delete_at": 120},
        "post-b": {"id": "post-b", "create_at": 200},
    }

    assert await adapter.is_first_reply("chan-1", "root-1", "post-b")


async def test_an_unreadable_thread_is_not_a_dropped_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """This runs ahead of the relay on every message. Raising here would lose
    the message itself, which is a great deal worse than refusing a bare
    "yes"."""
    adapter = _adapter()
    _posts(adapter).read_error = RuntimeError("500 server error")

    with caplog.at_level(logging.WARNING):
        assert not await adapter.is_first_reply("chan-1", "root-1", "post-a")

    assert caplog.records


# ── How much of the channel a turn takes up ──────────────────────────────────


def _turn_kwargs() -> dict[str, Any]:
    return {
        "session_id": "session-1",
        "channel_id": "chan-1",
        "thread_root_id": "root-1",
        "asked_on": "root-1",
        "agent_name": "worker",
        "session_url": None,
    }


async def test_a_whole_turn_is_one_post_edited_rather_than_a_thread_of_them() -> None:
    """Slack splits the ticking status from the expandable tool log, because it
    can collapse the second one. Mattermost cannot, so a second post would be
    the tool list sitting open in the thread for good — and the compact status
    already carries the counts. One post, edited until the turn ends.
    """
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)
    items = await _items()

    for elapsed, status in ((1, "running"), (30, "running"), (44, "completed")):
        await activity.publish(
            items, _turn(status), elapsed_seconds=elapsed, **_turn_kwargs()
        )

    assert len(_posts(adapter).created) == 1
    assert {ref for ref, _ in _posts(adapter).patched} == {"post-1"}


async def test_a_failure_gets_its_own_reply_and_is_retired_without_deleting_it() -> (
    None
):
    """An edit to a status the reader has already scrolled past notifies
    nobody, so a problem somebody has to act on arrives as a reply of its own.
    Once it clears, that reply is edited rather than removed: Mattermost leaves
    "(message deleted)" behind, which is worse than a settled status line.
    """
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)
    items = await _items()

    await activity.publish(
        items,
        _turn("running"),
        elapsed_seconds=2,
        error_summary="The session host is offline.",
        **_turn_kwargs(),
    )
    assert len(_posts(adapter).created) == 2
    assert "The session host is offline." in _posts(adapter).created[1]["message"]

    await activity.publish(
        items, _turn("completed"), elapsed_seconds=9, **_turn_kwargs()
    )

    assert len(_posts(adapter).created) == 2
    retired = [body for ref, body in _posts(adapter).patched if ref == "post-2"]
    assert retired
    assert "The session host is offline." not in retired[-1]["message"]


# ── What a reader actually sees ──────────────────────────────────────────────


async def test_a_request_form_says_its_handle_and_how_to_answer_it() -> None:
    adapter = _adapter()

    await adapter.post_rich("chan-1", "worker", await _card())

    message = _posts(adapter).created[0]["message"]
    assert "`R7`" in message
    assert "Reply with `R7 " in message


async def test_a_status_stays_inside_one_mattermost_post() -> None:
    adapter = _adapter()
    items = [_item(kind="assistant-message", title="", text="x" * 9000)]

    await adapter.post_rich("chan-1", "worker", TurnActivity(items, _turn("running")))

    assert len(_posts(adapter).created[0]["message"]) <= adapter.rich_fallback_limit()


async def test_a_turn_that_failed_says_so_instead_of_listing_its_tools() -> None:
    adapter = _adapter()
    content = replace(
        _activity(), error_summary="The session host is offline.", session_url=None
    )

    await adapter.post_rich("chan-1", "worker", content)

    assert "The session host is offline." in _posts(adapter).created[0]["message"]
