"""An agent's existing Mattermost channels are bridged without being overheard.

A Mattermost bot never witnesses its own joins: its websocket opens only after
it has been added to the team, and Mattermost has by then already dropped it
into the team's default channels. Adoption used to depend entirely on those
`user_added` broadcasts, so a join was noticed only when some *other* agent's
socket happened to be listening — the first agent on an instance bridged
nothing at all, and the second one dragged Town Square and Off-Topic in behind
it.

So the adapter asks Mattermost which channels the bot is in rather than waiting
to overhear it (CHOO-2203).
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundAgentJoin


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )


class _Channels:
    def __init__(self, channels: list[dict[str, str]] | Exception) -> None:
        self._channels = channels
        self.calls: list[tuple[str, str]] = []

    def get_channels_for_user(self, user_id: str, team_id: str) -> Any:
        self.calls.append((user_id, team_id))
        if isinstance(self._channels, Exception):
            raise self._channels
        return self._channels


class _Driver:
    def __init__(self, channels: _Channels) -> None:
        self.channels = channels


def _wire(
    adapter: MattermostAdapter, channels: list[dict[str, str]] | Exception
) -> tuple[_Channels, list[InboundAgentJoin]]:
    endpoint = _Channels(channels)
    adapter._admin_driver = _Driver(endpoint)  # type: ignore[assignment]
    adapter._team_id = "team-1"
    seen: list[InboundAgentJoin] = []

    async def on_agent_joined(join: InboundAgentJoin) -> None:
        seen.append(join)

    adapter._on_agent_joined = on_agent_joined
    return endpoint, seen


def _run(adapter: MattermostAdapter, agent: str = "worker") -> None:
    async def go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter._bridge_channels_already_joined(agent, "bot-1")

    asyncio.run(go())


def test_bridges_every_channel_the_bot_is_already_in() -> None:
    # The exact shape of a first agent's membership: Mattermost put it in both
    # defaults at team-join, and nobody was listening when it happened.
    adapter = _adapter()
    endpoint, seen = _wire(
        adapter,
        [
            {"id": "c-town", "type": "O", "display_name": "Town Square"},
            {"id": "c-off", "type": "O", "display_name": "Off-Topic"},
        ],
    )

    _run(adapter)

    assert endpoint.calls == [("bot-1", "team-1")]
    assert [join.channel_id for join in seen] == ["c-town", "c-off"]
    assert [join.channel_name for join in seen] == ["Town Square", "Off-Topic"]
    assert {join.agent_name for join in seen} == {"worker"}


def test_carries_the_channel_type_across() -> None:
    # The room is provisioned from this, so a private channel must not be
    # bridged as a public one.
    adapter = _adapter()
    _, seen = _wire(
        adapter,
        [
            {"id": "c-pub", "type": "O", "display_name": "Public"},
            {"id": "c-priv", "type": "P", "display_name": "Private"},
            {"id": "c-dm", "type": "D", "display_name": ""},
        ],
    )

    _run(adapter)

    assert [join.channel_type for join in seen] == [
        "channel_public",
        "channel_private",
        "direct",
    ]


def test_one_unbridgeable_channel_does_not_strand_the_others() -> None:
    # This runs inside agent registration, so a single bad channel must not take
    # the agent's other rooms — or the registration itself — down with it.
    adapter = _adapter()
    _, seen = _wire(
        adapter,
        [
            {"id": "c-bad", "type": "O", "display_name": "Bad"},
            {"id": "c-good", "type": "O", "display_name": "Good"},
        ],
    )
    failed: list[str] = []

    async def on_agent_joined(join: InboundAgentJoin) -> None:
        if join.channel_id == "c-bad":
            failed.append(join.channel_id)
            raise RuntimeError("room provisioning blew up")
        seen.append(join)

    adapter._on_agent_joined = on_agent_joined

    _run(adapter)

    assert failed == ["c-bad"]
    assert [join.channel_id for join in seen] == ["c-good"]


def test_a_failed_listing_is_survivable() -> None:
    # Mattermost being unreachable at this moment must not fail the agent.
    adapter = _adapter()
    _, seen = _wire(adapter, RuntimeError("mattermost down"))

    _run(adapter)

    assert seen == []


def test_does_nothing_before_the_bridge_is_wired() -> None:
    adapter = _adapter()
    endpoint, _ = _wire(adapter, [{"id": "c", "type": "O", "display_name": "C"}])
    adapter._on_agent_joined = None  # type: ignore[assignment]

    _run(adapter)

    assert endpoint.calls == []
