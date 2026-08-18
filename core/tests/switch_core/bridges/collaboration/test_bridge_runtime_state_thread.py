"""Where a runtime status surfaces when the agent was addressed at the root.

A runtime-state report only carries a `thread_id` when the agent was addressed
inside an existing thread. Message the agent at channel level and it carries
none — yet the agent's reply still opens a thread on the triggering message. The
status and the answer to it then sit in two different places, which is what the
reader actually notices: a "working on it…" line stranded in the channel while
the reply is somewhere behind a "1 reply" link.

The report does say which message the agent is working on — the anchor — so on
an adapter that asks for it that stands in for the missing thread. These pin
down that it is used only where it was asked for, and never over a real thread.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.events import AgentRuntimeStateEvent


class _FakeAdapter:
    def __init__(self, *, follows_anchor: bool) -> None:
        self.runtime_state_follows_anchor = follows_anchor
        self.applied: list[str | None] = []
        self.trigger_threads: list[str | None] = []

    def agents_with_live_runtime_state(self, channel_id: str) -> list[str]:
        return []

    async def apply_runtime_state(
        self,
        channel_id: str,
        agent_name: str,
        state: str,
        *,
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None,
        detail: str | None,
        trigger_thread_root_id: str | None = None,
    ) -> None:
        self.applied.append(thread_root_id)
        self.trigger_threads.append(trigger_thread_root_id)

    async def reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        return None


def _bridge(*, follows_anchor: bool, posts: dict[str, str]) -> Any:
    """A BridgeCore stand-in wired to the real runtime-state handler.

    `posts` is the message map: Matrix event id -> external post id.
    """
    adapter = _FakeAdapter(follows_anchor=follows_anchor)

    async def external_post_for_matrix_event(event_id: str) -> str | None:
        return posts.get(event_id)

    ns = SimpleNamespace(
        _adapter=adapter,
        _indicator_move_timers={},
        _indicator_move_targets={},
        _reported_anchors={},
        _find_channel=lambda **kwargs: "chan-1",
        _external_post_for_matrix_event=external_post_for_matrix_event,
        adapter_spy=adapter,
    )
    for name in (
        "handle_agent_runtime_state",
        "_follow_reported_anchor",
        "_schedule_indicator_move",
        "_run_indicator_move",
    ):
        setattr(ns, name, getattr(BridgeCore, name).__get__(ns))
    return ns


def _report(
    bridge: Any, *, thread_id: str | None, anchor_event_id: str | None
) -> str | None:
    """Deliver one "working" report and return where the status was put."""
    event = AgentRuntimeStateEvent(
        agent_id="agent-1",
        agent_name="worker",
        room_id="!room:switch.local",
        state="working",
        thread_id=thread_id,
        anchor_event_id=anchor_event_id,
    )
    room = SimpleNamespace(room_id="!room:switch.local")
    asyncio.run(bridge.handle_agent_runtime_state(room, event))
    return bridge.adapter_spy.applied[-1]


def test_the_status_joins_the_thread_the_reply_will_open() -> None:
    # Addressed at the channel root: no thread of its own, but the anchor names
    # the message being worked on, and that is where the reply goes.
    bridge = _bridge(follows_anchor=True, posts={"$trigger": "post-trigger"})

    assert _report(bridge, thread_id=None, anchor_event_id="$trigger") == "post-trigger"


def test_a_real_thread_still_wins_over_the_anchor() -> None:
    # Addressed inside a thread, having since been handed a newer message. The
    # thread the turn belongs to is the one it was started in.
    bridge = _bridge(
        follows_anchor=True,
        posts={"$thread": "post-thread", "$newer": "post-newer"},
    )

    assert _report(bridge, thread_id="$thread", anchor_event_id="$newer") == (
        "post-thread"
    )


def test_an_adapter_that_did_not_ask_keeps_the_status_at_the_root() -> None:
    # Slack renders a thread in a side panel, so moving the status into one
    # hides it. Only an adapter that opts in gets the fallback.
    bridge = _bridge(follows_anchor=False, posts={"$trigger": "post-trigger"})

    assert _report(bridge, thread_id=None, anchor_event_id="$trigger") is None


def test_an_unmapped_anchor_falls_back_to_the_root() -> None:
    # The triggering post was never relayed through this bridge, so there is no
    # post to hang the thread on. Root beats guessing.
    bridge = _bridge(follows_anchor=True, posts={})

    assert _report(bridge, thread_id=None, anchor_event_id="$unknown") is None


def test_a_report_with_neither_stays_at_the_root() -> None:
    bridge = _bridge(follows_anchor=True, posts={"$trigger": "post-trigger"})

    assert _report(bridge, thread_id=None, anchor_event_id=None) is None


def test_the_trigger_keeps_its_own_place_even_as_the_status_moves() -> None:
    # The two are reported separately: the status goes into the thread the
    # answer will open, the trigger says where the person waiting is looking.
    # Addressed at channel level, that is the root — so no thread.
    bridge = _bridge(follows_anchor=True, posts={"$trigger": "post-trigger"})

    _report(bridge, thread_id=None, anchor_event_id="$trigger")

    assert bridge.adapter_spy.applied == ["post-trigger"]
    assert bridge.adapter_spy.trigger_threads == [None]


def test_a_threaded_trigger_reports_its_thread() -> None:
    bridge = _bridge(follows_anchor=True, posts={"$thread": "post-thread"})

    _report(bridge, thread_id="$thread", anchor_event_id="$thread")

    assert bridge.adapter_spy.trigger_threads == ["post-thread"]
