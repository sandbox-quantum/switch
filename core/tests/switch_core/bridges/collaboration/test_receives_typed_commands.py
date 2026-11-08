"""Each platform says whether a `!` command typed in a room reaches Switch."""

from __future__ import annotations

from switch_core import messaging_platforms
from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter


def test_by_default_a_typed_command_arrives() -> None:
    assert PlatformAdapter.receives_typed_commands({}) is True
    assert SlackAdapter.receives_typed_commands({"event_delivery": "webhook"}) is True
    # Only Discord reads `event_delivery` here.
    assert TeamsAdapter.receives_typed_commands({"event_delivery": "shared"}) is True
    assert TelegramAdapter.receives_typed_commands({"event_delivery": "shared"}) is True


def test_the_shared_discord_connection_is_given_no_typed_command() -> None:
    assert DiscordAdapter.receives_typed_commands({"event_delivery": "shared"}) is False
    assert (
        DiscordAdapter.receives_typed_commands({"event_delivery": "own_connection"})
        is True
    )
    # A config from before the setting existed is on its own connection.
    assert DiscordAdapter.receives_typed_commands({}) is True


def test_the_platform_directory_answers_as_the_adapter_does() -> None:
    discord = messaging_platforms.lookup("discord")
    slack = messaging_platforms.lookup("slack")
    assert discord is not None
    assert slack is not None
    assert discord.receives_typed_commands({"event_delivery": "shared"}) is False
    assert discord.receives_typed_commands({"event_delivery": "own_connection"})
    assert slack.receives_typed_commands({"event_delivery": "webhook"})
