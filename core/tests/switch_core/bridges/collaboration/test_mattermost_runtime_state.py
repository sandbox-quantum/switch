from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.adapter import LiveRuntimeIndicator
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
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
    """Records the adapter's platform calls, with a togglable hard delete."""

    def __init__(self, *, hard_delete_works: bool) -> None:
        self.hard_delete_works = hard_delete_works
        self.hard_deletes: list[str] = []
        self.patches: list[tuple[str, str]] = []
        self.sends: list[tuple[str, str, str, str | None]] = []
        # Post ids actually handed back, so a test can assert that everything
        # posted was also removed.
        self.sent_ids: list[str] = []
        self._next_id = iter(["post-2", "post-3", "post-4"])

    def install(self, adapter: MattermostAdapter) -> None:
        async def permanent_delete(post_id: str) -> bool:
            self.hard_deletes.append(post_id)
            return self.hard_delete_works

        async def patch_post_as(agent_name: str, post_id: str, content: str) -> None:
            self.patches.append((post_id, content))

        async def send_message(
            channel_id: str,
            sender_name: str,
            content: str,
            thread_root_id: str | None = None,
        ) -> str | None:
            self.sends.append((channel_id, sender_name, content, thread_root_id))
            ref = next(self._next_id)
            self.sent_ids.append(ref)
            return ref

        adapter._permanent_delete = permanent_delete  # type: ignore[method-assign]
        adapter._patch_post_as = patch_post_as  # type: ignore[method-assign]
        adapter.send_message = send_message  # type: ignore[method-assign]


def _seed_indicator(
    adapter: MattermostAdapter, *, thread_root_id: str | None = None
) -> None:
    adapter._working_msg[("chan-1", "worker")] = LiveRuntimeIndicator(
        message_ref="post-1",
        body="⚙️ _Working on it…_",
        thread_root_id=thread_root_id,
    )


def test_reposition_deletes_before_reposting_when_hard_delete_works() -> None:
    # Mattermost inverts the usual post-then-delete order: the old post must be
    # provably gone before a replacement is posted, or a failure would strand a
    # marker in the channel.
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=True)
    recorder.install(adapter)
    _seed_indicator(adapter, thread_root_id="root-9")

    _run(adapter.reposition_runtime_state("chan-1", "worker", "root-9"))

    assert recorder.hard_deletes == ["post-1"]
    assert recorder.sends == [("chan-1", "worker", "⚙️ _Working on it…_", "root-9")]
    assert recorder.patches == []
    assert adapter._working_msg[("chan-1", "worker")].message_ref == "post-2"


def test_reposition_rehomes_into_the_thread_of_the_latest_message() -> None:
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=True)
    recorder.install(adapter)
    _seed_indicator(adapter, thread_root_id="root-9")

    _run(adapter.reposition_runtime_state("chan-1", "worker", "root-42"))

    assert recorder.sends == [("chan-1", "worker", "⚙️ _Working on it…_", "root-42")]
    assert adapter._working_msg[("chan-1", "worker")].thread_root_id == "root-42"


def test_reposition_abandoned_when_hard_delete_is_unavailable() -> None:
    # Without a hard delete, moving would leave a "✓ done" marker behind on
    # every message. The indicator stays where it is instead.
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=False)
    recorder.install(adapter)
    _seed_indicator(adapter)

    _run(adapter.reposition_runtime_state("chan-1", "worker", None))

    assert recorder.sends == []
    assert recorder.patches == []
    assert adapter._working_msg[("chan-1", "worker")].message_ref == "post-1"


def test_unavailable_hard_delete_is_warned_once_per_channel() -> None:
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=False)
    recorder.install(adapter)
    _seed_indicator(adapter)

    _run(adapter.reposition_runtime_state("chan-1", "worker", None))
    _run(adapter.reposition_runtime_state("chan-1", "worker", None))

    assert adapter._no_hard_delete_warned == {"chan-1"}


def test_reposition_is_a_noop_without_a_live_indicator() -> None:
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=True)
    recorder.install(adapter)

    _run(adapter.reposition_runtime_state("chan-1", "worker", None))

    assert recorder.hard_deletes == []
    assert recorder.sends == []


def test_failed_repost_after_delete_drops_the_stale_ref() -> None:
    # The old post is already gone here, so there is nothing to fall back to —
    # the tracked ref must not keep pointing at a deleted post.
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=True)
    recorder.install(adapter)
    _seed_indicator(adapter)

    async def failing_send(*_args: Any, **_kwargs: Any) -> None:
        return None

    adapter.send_message = failing_send  # type: ignore[method-assign]
    _run(adapter.reposition_runtime_state("chan-1", "worker", None))

    assert ("chan-1", "worker") not in adapter._working_msg


def test_a_turn_ending_during_a_move_leaves_nothing_behind() -> None:
    # The move and the end-of-turn clear share the agent's runtime lock, so
    # they cannot interleave: whichever runs second sees the other's result.
    # Either way the channel ends up with no indicator and none is tracked.
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=True)
    recorder.install(adapter)
    _seed_indicator(adapter)

    async def scenario() -> None:
        await asyncio.gather(
            adapter.reposition_runtime_state("chan-1", "worker", None),
            adapter.apply_runtime_state(
                "chan-1", "worker", "idle", notify_user=None, thread_root_id=None
            ),
        )

    _run(scenario())

    posted = {"post-1", *(ref for ref in recorder.sent_ids)}
    assert posted <= set(recorder.hard_deletes)
    assert ("chan-1", "worker") not in adapter._working_msg


def test_a_refresh_during_a_move_does_not_strand_the_replacement() -> None:
    # The reported leftover: the periodic activity refresh and the move both
    # read-modify-write the tracked indicator. Serialised, the refresh edits
    # whichever message is actually posted rather than restoring a dead ref.
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=True)
    recorder.install(adapter)
    _seed_indicator(adapter)

    async def scenario() -> None:
        await asyncio.gather(
            adapter.reposition_runtime_state("chan-1", "worker", None),
            adapter.apply_runtime_state(
                "chan-1",
                "worker",
                "working",
                notify_user=None,
                thread_root_id=None,
                detail="Ran tool post_message",
            ),
        )

    _run(scenario())

    live = adapter._working_msg[("chan-1", "worker")]
    posted = {"post-1", *recorder.sent_ids}
    still_up = posted - set(recorder.hard_deletes)
    assert still_up == {live.message_ref}


def test_idle_still_falls_back_to_a_terminal_marker() -> None:
    # Turn end is unchanged: without a hard delete the post is edited rather
    # than soft deleted, so no "(message deleted)" tombstone is left.
    adapter = _adapter()
    recorder = _Recorder(hard_delete_works=False)
    recorder.install(adapter)
    _seed_indicator(adapter)

    _run(
        adapter.apply_runtime_state(
            "chan-1", "worker", "idle", notify_user=None, thread_root_id=None
        )
    )

    assert recorder.patches == [("post-1", "✓ done")]
    assert ("chan-1", "worker") not in adapter._working_msg
