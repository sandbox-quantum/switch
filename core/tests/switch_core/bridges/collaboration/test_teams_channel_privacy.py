"""Whether a Teams channel is private decides who a user is added to.

A standard channel shares its team's membership, so adding someone to it adds
them to the team. A private or shared channel keeps its own member list. Calling
a private channel standard therefore adds the user to the entire team, with no
error — so the adapter must only ever act on privacy it actually knows.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.models import InboundAppJoin, InboundMessage
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

CHANNEL = "19:new@thread.tacv2"


def _config() -> TeamsConnectionConfig:
    return TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-9",
        team_id="team-7",
        public_base_url="https://switch.example",
        client_state="s3cr3t",
    )


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeGraph:
    """Graph as far as channel privacy and membership go.

    ``membership_type`` is what Graph reports for every channel; None makes the
    read fail, as it does without permission or during an outage."""

    def __init__(self, *, membership_type: str | None) -> None:
        self._membership_type = membership_type
        self.channel_reads = 0
        self.channel_members: list[str] = []
        self.team_members: list[str] = []

    async def create_channel(
        self,
        *,
        team_id: str,
        display_name: str,
        description: str,
        membership_type: str,
    ) -> dict[str, Any]:
        return {"id": CHANNEL, "displayName": display_name}

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        self.channel_reads += 1
        if self._membership_type is None:
            raise RuntimeError("Graph refused the read")
        return {
            "id": channel_id,
            "displayName": "Room",
            "membershipType": self._membership_type,
            "layoutType": "chat",
        }

    async def add_channel_member(
        self, *, team_id: str, channel_id: str, user_aad_id: str
    ) -> None:
        self.channel_members.append(user_aad_id)

    async def add_team_member(self, *, team_id: str, user_aad_id: str) -> None:
        self.team_members.append(user_aad_id)

    async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
        return {"id": "SUB-X"}


def _adapter(graph: _FakeGraph) -> TeamsAdapter:
    adapter = TeamsAdapter(config=_config())
    adapter._graph = graph  # type: ignore[assignment]
    return adapter


def _message_activity() -> dict[str, Any]:
    return {
        "type": "message",
        "id": "m1",
        "serviceUrl": "https://smba.example/amer/",
        "text": "<at>Switch</at> hello",
        "from": {"aadObjectId": "aad-1", "name": "alice"},
        "recipient": {"id": "28:app-123"},
        "conversation": {
            "id": f"{CHANNEL};messageid=m1",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": CHANNEL}},
    }


def _bot_added_activity() -> dict[str, Any]:
    return {
        "type": "conversationUpdate",
        "serviceUrl": "https://smba.example/amer/",
        "recipient": {"id": "28:app-123"},
        "membersAdded": [{"id": "28:app-123"}],
        "conversation": {"id": CHANNEL, "conversationType": "channel"},
        "channelData": {"channel": {"id": CHANNEL, "name": "Room"}},
    }


def _capture_messages(adapter: TeamsAdapter) -> list[InboundMessage]:
    captured: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        captured.append(msg)

    adapter._on_message = on_message
    return captured


def _capture_app_joins(adapter: TeamsAdapter) -> list[InboundAppJoin]:
    joins: list[InboundAppJoin] = []

    async def on_app_joined(join: InboundAppJoin) -> None:
        joins.append(join)

    adapter._on_app_joined = on_app_joined
    return joins


# ── Adding users ─────────────────────────────────────────────────────────────


def test_activity_from_a_private_channel_does_not_open_it_to_the_team() -> None:
    # Switch creates a private channel, then the bot's own join and a message
    # arrive from it before anyone is added — the ordinary create-with-people
    # sequence.
    graph = _FakeGraph(membership_type="private")
    adapter = _adapter(graph)
    _run(adapter.create_channel("Room", "topic", channel_type="channel_private"))

    _run(adapter._dispatch_activity(_bot_added_activity()))
    _run(adapter._dispatch_activity(_message_activity()))
    failed = _run(adapter.add_users_to_channel(CHANNEL, ["bob"], ["aad-bob"]))

    assert failed == []
    assert graph.channel_members == ["aad-bob"]
    assert graph.team_members == []
    assert _run(adapter.get_channel_type(CHANNEL)) == "channel_private"


def test_after_a_restart_privacy_is_asked_of_teams_before_adding() -> None:
    # A fresh adapter knows nothing about the channel, as after a restart.
    graph = _FakeGraph(membership_type="private")
    adapter = _adapter(graph)

    failed = _run(adapter.add_users_to_channel(CHANNEL, ["bob"], ["aad-bob"]))

    assert failed == []
    assert graph.channel_reads == 1
    assert graph.channel_members == ["aad-bob"]
    assert graph.team_members == []


def test_a_standard_channel_still_adds_users_to_the_team() -> None:
    graph = _FakeGraph(membership_type="standard")
    adapter = _adapter(graph)

    failed = _run(adapter.add_users_to_channel(CHANNEL, ["bob"], ["aad-bob"]))

    assert failed == []
    assert graph.team_members == ["aad-bob"]
    assert graph.channel_members == []


def test_a_shared_channel_is_private() -> None:
    # A shared channel has its own members; adding to the host team is wrong.
    graph = _FakeGraph(membership_type="shared")
    adapter = _adapter(graph)

    _run(adapter.add_users_to_channel(CHANNEL, ["bob"], ["aad-bob"]))

    assert graph.channel_members == ["aad-bob"]
    assert graph.team_members == []


def test_when_teams_cannot_say_nobody_is_added() -> None:
    graph = _FakeGraph(membership_type=None)
    adapter = _adapter(graph)

    failed = _run(
        adapter.add_users_to_channel(CHANNEL, ["bob", "eve"], ["aad-bob", "aad-eve"])
    )

    assert failed == ["aad-bob", "aad-eve"]
    assert graph.team_members == []
    assert graph.channel_members == []


def test_users_are_not_added_to_the_team_for_a_group_chat() -> None:
    graph = _FakeGraph(membership_type="standard")
    adapter = _adapter(graph)
    adapter._channel_type["19:chat@thread.v2"] = "group"

    failed = _run(
        adapter.add_users_to_channel("19:chat@thread.v2", ["bob"], ["aad-bob"])
    )

    assert failed == ["aad-bob"]
    assert graph.team_members == []


# ── What inbound reports ─────────────────────────────────────────────────────


def test_bot_added_to_a_private_channel_reports_it_private() -> None:
    # This is what a room auto-created for the channel is labelled with.
    graph = _FakeGraph(membership_type="private")
    adapter = _adapter(graph)
    joins = _capture_app_joins(adapter)

    _run(adapter._dispatch_activity(_bot_added_activity()))

    assert [j.channel_type for j in joins] == ["channel_private"]


def test_message_from_a_standard_channel_reports_it_public() -> None:
    graph = _FakeGraph(membership_type="standard")
    adapter = _adapter(graph)
    captured = _capture_messages(adapter)

    _run(adapter._dispatch_activity(_message_activity()))

    assert [m.channel_type for m in captured] == ["channel_public"]


def test_privacy_is_read_once_per_channel() -> None:
    graph = _FakeGraph(membership_type="private")
    adapter = _adapter(graph)
    _capture_messages(adapter)

    _run(adapter._dispatch_activity(_message_activity()))
    second = _message_activity()
    second["id"] = "m2"
    _run(adapter._dispatch_activity(second))

    assert graph.channel_reads == 1


def test_a_channel_teams_cannot_describe_is_reported_private_but_not_recorded() -> None:
    graph = _FakeGraph(membership_type=None)
    adapter = _adapter(graph)
    captured = _capture_messages(adapter)

    _run(adapter._dispatch_activity(_message_activity()))

    assert [m.channel_type for m in captured] == ["channel_private"]
    # A guess is never stored: adding users must still ask Teams.
    assert CHANNEL not in adapter._channel_type


def test_captured_message_from_a_private_channel_reports_it_private() -> None:
    graph = _FakeGraph(membership_type="private")
    adapter = _adapter(graph)
    captured = _capture_messages(adapter)

    _run(
        adapter._deliver_graph_message(
            {
                "id": "g1",
                "messageType": "message",
                "from": {"user": {"id": "aad-1", "displayName": "alice"}},
                "channelIdentity": {"teamId": "team-7", "channelId": CHANNEL},
                "body": {"contentType": "text", "content": "hello"},
            }
        )
    )

    assert [m.channel_type for m in captured] == ["channel_private"]


# ── Correcting saved rooms at startup ────────────────────────────────────────


class _PerChannelGraph(_FakeGraph):
    def __init__(self, types: dict[str, str | None]) -> None:
        super().__init__(membership_type="standard")
        self._types = types

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        membership = self._types[channel_id]
        if membership is None:
            raise RuntimeError("Graph refused the read")
        return {"id": channel_id, "membershipType": membership}


def test_read_channel_types_reports_what_teams_says_and_skips_failures() -> None:
    graph = _PerChannelGraph(
        {
            "19:std@thread.tacv2": "standard",
            "19:prv@thread.tacv2": "private",
            "19:bad@thread.tacv2": None,
        }
    )
    adapter = _adapter(graph)

    types = _run(
        adapter.read_channel_types(
            ["19:std@thread.tacv2", "19:prv@thread.tacv2", "19:bad@thread.tacv2"]
        )
    )

    assert types == {
        "19:std@thread.tacv2": "channel_public",
        "19:prv@thread.tacv2": "channel_private",
    }


def test_a_known_chat_is_not_mistaken_for_a_channel() -> None:
    # An activity without a recognised conversation type is channel-shaped by
    # default; a conversation already known to be a group chat stays one.
    graph = _FakeGraph(membership_type="standard")
    adapter = _adapter(graph)
    adapter._channel_type["19:chat@thread.v2"] = "group"
    captured = _capture_messages(adapter)
    activity = _message_activity()
    activity["conversation"] = {"id": "19:chat@thread.v2"}
    activity["channelData"] = {}

    _run(adapter._dispatch_activity(activity))

    assert [m.channel_type for m in captured] == ["group"]
    assert graph.channel_reads == 0


def test_a_successful_read_lifts_the_retry_wait_for_every_path() -> None:
    # A failed read makes the adapter wait before trying again for the name and
    # layout; a later successful privacy read must lift that wait.
    graph = _FakeGraph(membership_type=None)
    adapter = _adapter(graph)
    _run(adapter._read_channel(CHANNEL))
    assert adapter._read_recently_failed(CHANNEL)

    graph._membership_type = "private"
    assert _run(adapter.get_channel_type(CHANNEL)) == "channel_private"

    assert not adapter._read_recently_failed(CHANNEL)
    assert adapter._channel_names[CHANNEL] == "Room"
