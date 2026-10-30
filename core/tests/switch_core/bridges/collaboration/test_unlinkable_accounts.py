"""Accounts several people post as cannot be linked to one Switch user
(CHOO-3881): some tell by their id, others only when the platform is asked."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import aiohttp
import discord
import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter


@pytest.mark.parametrize("account", ["1087968824", "136817688", "777000"])
def test_telegram_stand_ins_are_refused(account: str) -> None:
    assert TelegramAdapter.unlinkable_account_reason(account) is not None


def test_a_telegram_person_can_be_linked() -> None:
    assert TelegramAdapter.unlinkable_account_reason("424242") is None


@pytest.mark.parametrize("account", ["B0123ABCD", "USLACKBOT"])
def test_slack_apps_and_bots_are_refused(account: str) -> None:
    assert SlackAdapter.unlinkable_account_reason(account) is not None


@pytest.mark.parametrize("account", ["U0123ABCD", "W0123ABCD"])
def test_a_slack_person_can_be_linked(account: str) -> None:
    assert SlackAdapter.unlinkable_account_reason(account) is None


def test_by_default_any_account_can_be_linked() -> None:
    assert PlatformAdapter.unlinkable_account_reason("anyone") is None


# ── Asking the platform ─────────────────────────────────────────────────────


class _SlackClient:
    def __init__(self, users: dict[str, dict[str, object]]) -> None:
        self._users = users

    async def users_info(self, *, user: str) -> dict[str, object]:
        if user == "U0DOWN":
            raise aiohttp.ClientConnectionError("connection reset")
        if user not in self._users:
            raise SlackApiError(
                "user_not_found", {"ok": False, "error": "user_not_found"}
            )
        return {"user": self._users[user]}


def _slack(users: dict[str, dict[str, object]]) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter._web_client = _SlackClient(users)  # type: ignore[assignment]
    return adapter


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_a_slack_bot_user_is_refused_though_its_id_looks_like_a_persons() -> None:
    # An app posting with its bot token is bridged under its bot user's U-id.
    adapter = _slack({"U0BOT": {"id": "U0BOT", "is_bot": True}})
    assert _run(adapter.account_unlinkable_reason("U0BOT")) is not None


def test_a_slack_person_is_linkable_when_asked() -> None:
    adapter = _slack({"U0ADA": {"id": "U0ADA", "is_bot": False}})
    assert _run(adapter.account_unlinkable_reason("U0ADA")) is None


def test_a_slack_account_slack_does_not_know_is_not_found() -> None:
    with pytest.raises(LookupError):
        _run(_slack({}).account_unlinkable_reason("U0TYPO"))


def test_slack_out_of_reach_is_a_runtime_error() -> None:
    with pytest.raises(RuntimeError):
        _run(_slack({}).account_unlinkable_reason("U0DOWN"))


def test_a_slack_bot_id_is_refused_without_asking() -> None:
    adapter = _slack({})
    assert _run(adapter.account_unlinkable_reason("B0123ABCD")) is not None


class _DiscordClient:
    def __init__(self, users: dict[int, Any]) -> None:
        self._users = users

    async def fetch_user(self, user_id: int) -> Any:
        if user_id not in self._users:
            raise discord.NotFound(
                SimpleNamespace(status=404, reason="Not Found"), "Unknown User"
            )
        return self._users[user_id]


def _discord(users: dict[int, Any]) -> DiscordAdapter:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id="1")
    )
    adapter._connection._client = _DiscordClient(users)  # type: ignore[union-attr,assignment]
    return adapter


def test_a_discord_bot_is_refused() -> None:
    adapter = _discord({42: SimpleNamespace(bot=True, system=False)})
    assert _run(adapter.account_unlinkable_reason("42")) is not None


def test_a_discord_webhook_is_refused() -> None:
    # A webhook's posts carry the webhook's id, which no user has.
    adapter = _discord({})
    assert _run(adapter.account_unlinkable_reason("777")) is not None


def test_a_discord_person_is_linkable_when_asked() -> None:
    adapter = _discord({42: SimpleNamespace(bot=False, system=False)})
    assert _run(adapter.account_unlinkable_reason("42")) is None
