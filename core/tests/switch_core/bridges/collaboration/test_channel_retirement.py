"""Each platform retires a deleted room's channel as far as it allows, and
declares beforehand what that will be.

The platform calls are recorded rather than made: each test asserts the call
the adapter sends and how it reads what the platform answers.
"""

from __future__ import annotations

import asyncio
from typing import Any

import discord
from slack_sdk.errors import SlackApiError
from telegram.error import BadRequest, Forbidden

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import RetireOutcome
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)

ARCHIVED = RetireOutcome(outcome="archived")


def test_every_platform_declares_what_deleting_a_room_does() -> None:
    assert {p.key: p.adapter.channel_on_delete for p in PLATFORMS} == {
        "slack": "archived",
        "mattermost": "archived",
        "discord": "deleted",
        "telegram": "left",
        "teams": "kept",
        "irc": "kept",
    }


# ── Slack ────────────────────────────────────────────────────────────────────


class _SlackClient:
    def __init__(self, error: str | None = None) -> None:
        self._error = error
        self.archived: list[str] = []

    async def conversations_archive(self, *, channel: str) -> dict[str, Any]:
        self.archived.append(channel)
        if self._error is not None:
            raise SlackApiError("refused", {"ok": False, "error": self._error})
        return {"ok": True}


def _slack(client: _SlackClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    return adapter


async def test_slack_archives_the_channel() -> None:
    client = _SlackClient()

    assert await _slack(client).retire_channel("C1") == ARCHIVED
    assert client.archived == ["C1"]


async def test_slack_counts_an_already_archived_channel_as_archived() -> None:
    assert await _slack(_SlackClient("already_archived")).retire_channel("C1") == (
        ARCHIVED
    )


async def test_slack_reports_a_channel_the_app_has_left() -> None:
    outcome = await _slack(_SlackClient("not_in_channel")).retire_channel("C1")

    assert outcome.outcome == "failed"
    assert outcome.reason is not None and "no longer in" in outcome.reason


async def test_slack_reports_any_other_refusal_in_its_own_words() -> None:
    outcome = await _slack(_SlackClient("cant_archive_general")).retire_channel("C1")

    assert outcome == RetireOutcome.failed(
        "Slack refused to archive the channel: cant_archive_general"
    )


# ── Mattermost ───────────────────────────────────────────────────────────────


class _MattermostChannels:
    def __init__(self, error: Exception | None = None) -> None:
        self._error = error
        self.deleted: list[str] = []

    def delete_channel(self, channel_id: str) -> dict[str, str]:
        self.deleted.append(channel_id)
        if self._error is not None:
            raise self._error
        return {"status": "OK"}


class _MattermostDriver:
    def __init__(self, channels: _MattermostChannels) -> None:
        self.channels = channels


def _mattermost(channels: _MattermostChannels) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="t"
        )
    )
    adapter._admin_driver = _MattermostDriver(channels)  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_running_loop()
    return adapter


async def test_mattermost_archives_the_channel() -> None:
    channels = _MattermostChannels()

    assert await _mattermost(channels).retire_channel("ch1") == ARCHIVED
    # The plain DELETE archives; only `permanent=true` would destroy it.
    assert channels.deleted == ["ch1"]


async def test_mattermost_reports_a_refusal() -> None:
    channels = _MattermostChannels(RuntimeError("You do not have permission"))

    outcome = await _mattermost(channels).retire_channel("ch1")

    assert outcome == RetireOutcome.failed(
        "Mattermost refused to archive the channel: You do not have permission"
    )


# ── Discord ──────────────────────────────────────────────────────────────────

GUILD_ID = 900


class _DiscordResponse:
    def __init__(self, status: int, reason: str) -> None:
        self.status = status
        self.reason = reason


class _DiscordChannel:
    def __init__(self, *, guild: bool = True, error: Exception | None = None) -> None:
        self.guild = type("G", (), {"id": GUILD_ID})() if guild else None
        self._error = error
        self.deleted_for: list[str | None] = []

    async def delete(self, *, reason: str | None = None) -> None:
        self.deleted_for.append(reason)
        if self._error is not None:
            raise self._error


class _DiscordClient:
    def __init__(self, channels: dict[int, _DiscordChannel]) -> None:
        self._channels = channels

    def get_channel(self, channel_id: int) -> _DiscordChannel | None:
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int) -> _DiscordChannel:
        raise discord.NotFound(_DiscordResponse(404, "Not Found"), "unknown")


def _discord(channels: dict[int, _DiscordChannel]) -> DiscordAdapter:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    adapter._connection._client = _DiscordClient(channels)  # type: ignore[assignment]
    return adapter


async def test_discord_deletes_the_channel() -> None:
    channel = _DiscordChannel()

    outcome = await _discord({100: channel}).retire_channel("100")

    assert outcome == RetireOutcome(outcome="deleted")
    assert channel.deleted_for == ["Its Switch room was deleted"]


async def test_discord_counts_a_channel_already_gone_as_deleted() -> None:
    assert await _discord({}).retire_channel("100") == RetireOutcome(outcome="deleted")


async def test_discord_reports_a_refusal() -> None:
    forbidden = discord.Forbidden(_DiscordResponse(403, "Forbidden"), "Missing Access")
    channel = _DiscordChannel(error=forbidden)

    outcome = await _discord({100: channel}).retire_channel("100")

    assert outcome.outcome == "failed"
    assert outcome.reason is not None and "Missing Access" in outcome.reason


async def test_discord_does_not_try_to_delete_a_direct_message() -> None:
    channel = _DiscordChannel(guild=False)

    outcome = await _discord({100: channel}).retire_channel("100")

    assert outcome.outcome == "failed"
    assert channel.deleted_for == []


# ── Telegram ─────────────────────────────────────────────────────────────────


class _TelegramBot:
    def __init__(self, error: Exception | None = None) -> None:
        self._error = error
        self.left: list[Any] = []

    async def leave_chat(self, *, chat_id: Any) -> bool:
        self.left.append(chat_id)
        if self._error is not None:
            raise self._error
        return True


def _telegram(bot: _TelegramBot) -> TelegramAdapter:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username="switch_bot")
    )
    adapter._bot = bot
    return adapter


async def test_telegram_leaves_the_chat() -> None:
    bot = _TelegramBot()

    assert await _telegram(bot).retire_channel("-1001") == RetireOutcome(outcome="left")
    assert bot.left == [-1001]


async def test_telegram_counts_a_chat_it_is_already_out_of_as_left() -> None:
    bot = _TelegramBot(Forbidden("Forbidden: bot was kicked from the group chat"))

    assert await _telegram(bot).retire_channel("-1001") == RetireOutcome(outcome="left")


async def test_telegram_reports_a_refusal() -> None:
    bot = _TelegramBot(BadRequest("Something unexpected"))

    outcome = await _telegram(bot).retire_channel("-1001")

    assert outcome.outcome == "failed"
    assert outcome.reason is not None and "Something unexpected" in outcome.reason


# ── Teams ────────────────────────────────────────────────────────────────────


async def test_teams_leaves_the_channel_in_place() -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-1",
            team_id="team-1",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )

    assert await adapter.retire_channel("19:abc@thread.tacv2") == RetireOutcome(
        outcome="kept"
    )
