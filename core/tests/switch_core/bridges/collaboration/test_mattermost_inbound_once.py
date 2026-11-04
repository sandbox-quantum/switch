"""A Mattermost post reaches Switch exactly once, even when a bot's socket
gives up on it part-way.

Every agent bot in a channel has its own socket, so a channel with five agents
hears each post five times, each on a thread and event loop of its own. The
first copy in claims the post and the others are skipped as duplicates. The
socket library cancels whatever its read loop is doing every 30 seconds (its
keep-alive `wait_for`). A post used to be claimed first and its sender looked
up on that loop afterwards, so a cancel landing during the lookup dropped the
post, and the other copies had already been skipped: lost, with nothing logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage
from tests.switch_core.bridges.collaboration.test_bridge_agent_display_names import (
    _agent,
    _bridge,
    _run,
)
from tests.switch_core.bridges.collaboration.test_mattermost_agent_rename import (
    _adapter as _identity_adapter,
)
from tests.switch_core.bridges.collaboration.test_mattermost_agent_rename import (
    _identity,
    _RecordingBot,
)


class _Users:
    """The admin driver's user lookup, held open until the test lets it go:
    a slow Mattermost, which is when the keep-alive cancel lands on it."""

    def __init__(self, *, hold: bool) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        if not hold:
            self.release.set()
        self.calls = 0

    def get_user(self, user_id: str) -> dict[str, str]:
        self.calls += 1
        self.started.set()
        self.release.wait(timeout=5)
        return {"username": "alice"}


class _Channel:
    """A channel's posts as Mattermost lists them: newest first, a page at a time."""

    def __init__(self, posts: list[dict[str, Any]] | None = None) -> None:
        self.posts = posts or []
        self.pages: list[int] = []

    def get_posts_for_channel(
        self, channel_id: str, params: dict[str, int]
    ) -> dict[str, Any]:
        self.pages.append(params["page"])
        newest = sorted(self.posts, key=lambda p: -p["create_at"])
        start = params["page"] * params["per_page"]
        chunk = newest[start : start + params["per_page"]]
        return {"order": [p["id"] for p in chunk], "posts": {p["id"]: p for p in chunk}}

    def get_channel(self, channel_id: str) -> dict[str, str]:
        return {"type": "O", "display_name": "Team"}


def _post(post_id: str, created: int, message: str = "hello") -> dict[str, Any]:
    return {
        "id": post_id,
        "user_id": "user-alice",
        "channel_id": "chan-1",
        "message": message,
        "type": "",
        "root_id": "",
        "create_at": created,
    }


def _adapter(users: _Users, channel: _Channel | None = None) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mattermost.invalid",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    channel = channel or _Channel()
    adapter._admin_driver = SimpleNamespace(  # type: ignore[assignment]
        users=users, posts=channel, channels=channel
    )
    adapter._admin_user_id = "admin-user"
    return adapter


def _posted(
    post_id: str = "post-1", message: str = "hello", created: int = 1_000
) -> str:
    post = _post(post_id, created, message)
    return json.dumps(
        {
            "event": "posted",
            "data": {"post": json.dumps(post), "channel_type": "O"},
        }
    )


