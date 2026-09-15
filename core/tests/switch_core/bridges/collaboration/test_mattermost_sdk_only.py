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
import requests
from mattermostdriver.exceptions import NotEnoughPermissions, ResourceNotFound

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
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
        # Whose driver made each call, in order. One shared log across the
        # drivers, because which bot Mattermost saw is the thing under test.
        self.created_by: list[str] = []
        self.patched_by: list[str] = []
        self.thread: dict[str, dict[str, Any]] = {}
        self.channel: dict[str, dict[str, Any]] = {}
        self.create_error: Exception | None = None
        self.created_id: str | None = None
        self.patch_error: Exception | None = None
        self.read_error: Exception | None = None
        self.thread_calls: list[str] = []
        self.channel_calls: list[tuple[str, dict[str, Any] | None]] = []
        self._next = iter(f"post-{n}" for n in range(1, 50))

    def create_post(self, post: dict[str, Any]) -> dict[str, str]:
        if self.create_error:
            raise self.create_error
        self.created.append(post)
        if self.created_id is not None:
            return {"id": self.created_id}
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
        self.create_error: Exception | None = None
        self.delete_error: Exception | None = None

    def create_reaction(self, options: dict[str, str]) -> dict[str, str]:
        if self.create_error:
            raise self.create_error
        self.calls.append(
            ("add", options["user_id"], options["post_id"], options["emoji_name"])
        )
        return options

    def delete_reaction(
        self, user_id: str, post_id: str, emoji_name: str
    ) -> dict[str, str]:
        if self.delete_error:
            raise self.delete_error
        self.calls.append(("remove", user_id, post_id, emoji_name))
        return {"status": "OK"}


class _FakeClient:
    """The raw HTTP surface, which is how the typing nudge is sent."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str]]] = []

    def make_request(
        self, method: str, endpoint: str, body: dict[str, str]
    ) -> dict[str, str]:
        self.requests.append((method, endpoint, body))
        return {"status": "OK"}


class _DriverPosts:
    """One driver's view of the shared post log, tagged with whose it is."""

    def __init__(self, posts: _FakePosts, owner: str) -> None:
        self._posts = posts
        self._owner = owner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._posts, name)

    def create_post(self, post: dict[str, Any]) -> dict[str, str]:
        self._posts.created_by.append(self._owner)
        return self._posts.create_post(post)

    def patch_post(self, post_id: str, body: dict[str, Any]) -> dict[str, str]:
        self._posts.patched_by.append(self._owner)
        return self._posts.patch_post(post_id, body)


class _FakeDriver:
    def __init__(self, posts: _FakePosts, users: _FakeUsers, owner: str) -> None:
        self.posts = _DriverPosts(posts, owner)
        self.users = users
        self.reactions = _FakeReactions()
        self.client = _FakeClient()


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
        adapter._bot_drivers[name] = _FakeDriver(posts, directory, name)  # type: ignore[assignment]
        adapter._bridge_bot_ids.add(f"bot-{name}")
    adapter._admin_driver = _FakeDriver(posts, directory, "admin")  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_event_loop()
    return adapter


def _posts(adapter: MattermostAdapter) -> _FakePosts:
    driver: Any = adapter._admin_driver
    return driver.posts._posts


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
    assert _posts(adapter).created_by == ["worker"]
    assert ref


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
    _posts(adapter).create_error = NotEnoughPermissions("403 permission denied")

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.post_rich("chan-1", "worker", _activity())

    assert isinstance(excinfo.value.__cause__, NotEnoughPermissions)
    assert "403" in str(excinfo.value)


def _http_error(status: int, **headers: str) -> requests.HTTPError:
    """What the driver raises for a status it has no exception of its own for.

    `mattermostdriver` names 400, 401, 403, 404, 405, 413 and 501 and raises
    its own class for each. Everything else — a rate limit, a server fault —
    comes back as the underlying `requests` error with the response attached,
    which is the only place the status and any `Retry-After` can be read.
    """
    response = requests.Response()
    response.status_code = status
    response.headers.update(headers)
    return requests.HTTPError(f"{status} from Mattermost", response=response)


async def test_an_uncertain_send_is_not_a_refusal_and_keeps_its_reservation() -> None:
    """`RichContentFailed` tells the caller to drop its reservation and start
    again. A lost response has not been refused: Mattermost may well have
    taken the post, and starting again would put a second one in the channel.
    """
    adapter = _adapter()
    _posts(adapter).create_error = TimeoutError("accepted on the server, response lost")

    with pytest.raises(TimeoutError):
        await adapter.post_rich("chan-1", "worker", _activity())


