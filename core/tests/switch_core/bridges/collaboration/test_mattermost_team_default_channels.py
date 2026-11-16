"""An agent's bot landing in a team's default channels bridges nothing.

Mattermost puts every account added to a team in Town Square and Off-Topic,
agents' bots included, so a new agent used to be bridged into both — channels
of company-wide chatter nobody chose to give it. A bot is now taken out of
Off-Topic, stays in Town Square only because Mattermost allows nobody but a
guest to leave it, and neither is bridged until a room is connected to it.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    InboundAgentJoin,
    InboundCommand,
    InboundMessage,
)

_BOT = "bot-1"
_PERSON = "person-1"
_TOWN = {
    "id": "c-town",
    "type": "O",
    "name": "town-square",
    "display_name": "Town Square",
}
_OFF = {"id": "c-off", "type": "O", "name": "off-topic", "display_name": "Off-Topic"}
_ENG = {"id": "c-eng", "type": "O", "name": "eng", "display_name": "Engineering"}


class _Channels:
    def __init__(self, member_of: list[dict[str, str]], refuse_leave: bool) -> None:
        self._member_of = member_of
        self._refuse_leave = refuse_leave
        self.removed: list[tuple[str, str]] = []

    def get_channels_for_user(self, user_id: str, team_id: str) -> Any:
        return self._member_of

    def get_channel(self, channel_id: str) -> dict[str, str]:
        return next(c for c in [_TOWN, _OFF, _ENG] if c["id"] == channel_id)

    def remove_channel_member(self, channel_id: str, user_id: str) -> None:
        if self._refuse_leave:
            raise RuntimeError("Mattermost refused")
        self.removed.append((channel_id, user_id))


class _Users:
    def get_user(self, user_id: str) -> dict[str, str]:
        return {"id": user_id, "username": "ada"}


class _Driver:
    def __init__(self, channels: _Channels) -> None:
        self.channels = channels
        self.users = _Users()


def _adapter(
    member_of: list[dict[str, str]],
    *,
    connected: set[str],
    refuse_leave: bool = False,
) -> tuple[MattermostAdapter, _Channels, list[Any]]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    channels = _Channels(member_of, refuse_leave)
    adapter._admin_driver = _Driver(channels)  # type: ignore[assignment]
    adapter._team_id = "team-1"
    adapter._bot_id_to_username[_BOT] = "worker"
    adapter.set_member_sync_hooks(
        bridged_channels=lambda: connected, request_sync=lambda ids: None
    )
    seen: list[Any] = []

    async def record(event: Any) -> None:
        seen.append(event)

    adapter._on_agent_joined = record
    adapter._on_message = record
    adapter._on_command = record
    return adapter, channels, seen


def _sweep(adapter: MattermostAdapter) -> None:
    async def go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        await adapter._bridge_channels_already_joined("worker", _BOT)

    asyncio.run(go())


def _ws(adapter: MattermostAdapter, event: dict[str, Any]) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "worker"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def _user_added(channel: dict[str, str]) -> dict[str, Any]:
    return {
        "event": "user_added",
        "data": {"user_id": _BOT, "team_id": "team-1"},
        "broadcast": {"channel_id": channel["id"]},
    }


def _posted(channel: dict[str, str], message: str) -> dict[str, Any]:
    post = {
        "id": f"post-{channel['id']}-{message}",
        "user_id": _PERSON,
        "channel_id": channel["id"],
        "message": message,
    }
    return {
        "event": "posted",
        "data": {
            "post": json.dumps(post),
            "channel_type": "O",
            "channel_name": channel["name"],
            "channel_display_name": channel["display_name"],
        },
    }


def test_a_new_bot_leaves_off_topic_and_bridges_neither_default() -> None:
    adapter, channels, seen = _adapter([_TOWN, _OFF, _ENG], connected=set())

    _sweep(adapter)

    assert [join.channel_id for join in seen] == ["c-eng"]
    # Town Square cannot be left, so nothing is asked of it.
    assert channels.removed == [("c-off", _BOT)]


def test_a_default_channel_with_a_room_is_bridged_and_kept() -> None:
    adapter, channels, seen = _adapter([_TOWN, _OFF], connected={"c-town", "c-off"})

    _sweep(adapter)

    assert [join.channel_id for join in seen] == ["c-town", "c-off"]
    assert all(isinstance(join, InboundAgentJoin) for join in seen)
    assert channels.removed == []


def test_a_refused_leave_still_bridges_nothing() -> None:
    adapter, _, seen = _adapter([_OFF], connected=set(), refuse_leave=True)

    _sweep(adapter)

    assert seen == []


def test_an_overheard_join_to_town_square_bridges_nothing() -> None:
    adapter, _, seen = _adapter([], connected=set())

    _ws(adapter, _user_added(_TOWN))

    assert seen == []


def test_adding_a_bot_back_to_off_topic_bridges_it() -> None:
    # Off-Topic is left on joining the team, so a later add is someone's choice.
    adapter, _, seen = _adapter([], connected=set())

    _ws(adapter, _user_added(_OFF))

    assert [join.channel_id for join in seen] == ["c-off"]


def test_chatter_in_an_unconnected_town_square_makes_no_room() -> None:
    adapter, _, seen = _adapter([], connected=set())

    _ws(adapter, _posted(_TOWN, "lunch anyone?"))

    assert seen == []


def test_a_command_in_town_square_still_reaches_switch() -> None:
    adapter, _, seen = _adapter([], connected=set())

    _ws(adapter, _posted(_TOWN, "!invite-agent @worker"))

    [command] = seen
    assert isinstance(command, InboundCommand)
    assert command.command == "invite-agent"


def test_a_connected_town_square_is_relayed() -> None:
    adapter, _, seen = _adapter([], connected={"c-town"})

    _ws(adapter, _posted(_TOWN, "lunch anyone?"))

    [message] = seen
    assert isinstance(message, InboundMessage)
    assert message.content == "lunch anyone?"
