"""Moving the runtime indicator and refreshing it must not interleave.

Two independent callers mutate ``_working_msg`` for the same agent: the
periodic activity refresh (``apply_runtime_state`` with ``working``, every few
seconds) and a reposition triggered by new traffic. Both read the entry, await
a platform call, then write it back.

Interleaved, the refresh's write lands after the move's and restores the
superseded message ref. The entry then points at a message the move has just
deleted, and the message the move posted is referenced by nothing — so the
end-of-turn clear cannot remove it and it stays in the channel forever.

The invariant each test asserts is the same: whatever is still posted on the
platform is exactly what the adapter thinks is posted.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from switch_core.bridges.collaboration.adapter import LiveRuntimeIndicator
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

CHANNEL = "chan-1"
AGENT = "worker"
KEY = (CHANNEL, AGENT)


class _Platform:
    """Records posts, edits and deletes, yielding once per call.

    The single yield is what lets the two coroutines interleave at all — it
    stands in for the network round trip each of these calls really makes.
    """

    def __init__(self, adapter: SlackAdapter, seeded_ref: str) -> None:
        self.live: set[str] = {seeded_ref}
        self.edits: list[tuple[str, str]] = []
        self._next = iter(f"msg-{n}" for n in range(2, 20))

        async def send_message(
            channel_id: str,
            sender_name: str,
            content: str,
            thread_root_id: str | None = None,
        ) -> str | None:
            await asyncio.sleep(0)
            ref = next(self._next)
            self.live.add(ref)
            return ref

        async def update_message(
            channel_id: str, message_ref: str, new_content: str
        ) -> None:
            await asyncio.sleep(0)
            self.edits.append((message_ref, new_content))

        async def delete_message(channel_id: str, message_ref: str) -> None:
            await asyncio.sleep(0)
            self.live.discard(message_ref)

        adapter.send_message = send_message  # type: ignore[method-assign]
        adapter.update_message = update_message  # type: ignore[method-assign]
        adapter.delete_message = delete_message  # type: ignore[method-assign]


def _adapter() -> tuple[SlackAdapter, _Platform]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T-test"
        )
    )
    adapter._working_msg[KEY] = LiveRuntimeIndicator(
        message_ref="msg-1",
        body="⚙️ _Working on it…_",
        thread_root_id=None,
        started_at=time.monotonic(),
    )
    return adapter, _Platform(adapter, "msg-1")


def _refresh(adapter: SlackAdapter, detail: str) -> Any:
    return adapter.apply_runtime_state(
        CHANNEL,
        AGENT,
        "working",
        mention_handle=None,
        thread_root_id=None,
        detail=detail,
    )


def _assert_consistent(adapter: SlackAdapter, platform: _Platform) -> None:
    live = adapter._working_msg.get(KEY)
    tracked = {live.message_ref} if live is not None else set()
    assert platform.live == tracked, (
        f"platform still shows {sorted(platform.live)} but the adapter tracks "
        f"{sorted(tracked)} — the difference is stranded and nothing will remove it"
    )


async def test_a_refresh_landing_during_a_move_does_not_strand_the_new_message() -> (
    None
):
    # The reported bug: the refresh read the entry before the move rewrote it,
    # so its write restored the old ref and orphaned the message the move
    # posted. The turn's clear then removed the already-deleted one.
    adapter, platform = _adapter()

    await asyncio.gather(
        adapter.reposition_runtime_state(CHANNEL, AGENT, None),
        _refresh(adapter, "Ran tool post_message"),
    )

    _assert_consistent(adapter, platform)


async def test_a_move_still_moves_when_a_refresh_races_it() -> None:
    # The same interleaving in the other order silently abandons the move: the
    # indicator stays where it was, which is the whole defect this feature
    # exists to fix.
    adapter, platform = _adapter()

    await asyncio.gather(
        _refresh(adapter, "Ran tool post_message"),
        adapter.reposition_runtime_state(CHANNEL, AGENT, None),
    )

    live = adapter._working_msg[KEY]
    assert live.message_ref != "msg-1", (
        "the indicator was never repositioned — a concurrent activity refresh "
        "cancelled the move"
    )
    _assert_consistent(adapter, platform)


async def test_the_refresh_body_survives_a_concurrent_move() -> None:
    # Whichever order they run in, the latest activity line must end up on the
    # message that is actually still posted — not on a deleted one.
    adapter, platform = _adapter()

    await asyncio.gather(
        adapter.reposition_runtime_state(CHANNEL, AGENT, None),
        _refresh(adapter, "Editing foo.py"),
    )

    live = adapter._working_msg[KEY]
    assert "Editing foo.py" in live.body
    assert live.message_ref in platform.live


async def test_a_burst_of_moves_and_refreshes_leaves_exactly_one_message() -> None:
    # The steady state under load: several repositions and refreshes overlapping
    # must still converge on a single tracked, still-posted indicator.
    adapter, platform = _adapter()

    await asyncio.gather(
        *(adapter.reposition_runtime_state(CHANNEL, AGENT, None) for _ in range(4)),
        *(_refresh(adapter, f"step {n}") for n in range(4)),
    )

    assert len(platform.live) == 1
    _assert_consistent(adapter, platform)


async def test_the_turn_end_clear_removes_everything() -> None:
    # After a contended turn, going idle must leave the channel clean.
    adapter, platform = _adapter()

    await asyncio.gather(
        adapter.reposition_runtime_state(CHANNEL, AGENT, None),
        _refresh(adapter, "Ran tool post_message"),
    )
    await adapter.apply_runtime_state(
        CHANNEL,
        AGENT,
        "idle",
        mention_handle=None,
        thread_root_id=None,
    )

    assert platform.live == set()
    assert KEY not in adapter._working_msg
