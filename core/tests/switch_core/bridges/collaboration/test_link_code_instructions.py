"""Each platform says how to post a link code where Switch will hear it
(CHOO-3881)."""

from __future__ import annotations

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter

_CODE = "7KQ2-M9XD"


def test_the_default_is_the_typed_command() -> None:
    text = PlatformAdapter.link_code_instructions(_CODE, {})
    assert f"`!link-account {_CODE}`" in text


def test_slack_uses_the_typed_command() -> None:
    # Slack apps set up before the slash command existed do not have it.
    assert "`!link-account" in SlackAdapter.link_code_instructions(_CODE, {})
    assert "/link-account" not in SlackAdapter.link_code_instructions(_CODE, {})


def test_mattermost_needs_a_channel_with_an_agent_and_says_what_to_do_without_one() -> (
    None
):
    text = MattermostAdapter.link_code_instructions(_CODE, {})
    assert "channel that has a Switch agent in it" in text
    assert "No agent yet? Add one first, then get a new code here." in text


def test_the_shared_discord_connection_takes_only_the_slash_command() -> None:
    shared = DiscordAdapter.link_code_instructions(_CODE, {"event_delivery": "shared"})
    own = DiscordAdapter.link_code_instructions(
        _CODE, {"event_delivery": "own_connection"}
    )
    assert f"`/link-account code:{_CODE}`" in shared
    assert "!link-account" not in shared
    assert f"`!link-account {_CODE}`" in own


def test_teams_mentions_the_app() -> None:
    text = TeamsAdapter.link_code_instructions(_CODE, {})
    assert "@mention the Switch app" in text
    assert f"`link-account {_CODE}`" in text


def test_telegram_uses_its_command_spelling() -> None:
    assert f"`/link_account {_CODE}`" in TelegramAdapter.link_code_instructions(
        _CODE, {}
    )
