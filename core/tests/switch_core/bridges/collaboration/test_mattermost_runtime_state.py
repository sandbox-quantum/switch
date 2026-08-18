"""Mattermost's runtime indicator must never delete a post.

Mattermost's web client swaps any message deleted while it is on screen for a
"(message deleted)" placeholder, and only drops it on reload — whether the
delete was permanent or not. A status line that appears and vanishes every turn
therefore leaves a trail of placeholders behind it, one per removal.

So the rule these tests hold the adapter to is blunt: nothing it posts is ever
deleted. The status line is edited into a terminal marker at the end of a turn,
and it does not move while the turn runs.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from switch_core.bridges.collaboration.adapter import LiveRuntimeIndicator
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
    _format_elapsed,
)


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Recorder:
    """Records the adapter's platform calls, deletes included.

    ``deletes`` exists to be asserted empty: it is the failure this whole
    approach is designed around, so a regression that reintroduces a delete
    should fail a test rather than merely change one.
    """

    def __init__(self) -> None:
        self.deletes: list[str] = []
        self.patches: list[tuple[str, str]] = []
        self.sends: list[tuple[str, str, str, str | None]] = []
        self.typing: list[tuple[str, str, str | None]] = []
        self._next_id = iter(f"post-{n}" for n in range(2, 20))

    def install(self, adapter: MattermostAdapter) -> None:
        async def delete_message(channel_id: str, message_ref: str) -> None:
            self.deletes.append(message_ref)

        async def patch_post_as(agent_name: str, post_id: str, content: str) -> None:
            self.patches.append((post_id, content))

        async def send_message(
            channel_id: str,
            sender_name: str,
            content: str,
            thread_root_id: str | None = None,
        ) -> str | None:
            self.sends.append((channel_id, sender_name, content, thread_root_id))
            return next(self._next_id)

        async def post_typing(
            channel_id: str, sender_name: str, thread_root_id: str | None
        ) -> None:
            self.typing.append((channel_id, sender_name, thread_root_id))

        adapter.delete_message = delete_message  # type: ignore[method-assign]
        adapter._patch_post_as = patch_post_as  # type: ignore[method-assign]
        adapter.send_message = send_message  # type: ignore[method-assign]
        adapter._post_typing = post_typing  # type: ignore[method-assign]


def _seed_indicator(
    adapter: MattermostAdapter,
    *,
    thread_root_id: str | None = None,
    age_seconds: float = 0.0,
) -> None:
    adapter._working_msg[("chan-1", "worker")] = LiveRuntimeIndicator(
        message_ref="post-1",
        body="⚙️ _Working on it…_",
        thread_root_id=thread_root_id,
        started_at=time.monotonic() - age_seconds,
    )


def test_the_indicator_stays_put_instead_of_following_the_conversation() -> None:
    # Moving it means deleting it from where it was, and every delete is a
    # placeholder in every client watching. Pinned costs the reader nothing.
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)
    _seed_indicator(adapter, thread_root_id="root-9")

    _run(adapter.reposition_runtime_state("chan-1", "worker", "root-42"))

    assert recorder.deletes == []
    assert recorder.sends == []
    live = adapter._working_msg[("chan-1", "worker")]
    assert live.message_ref == "post-1"
    assert live.thread_root_id == "root-9"


def test_a_finished_turn_retires_the_indicator_in_place() -> None:
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)
    _seed_indicator(adapter, age_seconds=134)

    _run(
        adapter.apply_runtime_state(
            "chan-1", "worker", "idle", mention_handle=None, thread_root_id=None
        )
    )

    assert recorder.deletes == []
    assert recorder.patches == [("post-1", "✓ Done · 2m14s")]
    assert ("chan-1", "worker") not in adapter._working_msg


def test_the_done_marker_carries_no_session_link() -> None:
    # The marker is permanent, so it stays minimal. A link into the session is
    # worth having while the agent is working, not on the record of a finished
    # turn — and it is one more thing to read on a line nobody asked to keep.
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)
    _seed_indicator(adapter, age_seconds=8)

    _run(
        adapter.apply_runtime_state(
            "chan-1",
            "worker",
            "idle",
            mention_handle=None,
            thread_root_id=None,
            deeplink_url="https://switch.example/session/1",
        )
    )

    assert recorder.patches == [("post-1", "✓ Done · 8s")]


def test_an_operator_ping_is_resolved_rather_than_removed() -> None:
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)
    adapter._input_pings[("chan-1", "worker")] = ["ping-1", "ping-2"]

    _run(
        adapter.apply_runtime_state(
            "chan-1", "worker", "idle", mention_handle=None, thread_root_id=None
        )
    )

    assert recorder.deletes == []
    assert recorder.patches == [
        ("ping-1", "✓ Input received"),
        ("ping-2", "✓ Input received"),
    ]
    assert ("chan-1", "worker") not in adapter._input_pings


def test_a_turn_posts_one_status_line_and_deletes_nothing() -> None:
    # The end-to-end shape: one post at the start, edited in place as the work
    # changes, edited once more when it finishes. Never more than one line, and
    # never a delete.
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)

    async def turn() -> None:
        for detail in ("Ran tool Bash", "Ran tool Edit", None):
            await adapter.apply_runtime_state(
                "chan-1",
                "worker",
                "working",
                mention_handle=None,
                thread_root_id=None,
                detail=detail,
            )
        await adapter.apply_runtime_state(
            "chan-1", "worker", "idle", mention_handle=None, thread_root_id=None
        )

    _run(turn())

    assert recorder.deletes == []
    assert len(recorder.sends) == 1
    assert [content for _, content in recorder.patches] == [
        "⚙️ Ran tool Edit",
        "⚙️ _Working on it…_",
        "✓ Done · 0s",
    ]


def test_idle_without_an_indicator_does_nothing() -> None:
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)

    _run(
        adapter.apply_runtime_state(
            "chan-1", "worker", "idle", mention_handle=None, thread_root_id=None
        )
    )

    assert recorder.patches == []
    assert recorder.deletes == []


def test_the_turn_opens_with_a_typing_nudge_where_the_message_came_from() -> None:
    # Addressed inside a thread: the reader is watching that thread, so the
    # nudge goes there. Without a parent Mattermost shows it at the root.
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)

    _run(
        adapter.apply_runtime_state(
            "chan-1",
            "worker",
            "working",
            mention_handle=None,
            thread_root_id="root-9",
            trigger_thread_root_id="root-9",
        )
    )

    assert recorder.typing == [("chan-1", "worker", "root-9")]


def test_typing_stays_at_the_root_when_that_is_where_the_message_was() -> None:
    # The status is pinned into the thread the answer will open, but whoever
    # wrote at channel level is watching the channel — a typing indicator
    # inside a thread they have not opened is one they never see.
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)

    _run(
        adapter.apply_runtime_state(
            "chan-1",
            "worker",
            "working",
            mention_handle=None,
            thread_root_id="post-trigger",
            trigger_thread_root_id=None,
        )
    )

    assert recorder.sends[0][3] == "post-trigger"
    assert recorder.typing == [("chan-1", "worker", None)]


def test_typing_is_not_repeated_on_every_activity_refresh() -> None:
    # Mattermost expires the indicator after a few seconds, so replaying it
    # would claim the agent is typing for as long as the turn runs. The posted
    # status carries the state from there on.
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)

    async def turn() -> None:
        for detail in (None, "Ran tool Edit", "Running tests"):
            await adapter.apply_runtime_state(
                "chan-1",
                "worker",
                "working",
                mention_handle=None,
                thread_root_id=None,
                detail=detail,
            )

    _run(turn())

    assert len(recorder.typing) == 1


def test_a_retired_turn_does_not_nudge() -> None:
    adapter = _adapter()
    recorder = _Recorder()
    recorder.install(adapter)
    _seed_indicator(adapter)

    _run(
        adapter.apply_runtime_state(
            "chan-1", "worker", "idle", mention_handle=None, thread_root_id=None
        )
    )

    assert recorder.typing == []


def test_elapsed_is_written_the_way_it_is_read() -> None:
    assert _format_elapsed(0.4) == "0s"
    assert _format_elapsed(8.9) == "8s"
    assert _format_elapsed(59) == "59s"
    assert _format_elapsed(60) == "1m00s"
    assert _format_elapsed(134) == "2m14s"
    assert _format_elapsed(3600) == "1h00m"
    assert _format_elapsed(3780) == "1h03m"
    # A clock that ran backwards is not a negative duration.
    assert _format_elapsed(-5) == "0s"
