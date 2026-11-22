"""Each bridge names the channel it makes for a room the way `channel_name_for`
says, and hands back the name the platform actually gave it, so the room can
tell a later rename of that channel from the name it was made with."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter

ROOM_NAMES = [
    "Payments Team",
    "Bug/fix #42: urgent!",
    "  Release   Train  ",
    "Ünïcödé café",
    "x" * 120,
]


class _SlackWeb:
    def __init__(self, taken: frozenset[str] = frozenset()) -> None:
        self.names: list[str] = []
        self._taken = taken

    async def conversations_create(self, *, name: str, is_private: bool) -> Any:
        self.names.append(name)
        if name in self._taken:
            raise SlackApiError("name_taken", response={"error": "name_taken"})
        return {"channel": {"id": f"C{len(self.names)}", "name": name}}

    async def conversations_setTopic(self, **_: Any) -> Any:
        return {"ok": True}


def _slack() -> tuple[SlackAdapter, _SlackWeb]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    web = _SlackWeb()
    adapter._web_client = web  # type: ignore[assignment]
    return adapter, web


@pytest.mark.parametrize("room_name", ROOM_NAMES)
async def test_slack_makes_the_channel_channel_name_for_names(room_name: str) -> None:
    adapter, web = _slack()
    created = await adapter.create_channel(room_name, "topic")
    assert web.names == [SlackAdapter.channel_name_for(room_name)]
    assert created.name == SlackAdapter.channel_name_for(room_name)
    assert adapter._channel_name_cache[created.id] == created.name


async def test_slack_hands_back_the_suffixed_name_when_the_first_is_taken() -> None:
    adapter, _ = _slack()
    web = _SlackWeb(taken=frozenset({"payments-team"}))
    adapter._web_client = web  # type: ignore[assignment]
    created = await adapter.create_channel("Payments Team", "topic")
    assert web.names[0] == "payments-team"
    assert re.fullmatch(r"payments-team-[0-9a-f]{8}", created.name)
    assert created.name == web.names[1]


class _MattermostChannels:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create_channel(self, options: dict[str, Any]) -> dict[str, Any]:
        self.created.append(options)
        return {"id": "mm-1", **options}


@pytest.mark.parametrize("room_name", ROOM_NAMES)
async def test_mattermost_shows_the_room_name_as_it_is(room_name: str) -> None:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    channels = _MattermostChannels()
    adapter._admin_driver = type("_Driver", (), {"channels": channels})()  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_running_loop()

    async def no_default_member(channel_id: str) -> None:
        return None

    adapter._add_default_member = no_default_member  # type: ignore[method-assign]
    created = await adapter.create_channel(room_name, "topic")
    assert channels.created[0]["display_name"] == room_name
    assert created.name == MattermostAdapter.channel_name_for(room_name) == room_name


class _DiscordChannel:
    def __init__(self, name: str) -> None:
        self.id = 101
        self.name = name


class _DiscordGuild:
    def __init__(self) -> None:
        self.names: list[str] = []

    async def create_text_channel(self, *, name: str, **_: Any) -> _DiscordChannel:
        self.names.append(name)
        return _DiscordChannel(name)


@pytest.mark.parametrize("room_name", ROOM_NAMES)
async def test_discord_makes_the_channel_channel_name_for_names(room_name: str) -> None:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id="900")
    )
    guild = _DiscordGuild()

    async def get_guild() -> _DiscordGuild:
        return guild

    adapter._get_guild = get_guild  # type: ignore[method-assign,assignment]
    created = await adapter.create_channel(room_name, "topic")
    assert guild.names == [DiscordAdapter.channel_name_for(room_name)]
    assert created.name == guild.names[0]


class _TeamsGraph:
    def __init__(self) -> None:
        self.names: list[str] = []

    async def create_channel(self, *, display_name: str, **_: Any) -> dict[str, Any]:
        self.names.append(display_name)
        return {"id": "19:new@thread.tacv2", "displayName": display_name}

    async def create_subscription(self, **_: Any) -> dict[str, Any]:
        return {"id": "SUB-X"}


@pytest.mark.parametrize("room_name", ROOM_NAMES)
async def test_teams_makes_the_channel_channel_name_for_names(room_name: str) -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    graph = _TeamsGraph()
    adapter._graph = graph  # type: ignore[assignment]
    created = await adapter.create_channel(room_name, "topic")
    assert graph.names == [TeamsAdapter.channel_name_for(room_name)]
    assert created.name == graph.names[0]
    assert adapter._channel_names[created.id] == created.name


def test_telegram_cannot_make_a_chat_so_leaves_the_name_alone() -> None:
    assert TelegramAdapter.channel_name_for("Payments Team") == "Payments Team"


def test_channel_names_follow_each_platforms_rules() -> None:
    assert SlackAdapter.channel_name_for("Payments Team") == "payments-team"
    assert len(SlackAdapter.channel_name_for("x" * 120)) == 80
    assert DiscordAdapter.channel_name_for("My Feature Room!") == "my-feature-room"
    assert TeamsAdapter.channel_name_for("bug/fix #42: urgent!") == (
        "bug-fix -42- urgent!"
    )
    assert TeamsAdapter.channel_name_for("  ...  ") == "switch"
    assert len(TeamsAdapter.channel_name_for("x" * 80)) == 50
