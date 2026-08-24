"""The 👀 Mattermost puts on the message an agent is working on.

Mattermost has no equivalent of Slack's native progress card, and its typing
indicator expires after a few seconds. The reaction is therefore the one
progress signal here that is both immediate and durable — and unlike the status
post, it says *which* message was picked up.

It is added by the agent's own bot rather than a shared bridge account, so two
agents working on one message show as two marks.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


class _FakeReactions:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str]] = []
        self.error: Exception | None = None

    def create_reaction(self, options: dict[str, str]) -> dict[str, str]:
        if self.error:
            raise self.error
        self.calls.append(
            ("add", options["user_id"], options["post_id"], options["emoji_name"])
        )
        return options

    def delete_reaction(
        self, user_id: str, post_id: str, emoji_name: str
    ) -> dict[str, str]:
        if self.error:
            raise self.error
        self.calls.append(("remove", user_id, post_id, emoji_name))
        return {"status": "OK"}


class _FakeDriver:
    def __init__(self) -> None:
        self.reactions = _FakeReactions()


def _adapter(*agents: str) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    for name in agents or ("worker",):
        adapter._agent_bots[name] = {"user_id": f"bot-{name}"}
        adapter._bot_drivers[name] = _FakeDriver()  # type: ignore[assignment]

    async def send_message(
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        return "status-post"

    async def patch_post_as(agent_name: str, post_id: str, content: str) -> None:
        return None

    async def post_typing(
        channel_id: str, sender_name: str, thread_root_id: str | None
    ) -> None:
        return None

    adapter.send_message = send_message  # type: ignore[method-assign]
    adapter._patch_post_as = patch_post_as  # type: ignore[method-assign]
    adapter._post_typing = post_typing  # type: ignore[method-assign]
    return adapter


def _reactions(
    adapter: MattermostAdapter, agent: str = "worker"
) -> list[tuple[str, ...]]:
    driver: Any = adapter._bot_drivers[agent]
    return driver.reactions.calls


def _run(adapter: MattermostAdapter, *states: tuple[str, str | None]) -> None:
    """Drive the adapter through runtime states with a live main loop set."""

    async def _body() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        for state, thread_root_id in states:
            await adapter.apply_runtime_state(
                "chan-1",
                "worker",
                state,
                mention_handle=None,
                thread_root_id=thread_root_id,
            )

    asyncio.run(_body())


def test_the_message_being_worked_on_gets_the_eyes() -> None:
    adapter = _adapter()

    _run(adapter, ("working", "post-1"))

    assert _reactions(adapter) == [("add", "bot-worker", "post-1", "eyes")]


def test_the_eyes_come_off_when_the_turn_ends() -> None:
    adapter = _adapter()

    _run(adapter, ("working", "post-1"), ("idle", None))

    assert _reactions(adapter) == [
        ("add", "bot-worker", "post-1", "eyes"),
        ("remove", "bot-worker", "post-1", "eyes"),
    ]


def test_the_eyes_are_added_once_for_a_turn() -> None:
    # The activity refresh repeats `working` for as long as the agent runs.
    adapter = _adapter()

    _run(adapter, ("working", "post-1"), ("working", "post-1"), ("working", "post-1"))

    assert _reactions(adapter) == [("add", "bot-worker", "post-1", "eyes")]


def test_the_eyes_stay_on_while_the_agent_waits_for_input() -> None:
    # awaiting-input is mid-turn, just paused — the message is still being
    # worked on, so the mark stays.
    adapter = _adapter()

    _run(adapter, ("working", "post-1"), ("awaiting-input", "post-1"))

    assert _reactions(adapter) == [("add", "bot-worker", "post-1", "eyes")]


def test_the_eyes_go_on_the_message_that_asked_not_the_thread_root() -> None:
    # Inside a thread the status is anchored to the root, but what was said is
    # the reply — and the reply is what the reader is waiting on.
    adapter = _adapter()
    adapter._remember_trigger("chan-1", "root-1", "reply-9")

    _run(adapter, ("working", "root-1"))

    assert _reactions(adapter) == [("add", "bot-worker", "reply-9", "eyes")]


def test_the_eyes_come_off_the_message_that_asked() -> None:
    adapter = _adapter()
    adapter._remember_trigger("chan-1", "root-1", "reply-9")

    _run(adapter, ("working", "root-1"), ("idle", None))

    assert ("remove", "bot-worker", "reply-9", "eyes") in _reactions(adapter)
    assert not any(call[2] == "root-1" for call in _reactions(adapter))


def test_a_message_at_the_channel_root_is_marked_on_itself() -> None:
    # This adapter follows the anchor, so a root-level trigger arrives as its
    # own post id and no trigger mapping is needed.
    adapter = _adapter()

    _run(adapter, ("working", "post-42"))

    assert _reactions(adapter) == [("add", "bot-worker", "post-42", "eyes")]


def test_every_marked_message_is_cleared_when_the_turn_ends() -> None:
    # An agent asked two things at once works on both, but the turn ends once.
    # Clearing only the last thread would leave the first marked for good.
    adapter = _adapter()

    _run(adapter, ("working", "post-1"), ("working", "post-2"), ("idle", None))

    removed = {call[2] for call in _reactions(adapter) if call[0] == "remove"}
    assert removed == {"post-1", "post-2"}


def test_two_agents_on_one_message_each_leave_their_own_mark() -> None:
    adapter = _adapter("worker", "reviewer")

    async def _body() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        for agent in ("worker", "reviewer"):
            await adapter.apply_runtime_state(
                "chan-1",
                agent,
                "working",
                mention_handle=None,
                thread_root_id="post-1",
            )

    asyncio.run(_body())

    assert _reactions(adapter, "worker") == [("add", "bot-worker", "post-1", "eyes")]
    assert _reactions(adapter, "reviewer") == [
        ("add", "bot-reviewer", "post-1", "eyes")
    ]


def test_a_failed_reaction_does_not_break_the_turn(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The post may have been deleted, or the bot removed from the channel. The
    # status message is what actually carries the state.
    adapter = _adapter()
    driver: Any = adapter._bot_drivers["worker"]
    driver.reactions.error = RuntimeError("403 forbidden")

    with caplog.at_level(logging.WARNING):
        _run(adapter, ("working", "post-1"))

    assert ("worker", "post-1") not in adapter._eyes
    assert any("working reaction" in r.getMessage() for r in caplog.records)


def test_an_agent_with_no_connected_bot_is_reported_not_ignored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter()
    adapter._bot_drivers.clear()
    adapter._agent_bots.clear()

    with caplog.at_level(logging.WARNING):
        _run(adapter, ("working", "post-1"))

    assert any("no connected bot" in r.getMessage() for r in caplog.records)


def test_the_trigger_map_does_not_grow_without_bound() -> None:
    adapter = _adapter()
    adapter._thread_trigger_max = 3

    for n in range(6):
        adapter._remember_trigger("chan-1", f"root-{n}", f"post-{n}")

    assert list(adapter._thread_trigger) == [
        ("chan-1", "root-3"),
        ("chan-1", "root-4"),
        ("chan-1", "root-5"),
    ]
