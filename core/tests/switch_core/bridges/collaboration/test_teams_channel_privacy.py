"""Whether a Teams channel is private decides who a user is added to. A standard
channel shares its team's membership, so adding someone to it adds them to the
team; calling a private channel standard silently adds them to the whole team.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

CHANNEL = "19:new@thread.tacv2"
CHAT = "19:chat@thread.v2"


class _FakeGraph:
    """Graph as far as channel privacy and membership go. A membership type of
    None makes the read fail, as it does without permission or in an outage."""

    def __init__(self, membership_type: str | None) -> None:
        self.membership_type = membership_type
        self.by_channel: dict[str, str | None] = {}
        self.channel_reads = 0
        self.channel_members: list[str] = []
        self.team_members: list[str] = []

    async def create_channel(self, *, display_name: str, **_: Any) -> dict[str, Any]:
        return {"id": CHANNEL, "displayName": display_name}

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        self.channel_reads += 1
        membership = self.by_channel.get(channel_id, self.membership_type)
        if membership is None:
            raise RuntimeError("Graph refused the read")
        return {
            "id": channel_id,
            "displayName": "Room",
            "membershipType": membership,
            "layoutType": "chat",
        }

    async def add_channel_member(self, *, user_aad_id: str, **_: Any) -> None:
        self.channel_members.append(user_aad_id)

    async def add_team_member(self, *, user_aad_id: str, **_: Any) -> None:
        self.team_members.append(user_aad_id)

    async def create_subscription(self, **_: Any) -> dict[str, Any]:
        return {"id": "SUB-X"}


def _adapter(membership_type: str | None) -> tuple[TeamsAdapter, _FakeGraph]:
    config = TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-9",
        team_id="team-7",
        public_base_url="https://switch.example",
        client_state="s3cr3t",
    )
    graph = _FakeGraph(membership_type)
    adapter = TeamsAdapter(config=config)
    adapter._graph = graph  # type: ignore[assignment]
    return adapter, graph


def _capture(adapter: TeamsAdapter, handler: str) -> list[Any]:
    captured: list[Any] = []

    async def record(item: Any) -> None:
        captured.append(item)

    setattr(adapter, handler, record)
    return captured


def _capture_learned(adapter: TeamsAdapter, *, fail: bool) -> list[tuple[str, str]]:
    learned: list[tuple[str, str]] = []

    async def on_learned(channel_id: str, channel_type: Any) -> None:
        learned.append((channel_id, channel_type))
        if fail:
            raise RuntimeError("database unavailable")

    adapter.set_channel_type_handler(on_learned)
    return learned


def _message(activity_id: str) -> dict[str, Any]:
    return {
        "type": "message",
        "id": activity_id,
        "serviceUrl": "https://smba.example/amer/",
        "text": "<at>Switch</at> hello",
        "from": {"aadObjectId": "aad-1", "name": "alice"},
        "recipient": {"id": "28:app-123"},
        "conversation": {
            "id": f"{CHANNEL};messageid={activity_id}",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": CHANNEL}},
    }


def _bot_added() -> dict[str, Any]:
    return {
        "type": "conversationUpdate",
        "serviceUrl": "https://smba.example/amer/",
        "recipient": {"id": "28:app-123"},
        "membersAdded": [{"id": "28:app-123"}],
        "conversation": {"id": CHANNEL, "conversationType": "channel"},
        "channelData": {"channel": {"id": CHANNEL, "name": "Room"}},
    }


async def _add_bob(adapter: TeamsAdapter) -> list[str]:
    return await adapter.add_users_to_channel(CHANNEL, ["bob"], ["aad-bob"])


# ── Adding users ─────────────────────────────────────────────────────────────


async def test_activity_from_a_private_channel_does_not_open_it_to_the_team() -> None:
    # The create-with-people sequence: the bot's join and a message arrive from
    # the new private channel before anyone is added.
    adapter, graph = _adapter("private")
    await adapter.create_channel("Room", "topic", channel_type="channel_private")
    await adapter._dispatch_activity(_bot_added())
    await adapter._dispatch_activity(_message("m1"))

    assert await _add_bob(adapter) == []
    assert (graph.channel_members, graph.team_members) == (["aad-bob"], [])


@pytest.mark.parametrize(
    ("membership_type", "to_channel", "to_team"),
    [
        ("standard", [], ["aad-bob"]),
        ("private", ["aad-bob"], []),
        ("shared", ["aad-bob"], []),
    ],
)
async def test_after_a_restart_teams_is_asked_before_adding(
    membership_type: str, to_channel: list[str], to_team: list[str]
) -> None:
    adapter, graph = _adapter(membership_type)

    assert await _add_bob(adapter) == []
    assert graph.channel_reads == 1
    assert (graph.channel_members, graph.team_members) == (to_channel, to_team)


@pytest.mark.parametrize(
    ("membership_type", "team_id", "channel_id", "known"),
    [
        (None, "team-7", CHANNEL, None),
        ("standard", "", CHANNEL, None),
        ("standard", "team-7", CHAT, "group"),
    ],
    ids=["teams-cannot-say", "no-team-known", "group-chat"],
)
async def test_nobody_is_added_unless_the_channel_is_known(
    membership_type: str | None, team_id: str, channel_id: str, known: str | None
) -> None:
    adapter, graph = _adapter(membership_type)
    adapter._config.team_id = team_id
    if known:
        adapter._channel_type[channel_id] = known

    failed = await adapter.add_users_to_channel(
        channel_id, ["bob", "eve"], ["aad-bob", "aad-eve"]
    )

    assert failed == ["aad-bob", "aad-eve"]
    assert (graph.channel_members, graph.team_members) == ([], [])


async def test_reading_a_channel_needs_a_started_adapter() -> None:
    adapter, _ = _adapter("private")
    adapter._graph = None

    with pytest.raises(RuntimeError, match="not started"):
        await adapter.get_channel_type(CHANNEL)


# ── What inbound reports ─────────────────────────────────────────────────────


async def _via_message(adapter: TeamsAdapter) -> list[Any]:
    captured = _capture(adapter, "_on_message")
    await adapter._dispatch_activity(_message("m1"))
    return [m.channel_type for m in captured]


async def _via_bot_added(adapter: TeamsAdapter) -> list[Any]:
    captured = _capture(adapter, "_on_app_joined")
    await adapter._dispatch_activity(_bot_added())
    return [j.channel_type for j in captured]


async def _via_captured_message(adapter: TeamsAdapter) -> list[Any]:
    captured = _capture(adapter, "_on_message")
    await adapter._deliver_graph_message(
        {
            "id": "g1",
            "messageType": "message",
            "from": {"user": {"id": "aad-1", "displayName": "alice"}},
            "channelIdentity": {"teamId": "team-7", "channelId": CHANNEL},
            "body": {"contentType": "text", "content": "hello"},
        }
    )
    return [m.channel_type for m in captured]


@pytest.mark.parametrize(
    "deliver", [_via_message, _via_bot_added, _via_captured_message]
)
@pytest.mark.parametrize(
    ("membership_type", "reported"),
    [
        ("standard", "channel_public"),
        ("private", "channel_private"),
        (None, "channel_private"),
    ],
)
async def test_inbound_reports_what_teams_says_the_channel_is(
    deliver: Callable[[TeamsAdapter], Awaitable[list[Any]]],
    membership_type: str | None,
    reported: str,
) -> None:
    # A room auto-created for the channel is saved with this type. When Teams
    # cannot say it is reported private, but not cached, so adding still asks.
    adapter, _ = _adapter(membership_type)

    assert await deliver(adapter) == [reported]
    assert adapter._channel_type.get(CHANNEL) == (reported if membership_type else None)


@pytest.mark.parametrize("membership_type", ["private", None])
async def test_a_channel_is_read_and_warned_about_at_most_once(
    membership_type: str | None, caplog: pytest.LogCaptureFixture
) -> None:
    # A failed read is not retried, nor warned about again, in the retry window.
    adapter, graph = _adapter(membership_type)
    _capture(adapter, "_on_message")

    with caplog.at_level(logging.WARNING):
        await adapter._dispatch_activity(_message("m1"))
        await adapter._dispatch_activity(_message("m2"))

    assert graph.channel_reads == 1
    warnings = [r for r in caplog.records if CHANNEL in r.getMessage()]
    assert len(warnings) == (0 if membership_type else 1)


@pytest.mark.parametrize(
    "conversation",
    [{"id": CHAT, "conversationType": "groupChat"}, {"id": CHAT}],
    ids=["said-by-activity", "already-known"],
)
async def test_a_chat_is_not_mistaken_for_a_channel(
    conversation: dict[str, str],
) -> None:
    # An activity with no conversation type is channel-shaped by default, so a
    # chat already known to be one must stay one.
    adapter, graph = _adapter("standard")
    adapter._channel_type[CHAT] = "group"
    captured = _capture(adapter, "_on_message")
    activity = _message("m1")
    activity["conversation"] = conversation
    activity["channelData"] = {}

    await adapter._dispatch_activity(activity)

    assert [m.channel_type for m in captured] == ["group"]
    assert graph.channel_reads == 0


async def test_a_conversation_update_adding_nobody_does_not_read_the_channel() -> None:
    adapter, graph = _adapter(None)
    activity = _bot_added()
    activity["membersAdded"] = []
    activity["channelData"]["eventType"] = "channelDeleted"

    await adapter._dispatch_activity(activity)

    assert graph.channel_reads == 0


# ── Reporting learned types, so saved rooms are corrected ────────────────────


async def test_refresh_reports_what_teams_says_and_skips_failures() -> None:
    adapter, graph = _adapter("standard")
    graph.by_channel = {"19:prv@thread.tacv2": "private", "19:bad@thread.tacv2": None}
    learned = _capture_learned(adapter, fail=False)

    await adapter.refresh_channel_types(
        ["19:std@thread.tacv2", "19:prv@thread.tacv2", "19:bad@thread.tacv2"]
    )

    assert learned == [
        ("19:std@thread.tacv2", "channel_public"),
        ("19:prv@thread.tacv2", "channel_private"),
    ]


@pytest.mark.parametrize("recording_fails", [False, True])
async def test_a_type_learned_at_runtime_is_reported(recording_fails: bool) -> None:
    # The first successful read after startup corrects the saved room too, and
    # failing to record it must not stop the adapter acting on what it learned.
    adapter, graph = _adapter("private")
    learned = _capture_learned(adapter, fail=recording_fails)

    assert await _add_bob(adapter) == []
    assert learned == [(CHANNEL, "channel_private")]
    assert (graph.channel_members, graph.team_members) == (["aad-bob"], [])


async def test_a_successful_read_lifts_the_retry_wait_for_every_path() -> None:
    # A failed read delays re-reading the name and layout; a later successful
    # privacy read must lift that wait.
    adapter, graph = _adapter(None)
    await adapter._read_channel(CHANNEL)
    assert adapter._read_recently_failed(CHANNEL)

    graph.membership_type = "private"
    assert await adapter.get_channel_type(CHANNEL) == "channel_private"

    assert not adapter._read_recently_failed(CHANNEL)
    assert adapter._channel_names[CHANNEL] == "Room"