@pytest.mark.parametrize("status", [500, 502, 503])
async def test_a_server_fault_is_not_a_refusal_either(status: int) -> None:
    adapter = _adapter()
    _posts(adapter).create_error = _http_error(status)

    with pytest.raises(requests.HTTPError):
        await adapter.post_rich("chan-1", "worker", _activity())


async def test_a_rate_limit_waits_for_the_deadline_mattermost_gave() -> None:
    adapter = _adapter()
    _posts(adapter).create_error = _http_error(429, **{"Retry-After": "17"})

    with pytest.raises(RichContentThrottled) as excinfo:
        await adapter.post_rich("chan-1", "worker", _activity())

    assert excinfo.value.retry_after == 17
    assert excinfo.value.text


async def test_a_rate_limit_with_no_deadline_still_waits_before_retrying() -> None:
    """Retrying at once would spend the next window being refused again."""
    adapter = _adapter()
    _posts(adapter).create_error = _http_error(429)

    with pytest.raises(RichContentThrottled) as excinfo:
        await adapter.post_rich("chan-1", "worker", _activity())

    assert excinfo.value.retry_after > 0


async def test_a_post_accepted_without_an_id_is_unresolved_not_refused() -> None:
    """Nothing here knows whether the post exists, so the reservation stands
    and recovery looks for it by its marker rather than posting again."""
    adapter = _adapter()
    _posts(adapter).created_id = ""

    with pytest.raises(RuntimeError):
        await adapter.post_rich("chan-1", "worker", _activity())


# ── Editing ──────────────────────────────────────────────────────────────────


async def test_a_redraw_is_patched_by_the_bot_that_posted_it() -> None:
    adapter = _adapter("worker", "other")
    ref = await adapter.post_rich("chan-1", "worker", _activity())

    await adapter.update_rich("chan-1", "worker", ref, _activity(), None)

    assert _posts(adapter).patched[0][0] == ref
    assert _posts(adapter).patched_by == ["worker"]


async def test_a_redraw_is_still_the_agents_own_bot_after_a_restart() -> None:
    """The name comes with the call, so nothing about a redraw depends on this
    process having been the one that posted the card."""
    adapter = _adapter("worker", "other")
    ref = await adapter.post_rich("chan-1", "worker", _activity())

    restarted = _adapter("worker", "other")
    await restarted.update_rich("chan-1", "worker", ref, _activity(), None)

    assert _posts(restarted).patched_by == ["worker"]


async def test_a_failed_redraw_raises_rather_than_leaving_a_stale_card() -> None:
    """`update_message` logs and returns, which would leave a settled request
    showing its open form with nobody told."""
    adapter = _adapter()
    ref = await adapter.post_rich("chan-1", "worker", await _card())
    _posts(adapter).patch_error = ResourceNotFound("404 post not found")

    with pytest.raises(RichContentFailed) as excinfo:
        await adapter.update_rich("chan-1", "worker", ref, await _card(), None)

    assert isinstance(excinfo.value.__cause__, ResourceNotFound)
    assert excinfo.value.text


async def test_a_redraw_that_may_have_landed_is_not_reported_as_refused() -> None:
    """The caller retires the message it drew on a definite refusal. A lost
    response has not refused anything, and the same edit is worth trying
    again against the post it was already aimed at."""
    adapter = _adapter()
    ref = await adapter.post_rich("chan-1", "worker", await _card())
    _posts(adapter).patch_error = _http_error(503)

    with pytest.raises(requests.HTTPError):
        await adapter.update_rich("chan-1", "worker", ref, await _card(), None)


async def test_a_rate_limited_redraw_carries_the_wait_back_to_the_caller() -> None:
    adapter = _adapter()
    ref = await adapter.post_rich("chan-1", "worker", await _card())
    _posts(adapter).patch_error = _http_error(429, **{"Retry-After": "8"})

    with pytest.raises(RichContentThrottled) as excinfo:
        await adapter.update_rich("chan-1", "worker", ref, await _card(), None)

    assert excinfo.value.retry_after == 8


async def test_a_redraw_does_not_mention_the_recipient_a_second_time() -> None:
    """An edit does not notify, so repeating the handle only adds noise to a
    message the person it names has already been told about."""
    adapter = _adapter(**{"u-owner": "owner"})
    card = await _card(notify_external_id="u-owner")
    ref = await adapter.post_rich("chan-1", "worker", card)
    assert "@owner" in _posts(adapter).created[0]["message"]

    await adapter.update_rich("chan-1", "worker", ref, card, None)

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
        "chan-1", "root-1", "tok-1", datetime.now(UTC), "R7"
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
        await adapter.find_request_card(
            "chan-1", "root-1", "tok-1", datetime.now(UTC), "R7"
        )
        is None
    )


