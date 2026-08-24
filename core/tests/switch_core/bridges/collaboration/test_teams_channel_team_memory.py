"""A Teams channel's team has to outlive the process that learned it.

A Graph message subscription is created against
``teams/{team}/channels/{channel}/messages``. The team arrives only in the
``channelData`` of an inbound activity, and the bridge's configured ``team_id``
is merely the team it *provisions into* — a channel the bot was added to in
some other team belongs to none of it.

Held in memory alone, the mapping was lost on every restart and those channels
fell back to the configured team, where Graph answers "Channel is not present
in the team". Nothing recovered it either: refilling the map needs an activity
from that channel, and without capture Teams delivers only messages that
mention the bot — so addressing an *agent*, the normal way to use the room,
never arrived.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_CONFIGURED_TEAM = "team-configured"
_OTHER_TEAM = "team-elsewhere"
_CHANNEL = "19:elsewhere@thread.tacv2"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _config(**overrides: Any) -> TeamsConnectionConfig:
    return TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-9",
        team_id=_CONFIGURED_TEAM,
        public_base_url="https://switch.example",
        client_state="s3cr3t",
        **overrides,
    )


def _activity_from(team_id: str) -> dict[str, Any]:
    """A conversationUpdate naming the team the channel actually lives in."""
    return {
        "type": "conversationUpdate",
        "id": "act-1",
        "serviceUrl": "https://smba.example",
        "conversation": {"id": _CHANNEL, "conversationType": "channel"},
        "channelData": {
            "channel": {"id": _CHANNEL, "name": "Agent Switch Test"},
            "team": {"id": "19:teamthread@thread.tacv2", "aadGroupId": team_id},
        },
        "membersAdded": [],
        "recipient": {"id": "28:bot"},
    }


def test_the_team_of_a_channel_is_persisted_when_it_is_learned() -> None:
    adapter = TeamsAdapter(config=_config())
    saved: list[tuple[str, str]] = []

    async def persist(channel_id: str, team_id: str) -> None:
        saved.append((channel_id, team_id))

    adapter.set_channel_team_persister(persist)
    _run(adapter._dispatch_activity(_activity_from(_OTHER_TEAM)))

    assert saved == [(_CHANNEL, _OTHER_TEAM)]


def test_a_persisted_team_is_known_before_any_activity_arrives() -> None:
    # The restart case: the adapter comes up knowing what the last one learned,
    # so capture is re-established without the bot having to be mentioned.
    adapter = TeamsAdapter(config=_config(channel_teams={_CHANNEL: _OTHER_TEAM}))

    assert adapter._team_of_channel[_CHANNEL] == _OTHER_TEAM


def test_without_it_the_channel_falls_back_to_the_wrong_team() -> None:
    # The bug, pinned: this is what Graph refuses with "Channel is not present
    # in the team".
    adapter = TeamsAdapter(config=_config())

    assert adapter._team_of_channel.get(_CHANNEL) is None
    assert adapter._config.team_id == _CONFIGURED_TEAM


def test_the_same_team_is_not_written_twice() -> None:
    # Every inbound activity carries the team; persisting on each one would be
    # a database write per message.
    adapter = TeamsAdapter(config=_config())
    writes: list[tuple[str, str]] = []

    async def persist(channel_id: str, team_id: str) -> None:
        writes.append((channel_id, team_id))

    adapter.set_channel_team_persister(persist)
    _run(adapter._dispatch_activity(_activity_from(_OTHER_TEAM)))
    _run(adapter._dispatch_activity(_activity_from(_OTHER_TEAM)))

    assert len(writes) == 1


def test_a_channel_that_moves_team_is_written_again() -> None:
    adapter = TeamsAdapter(config=_config(channel_teams={_CHANNEL: _CONFIGURED_TEAM}))
    writes: list[tuple[str, str]] = []

    async def persist(channel_id: str, team_id: str) -> None:
        writes.append((channel_id, team_id))

    adapter.set_channel_team_persister(persist)
    _run(adapter._dispatch_activity(_activity_from(_OTHER_TEAM)))

    assert writes == [(_CHANNEL, _OTHER_TEAM)]
    assert adapter._team_of_channel[_CHANNEL] == _OTHER_TEAM


def test_a_failing_persister_does_not_break_the_activity() -> None:
    # The write is bookkeeping. Losing it costs capture after the next restart,
    # which is worth a warning — not dropping the message being handled.
    adapter = TeamsAdapter(config=_config())

    async def persist(channel_id: str, team_id: str) -> None:
        raise RuntimeError("database is down")

    adapter.set_channel_team_persister(persist)
    _run(adapter._dispatch_activity(_activity_from(_OTHER_TEAM)))

    assert adapter._team_of_channel[_CHANNEL] == _OTHER_TEAM


def test_an_adapter_with_no_persister_still_works() -> None:
    # Adapters are constructed directly in tests and tools, without a bridge
    # behind them to persist anything.
    adapter = TeamsAdapter(config=_config())

    _run(adapter._dispatch_activity(_activity_from(_OTHER_TEAM)))

    assert adapter._team_of_channel[_CHANNEL] == _OTHER_TEAM
