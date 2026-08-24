"""The 👀 Discord puts on the message an agent is answering.

The status message says an agent is busy; it does not say *what with*. The
reaction is what ties a turn to the message that started it, and it is the one
progress signal that costs nothing but a permission — so it has to survive a
missing permission, a deleted message, and an agent answering two people at
once, without ever leaving a mark behind.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)

GUILD_ID = 900
CHANNEL_ID = 100


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeResponse:
    status = 403
    reason = "Forbidden"


class _FakePartialMessage:
    def __init__(self, channel: _FakeChannel, message_id: int) -> None:
        self.id = message_id
        self._channel = channel

    async def add_reaction(self, emoji: str) -> None:
        if self._channel.reaction_error is not None:
            raise self._channel.reaction_error
        self._channel.reactions.append(("add", self.id, emoji))

    async def remove_reaction(self, emoji: str, member: Any) -> None:
        if self._channel.reaction_error is not None:
            raise self._channel.reaction_error
        self._channel.reactions.append(("remove", self.id, emoji))


class _FakeChannel:
    def __init__(self, channel_id: int = CHANNEL_ID) -> None:
        self.id = channel_id
        self.reactions: list[tuple[str, int, str]] = []
        self.reaction_error: Exception | None = None

    def get_partial_message(self, message_id: int) -> _FakePartialMessage:
        return _FakePartialMessage(self, message_id)


class _FakeClient:
    def __init__(self, channels: dict[int, Any]) -> None:
        self._channels = channels
        self.user = object()

    def get_channel(self, channel_id: int) -> Any | None:
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int) -> Any:
        channel = self._channels.get(channel_id)
        if channel is None:
            raise discord.NotFound(_FakeResponse(), "unknown channel")
        return channel


@pytest.fixture
def channel() -> _FakeChannel:
    return _FakeChannel()


@pytest.fixture
def adapter(channel: _FakeChannel) -> DiscordAdapter:
    made = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    made._client = _FakeClient({CHANNEL_ID: channel})  # type: ignore[assignment]
    return made


def _state(
    adapter: DiscordAdapter,
    state: str,
    *,
    anchor: str | None,
    agent: str = "scribe",
) -> None:
    _run(adapter._track_turn(str(CHANNEL_ID), anchor, agent, state=state))


# ── The mark goes on, and comes off ──────────────────────────────────────────


def test_the_message_being_answered_is_marked(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")

    assert channel.reactions == [("add", 11, "👀")]


def test_the_mark_comes_off_when_the_turn_ends(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")
    _state(adapter, "idle", anchor=None)

    assert channel.reactions == [("add", 11, "👀"), ("remove", 11, "👀")]


def test_a_refreshed_turn_does_not_mark_twice(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    # The activity refresh reports `working` over and over with the same
    # anchor; each one must not cost an API call.
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")

    assert channel.reactions == [("add", 11, "👀")]


def test_the_mark_stays_up_while_the_agent_waits_for_input(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    # `awaiting-input` is mid-turn, not the end of one.
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")
    _state(adapter, "awaiting-input", anchor=f"{CHANNEL_ID}:11")

    assert ("remove", 11, "👀") not in channel.reactions


def test_a_turn_with_nothing_bridged_to_mark_is_not_an_error(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    # A turn the agent started from somewhere other than this channel has no
    # anchor here — there is nothing to mark, and nothing to complain about.
    _state(adapter, "working", anchor=None)

    assert channel.reactions == []


# ── Two questions at once ────────────────────────────────────────────────────


def test_both_messages_are_marked_and_both_are_cleared(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    """A turn ends once, naming only the message it last touched.

    Clearing just that one would leave the first marked as being worked on for
    good — which is why the marks are held per agent rather than per message.
    """
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:22")
    _state(adapter, "idle", anchor=None)

    assert channel.reactions == [
        ("add", 11, "👀"),
        ("add", 22, "👀"),
        ("remove", 11, "👀"),
        ("remove", 22, "👀"),
    ]


def test_one_agent_ending_its_turn_leaves_another_agent_marked(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11", agent="scribe")
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:22", agent="courier")
    _state(adapter, "idle", anchor=None, agent="scribe")

    assert ("remove", 11, "👀") in channel.reactions
    assert ("remove", 22, "👀") not in channel.reactions


# ── Inside a thread ──────────────────────────────────────────────────────────


def test_a_message_inside_a_thread_is_marked_in_that_thread(
    adapter: DiscordAdapter,
) -> None:
    """The reaction goes where the message is, not where the room is.

    A message posted in a thread is bridged into the parent channel's room, but
    it lives in the thread — which on Discord is a channel of its own, and the
    only place the reaction can be added.
    """
    thread = _FakeChannel(channel_id=777)
    adapter._client._channels[777] = thread  # type: ignore[union-attr]

    _state(adapter, "working", anchor="777:33")

    assert thread.reactions == [("add", 33, "👀")]


# ── When Discord says no ─────────────────────────────────────────────────────


def test_a_missing_permission_is_named_rather_than_faked(
    adapter: DiscordAdapter,
    channel: _FakeChannel,
    caplog: pytest.LogCaptureFixture,
) -> None:
    channel.reaction_error = discord.Forbidden(_FakeResponse(), "missing perms")

    with caplog.at_level(logging.WARNING):
        _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")

    assert channel.reactions == []
    assert "Add Reactions" in caplog.text


def test_a_refused_mark_is_not_recorded_as_present(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    # Recording a mark that was refused would make the retry on the next
    # activity report a no-op, so the guild would never recover the reaction
    # once the permission is granted.
    channel.reaction_error = discord.Forbidden(_FakeResponse(), "missing perms")
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")

    channel.reaction_error = None
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")

    assert channel.reactions == [("add", 11, "👀")]


def test_a_deleted_message_ends_the_turn_cleanly(
    adapter: DiscordAdapter, channel: _FakeChannel
) -> None:
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")

    channel.reaction_error = discord.NotFound(_FakeResponse(), "unknown message")
    _state(adapter, "idle", anchor=None)

    # The mark is forgotten, so a later turn on a fresh message still marks.
    channel.reaction_error = None
    _state(adapter, "working", anchor=f"{CHANNEL_ID}:11")
    assert channel.reactions[-1] == ("add", 11, "👀")