async def test_a_rootless_search_asks_the_channel_from_just_before_the_post() -> None:
    adapter = _adapter()
    created_at = datetime(2026, 9, 14, 12, 0, tzinfo=UTC)

    await adapter.find_request_card("chan-1", None, "tok-1", created_at, "R7")

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
        await adapter.find_request_card(
            "chan-1", "root-1", "tok-1", datetime.now(UTC), "R7"
        )
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


async def test_a_mark_that_did_not_happen_is_raised_rather_than_swallowed() -> None:
    """The publisher writes a completion receipt on the strength of what this
    tells it. A swallowed failure leaves 👀 on a finished turn for good."""
    adapter = _adapter()
    driver: Any = adapter._bot_drivers["worker"]
    driver.reactions.create_error = ConnectionError("temporary network failure")

    with pytest.raises(ConnectionError):
        await adapter.mark_activity(
            "chan-1", "post-1", agent_name="worker", working=True
        )


async def test_an_agent_with_no_bot_cannot_mark_and_says_so() -> None:
    adapter = _adapter("worker")

    with pytest.raises(RuntimeError):
        await adapter.mark_activity(
            "chan-1", "post-1", agent_name="ghost", working=True
        )


async def test_a_failed_mark_is_tried_again_rather_than_recorded_as_done() -> None:
    """`self._eyes` is this process's memory of what it has already done. A
    failure recorded there would talk the retry out of trying."""
    adapter = _adapter()
    driver: Any = adapter._bot_drivers["worker"]
    driver.reactions.create_error = ConnectionError("temporary network failure")
    with pytest.raises(ConnectionError):
        await adapter.mark_activity(
            "chan-1", "post-1", agent_name="worker", working=True
        )

    driver.reactions.create_error = None
    await adapter.mark_activity("chan-1", "post-1", agent_name="worker", working=True)

    assert driver.reactions.calls == [("add", "bot-worker", "post-1", "eyes")]


async def test_clearing_a_mark_mattermost_says_is_gone_is_not_a_failure() -> None:
    """The channel is already in the state being asked for, so there is
    nothing for the caller to retry."""
    adapter = _adapter()
    await adapter.mark_activity("chan-1", "post-1", agent_name="worker", working=True)
    driver: Any = adapter._bot_drivers["worker"]
    driver.reactions.delete_error = ResourceNotFound("404 reaction not found")

    await adapter.mark_activity("chan-1", "post-1", agent_name="worker", working=False)

    driver.reactions.delete_error = None
    await adapter.mark_activity("chan-1", "post-1", agent_name="worker", working=True)
    assert driver.reactions.calls == [
        ("add", "bot-worker", "post-1", "eyes"),
        ("add", "bot-worker", "post-1", "eyes"),
    ]