class _Socket:
    """One bot's socket: its own thread and event loop, as the adapter runs it."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self._thread.start()

    def deliver(self, adapter: MattermostAdapter, event: str, bot: str) -> Any:
        return asyncio.run_coroutine_threadsafe(
            adapter._ws_handler(event, bot), self.loop
        )

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)
        self.loop.close()


async def _until(check: Callable[[], bool], seconds: float = 5) -> None:
    async with asyncio.timeout(seconds):
        while not check():
            await asyncio.sleep(0.01)


async def _settle() -> None:
    """Long enough for any straggling hand-in to have happened."""
    await asyncio.sleep(0.2)


def _handed(adapter: MattermostAdapter) -> list[InboundMessage]:
    handed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        handed.append(msg)

    adapter._on_message = on_message
    return handed


class TestKeepAliveCancel:
    async def test_a_cancel_during_the_sender_lookup_still_hands_the_post_in_once(
        self,
    ) -> None:
        users = _Users(hold=True)
        adapter = _adapter(users)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        first, second = _Socket(), _Socket()
        try:
            # The first bot's copy claims the post, then its loop is
            # cancelled while the sender lookup is still out.
            claimed = first.deliver(adapter, _posted(), "user-a-pm")
            await asyncio.to_thread(users.started.wait, 5)
            claimed.cancel()
            # The second bot's copy of the same post arrives meanwhile.
            await asyncio.wrap_future(
                second.deliver(adapter, _posted(), "user-a-engineer")
            )
            users.release.set()

            await _until(lambda: len(handed) >= 1)
            await _settle()
        finally:
            users.release.set()
            first.close()
            second.close()

        assert [m.message_ref for m in handed] == ["post-1"]
        assert handed[0].sender_name == "alice"

    async def test_five_copies_of_a_post_hand_it_in_once(self) -> None:
        users = _Users(hold=False)
        adapter = _adapter(users)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        sockets = [_Socket() for _ in range(5)]
        try:
            await asyncio.gather(
                *(
                    asyncio.wrap_future(s.deliver(adapter, _posted(), f"bot-{i}"))
                    for i, s in enumerate(sockets)
                )
            )
            await _until(lambda: len(handed) >= 1)
            await _settle()
        finally:
            for s in sockets:
                s.close()

        assert [m.message_ref for m in handed] == ["post-1"]
        assert users.calls == 1


class TestClaimReleasedOnFailure:
    async def test_a_hand_in_that_fails_leaves_the_post_for_a_later_copy(self) -> None:
        users = _Users(hold=False)
        adapter = _adapter(users)
        adapter._main_loop = asyncio.get_running_loop()
        attempts: list[str] = []
        handed: list[str] = []

        async def on_message(msg: InboundMessage) -> None:
            attempts.append(msg.message_ref or "")
            if len(attempts) == 1:
                raise RuntimeError("Core was not reachable")
            handed.append(msg.message_ref or "")

        adapter._on_message = on_message
        socket = _Socket()
        try:
            await asyncio.wrap_future(socket.deliver(adapter, _posted(), "bot-a"))
            await _until(lambda: len(attempts) >= 1)
            await _settle()
            await asyncio.wrap_future(socket.deliver(adapter, _posted(), "bot-b"))
            await _until(lambda: len(handed) >= 1)
            await _settle()
        finally:
            socket.close()

        assert attempts == ["post-1", "post-1"]
        assert handed == ["post-1"]

    async def test_a_post_handed_in_is_not_handed_in_again(self) -> None:
        users = _Users(hold=False)
        adapter = _adapter(users)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        socket = _Socket()
        try:
            await asyncio.wrap_future(socket.deliver(adapter, _posted(), "bot-a"))
            await _until(lambda: len(handed) >= 1)
            await asyncio.wrap_future(socket.deliver(adapter, _posted(), "bot-b"))
            await _settle()
        finally:
            socket.close()

        assert [m.message_ref for m in handed] == ["post-1"]


class TestFailureLog:
    async def test_a_failed_hand_in_logs_ids_and_the_error_type_only(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = _adapter(_Users(hold=False))
        adapter._main_loop = asyncio.get_running_loop()
        attempts: list[str] = []

        async def on_message(msg: InboundMessage) -> None:
            attempts.append(msg.message_ref or "")
            raise RuntimeError("words the sender wrote")

        adapter._on_message = on_message
        socket = _Socket()
        try:
            with caplog.at_level(logging.ERROR):
                await asyncio.wrap_future(
                    socket.deliver(
                        adapter, _posted(message="words the sender wrote"), "bot-a"
                    )
                )
                await _until(lambda: len(attempts) >= 1)
                await _settle()
        finally:
            socket.close()

        failed = [
            r
            for r in caplog.records
            if "Could not hand Mattermost post" in r.getMessage()
        ]
        assert len(failed) == 1
        assert "post-1" in failed[0].getMessage()
        assert "RuntimeError" in failed[0].getMessage()
        assert failed[0].exc_info is None
        assert "words the sender wrote" not in caplog.text


class TestOrder:
    async def test_posts_in_one_channel_are_handed_in_in_the_order_heard(self) -> None:
        """Handing in off the socket's loop must not let a later post overtake
        an earlier one whose sender lookup is slower."""
        users = _Users(hold=True)
        adapter = _adapter(users)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        socket = _Socket()
        try:
            await asyncio.wrap_future(
                socket.deliver(adapter, _posted("post-1"), "bot-a")
            )
            await asyncio.to_thread(users.started.wait, 5)
            await asyncio.wrap_future(
                socket.deliver(adapter, _posted("post-2"), "bot-a")
            )
            users.release.set()
            await _until(lambda: len(handed) >= 2)
        finally:
            users.release.set()
            socket.close()

        assert [m.message_ref for m in handed] == ["post-1", "post-2"]


class TestBoundedHandOff:
    async def test_a_flood_past_the_limit_never_holds_the_socket_and_loses_nothing(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        posts = [_post(f"post-{n}", n * 1_000) for n in range(1, 6)]
        users = _Users(hold=True)
        adapter = _adapter(users, _Channel(posts))
        adapter._main_loop = asyncio.get_running_loop()
        adapter._handoff_limit = 2
        handed = _handed(adapter)
        socket = _Socket()
        try:
            with caplog.at_level(logging.WARNING):
                # Switch's loop is stalled in the sender lookups; five posts arrive.
                for post in posts:
                    async with asyncio.timeout(1):
                        await asyncio.wrap_future(
                            socket.deliver(
                                adapter,
                                _posted(post["id"], created=post["create_at"]),
                                "bot-a",
                            )
                        )
                # The socket still reads: its next event (a keep-alive's
                # answer, here any event) is handled at once.
                async with asyncio.timeout(1):
                    await asyncio.wrap_future(
                        socket.deliver(
                            adapter, json.dumps({"event": "typing"}), "bot-a"
                        )
                    )
                assert caplog.text.count("reach Switch slower than they arrive") == 1
                assert handed == []
                users.release.set()
                await _until(lambda: len(handed) >= 5)
                await _settle()
        finally:
            users.release.set()
            socket.close()

        assert [m.message_ref for m in handed] == [p["id"] for p in posts]
        assert "has drained; 3 post(s) left unclaimed" in caplog.text
        assert adapter._in_flight == 0


class TestCatchUpPages:
    async def test_it_reads_page_by_page_until_the_gap_is_covered(self) -> None:
        heard = _post("heard", 1_000)
        missed = [_post(f"m{n:03}", 1_000 + n) for n in range(1, 451)]
        channel = _Channel([heard, *missed])
        adapter = _adapter(_Users(hold=False), channel)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        with adapter._seen_lock:
            adapter._mark_for_catch_up("chan-1", 1_000)
        await adapter._catch_up(None)
        await _until(lambda: len(handed) >= 450)
        await _settle()

        assert channel.pages == [0, 1, 2]
        assert [m.message_ref for m in handed] == [p["id"] for p in missed]

    async def test_a_gap_longer_than_the_page_limit_is_said(
        self, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from switch_core.bridges.collaboration.mattermost import adapter as module

        monkeypatch.setattr(module, "_CATCH_UP_MAX_PAGES", 2)
        missed = [_post(f"m{n:03}", 1_000 + n) for n in range(1, 451)]
        channel = _Channel(missed)
        adapter = _adapter(_Users(hold=False), channel)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        with adapter._seen_lock:
            adapter._mark_for_catch_up("chan-1", 1_000)
        with caplog.at_level(logging.WARNING):
            await adapter._catch_up(None)
            await _until(lambda: len(handed) >= 400)
            await _settle()

        assert channel.pages == [0, 1]
        assert "did not reach the posts already heard" in caplog.text
        # The newest 400 are handed in, oldest first.
        assert [m.message_ref for m in handed] == [p["id"] for p in missed[50:]]

    async def test_a_failed_fetch_waits_for_the_next_catch_up(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        class _Down(_Channel):
            def get_posts_for_channel(
                self, channel_id: str, params: dict[str, int]
            ) -> dict[str, Any]:
                self.pages.append(params["page"])
                raise ConnectionError("Mattermost was not reachable")

        channel = _Down()
        adapter = _adapter(_Users(hold=False), channel)
        adapter._main_loop = asyncio.get_running_loop()
        with adapter._seen_lock:
            adapter._mark_for_catch_up("chan-1", 1_000)
        with caplog.at_level(logging.WARNING):
            await adapter._catch_up(None)

        # Tried once, not in a loop, and still marked for the next one.
        assert channel.pages == [0]
        assert adapter._catch_up_from == {"chan-1": 1_000}
        assert "ConnectionError" in caplog.text


class TestCatchUpRetry:
    async def test_a_failed_fetch_is_tried_again_on_a_timer_and_said_once(
        self, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from switch_core.bridges.collaboration.mattermost import adapter as module

        monkeypatch.setattr(module, "_CATCH_UP_RETRY_S", 0.05)
        missed = _post("missed", 2_000)

        class _Flaky(_Channel):
            def get_posts_for_channel(
                self, channel_id: str, params: dict[str, int]
            ) -> dict[str, Any]:
                if len(self.pages) < 2:
                    self.pages.append(params["page"])
                    raise ConnectionError("Mattermost was not reachable")
                return super().get_posts_for_channel(channel_id, params)

        channel = _Flaky([missed])
        adapter = _adapter(_Users(hold=False), channel)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        with adapter._seen_lock:
            adapter._mark_for_catch_up("chan-1", 1_000)
        with caplog.at_level(logging.WARNING):
            # Nothing else happens on this quiet box: no drain, no reopen.
            await adapter._catch_up(None)
            await _until(lambda: len(handed) >= 1)
            await _settle()

        # Failed twice, then fetched on the timer, once; said once, not per try.
        assert [m.message_ref for m in handed] == ["missed"]
        assert caplog.text.count("trying again every") == 1
        assert adapter._catch_up_from == {}
        assert adapter._retry_pending is None


class TestCommands:
    async def test_a_command_post_is_handed_in_once_too(self) -> None:
        users = _Users(hold=False)
        adapter = _adapter(users)
        adapter._main_loop = asyncio.get_running_loop()
        commands: list[InboundCommand] = []

        async def on_command(cmd: InboundCommand) -> None:
            commands.append(cmd)

        adapter._on_command = on_command
        sockets = [_Socket() for _ in range(3)]
        try:
            await asyncio.gather(
                *(
                    asyncio.wrap_future(
                        s.deliver(adapter, _posted(message="!reset"), f"bot-{i}")
                    )
                    for i, s in enumerate(sockets)
                )
            )
            await _until(lambda: len(commands) >= 1)
            await _settle()
        finally:
            for s in sockets:
                s.close()

        assert [(c.command, c.message_ref) for c in commands] == [("reset", "post-1")]


class TestCancelIsSaid:
    def test_an_event_cut_short_on_the_socket_is_logged(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Anything the keep-alive still cuts short on a socket's loop (not a
        post, which is handed off first) leaves a warning, not silence."""
        adapter, _admin = _identity_adapter(_bridge(_agent("notes-taker", None)))
        bot = _RecordingBot()
        adapter._create_driver = lambda **kwargs: bot  # type: ignore[assignment,method-assign,return-value]

        async def _never_done(event_data: str, agent_name: str) -> None:
            await asyncio.Event().wait()

        adapter._ws_handler = _never_done  # type: ignore[method-assign]

        async def _open() -> None:
            adapter._main_loop = asyncio.get_running_loop()
            await adapter.create_agent_identity(_identity("notes-taker"))

        _run(_open())
        assert bot.ready.wait(timeout=5), "the bot's socket never started"

        async def _cut_short() -> None:
            handling = asyncio.ensure_future(bot.handler(json.dumps({"event": "x"})))
            await asyncio.sleep(0.01)
            handling.cancel()
            with pytest.raises(asyncio.CancelledError):
                await handling

        with caplog.at_level(logging.WARNING):
            _run(_cut_short())

        assert "Mattermost socket for notes-taker cut short its handling" in caplog.text