async def test_the_legacy_path_still_logs_a_failed_mark_rather_than_raising(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing on that path retries or records what it did, so raising there
    would lose a message over a cosmetic reaction."""
    adapter = _adapter()
    driver: Any = adapter._bot_drivers["worker"]
    driver.reactions.create_error = ConnectionError("temporary network failure")

    with caplog.at_level(logging.WARNING):
        await adapter._track_eyes("chan-1", "worker", "working", "root-1")

    assert caplog.records


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


# ── Who gets told ────────────────────────────────────────────────────────────


async def test_naming_somebody_is_the_only_way_this_platform_reaches_them() -> None:
    """A Mattermost thread notifies the people named in it and nobody else,
    which is what makes the owner worth naming ahead of whoever asked."""
    activity = SessionTurnActivity(_adapter())

    assert activity.notifies_only_by_mention
    assert not activity.redraws_for_elapsed_time


async def test_a_problem_with_nobody_to_name_admits_that_it_told_no_one() -> None:
    """Silence here reads as "somebody has been paged". Nobody has."""
    adapter = _adapter()
    content = replace(
        _activity(),
        error_summary="The agent host is offline.",
        notify_unreachable=True,
        session_url=None,
    )

    await adapter.post_rich("chan-1", "worker", content)

    message = _posts(adapter).created[0]["message"]
    assert "notified no one" in message
    assert "Switch Console" in message


async def test_the_unnotified_notice_is_not_what_pushes_a_post_over_the_limit() -> None:
    adapter = _adapter()
    items = [_item(kind="assistant-message", title="", text="x" * 9000)]
    content = TurnActivity(
        items,
        _turn("running"),
        error_summary="The agent host is offline.",
        notify_unreachable=True,
    )

    await adapter.post_rich("chan-1", "worker", content)

    message = _posts(adapter).created[0]["message"]
    assert len(message) <= adapter.rich_fallback_limit()
    assert message.endswith(adapter.unnotified_notice())


async def test_a_request_asked_of_nobody_admits_it_too() -> None:
    """A card is the one post that exists to be answered. Unanswered because
    nobody saw it looks exactly like unanswered because nobody has decided."""
    adapter = _adapter()

    await adapter.post_rich("chan-1", "worker", await _card(notify_unreachable=True))

    message = _posts(adapter).created[0]["message"]
    assert "notified no one" in message
    assert "Reply with" in message


async def test_a_card_redrawn_without_a_mention_does_not_claim_it_reached_nobody() -> (
    None
):
    """Every redraw drops the mention on purpose — it has already notified.
    That is not the same as there having been nobody to name."""
    adapter = _adapter()

    await adapter.post_rich("chan-1", "worker", await _card())

    assert "notified no one" not in _posts(adapter).created[0]["message"]


async def test_the_card_notice_is_not_what_pushes_a_post_over_the_limit() -> None:
    adapter = _adapter()
    card = await _card(notify_unreachable=True, notify_external_id="u-owner")

    await adapter.post_rich("chan-1", "worker", card)

    message = _posts(adapter).created[0]["message"]
    assert len(message) <= adapter.rich_fallback_limit()
    assert message.endswith(adapter.unnotified_notice())


async def test_a_reachable_recipient_is_named_and_told_nothing_about_linking() -> None:
    adapter = _adapter(**{"u-owner": "owner"})
    content = replace(
        _activity(),
        error_summary="The agent host is offline.",
        notify_external_id="u-owner",
        session_url=None,
    )

    await adapter.post_rich("chan-1", "worker", content)

    message = _posts(adapter).created[0]["message"]
    assert "@owner" in message
    assert "notified no one" not in message


# ── Saying the agent has started ─────────────────────────────────────────────


def _typing(adapter: MattermostAdapter, agent_name: str) -> list[dict[str, str]]:
    driver: Any = adapter._bot_drivers[agent_name]
    return [
        body
        for _, endpoint, body in driver.client.requests
        if endpoint.endswith("/typing")
    ]


async def test_a_turn_says_the_agent_has_started_once_and_not_on_every_redraw() -> None:
    """The channel shows nothing at all between the command and the first
    status. Mattermost expires the indicator itself, so this is a nudge and
    not something to switch off — and one nudge per turn, because a platform
    told again on every redraw shows the agent typing for as long as it ran.
    """
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)

    for elapsed in (1, 30):
        await activity.publish(
            [], _turn("running"), elapsed_seconds=elapsed, **_turn_kwargs()
        )

    assert _typing(adapter, "worker") == [{"channel_id": "chan-1"}]


async def test_the_nudge_goes_where_the_work_was_asked_for() -> None:
    """A command typed inside a thread is watched there; the channel root is
    a place the person waiting is not looking."""
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)

    await activity.publish(
        [],
        _turn("running"),
        elapsed_seconds=1,
        **{**_turn_kwargs(), "asked_on": "reply-9"},
    )

    assert _typing(adapter, "worker") == [
        {"channel_id": "chan-1", "parent_id": "root-1"}
    ]


async def test_a_turn_that_is_already_over_does_not_say_it_has_started() -> None:
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)

    await activity.publish([], _turn("completed"), elapsed_seconds=4, **_turn_kwargs())

    assert _typing(adapter, "worker") == []


# ── What the publisher is told about a turn ──────────────────────────────────


async def test_a_turn_whose_mark_could_not_be_cleared_is_not_reported_complete() -> (
    None
):
    """Reported complete, the turn is never published again and the 👀 stays
    on a finished request for good."""
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)
    await activity.publish([], _turn("running"), elapsed_seconds=1, **_turn_kwargs())
    driver: Any = adapter._bot_drivers["worker"]
    driver.reactions.delete_error = ConnectionError("temporary network failure")

    assert not await activity.publish(
        [], _turn("completed"), elapsed_seconds=2, **_turn_kwargs()
    )


async def test_the_clock_alone_does_not_rewrite_a_running_turns_post() -> None:
    """One post carries the whole turn here, so a redraw is the reader's only
    post changing under them. It is worth a change they asked about."""
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)
    items = await _items()

    for elapsed in (1, 30, 44):
        await activity.publish(
            items, _turn("running"), elapsed_seconds=elapsed, **_turn_kwargs()
        )

    assert _posts(adapter).patched == []


async def test_a_new_tool_does_rewrite_it() -> None:
    adapter = _adapter()
    activity = SessionTurnActivity(adapter)
    items = await _items()

    await activity.publish(items, _turn("running"), elapsed_seconds=1, **_turn_kwargs())
    await activity.publish(
        [*items, _item(**{"itemId": "item-read", "title": "Read notes.md"})],
        _turn("running"),
        elapsed_seconds=2,
        **_turn_kwargs(),
    )

    assert len(_posts(adapter).patched) == 1
