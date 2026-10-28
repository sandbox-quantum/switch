"""Telegram, Discord and Mattermost credentials are checked before they are kept.

Without the check, a token the platform refuses was saved, the bridge was
restarted with it and reported as replaced, and only then failed in the
background with the old, working token already gone.
"""

from __future__ import annotations

import json
import traceback
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import discord
import pytest
from mattermostdriver.exceptions import NoAccessTokenProvided, ResourceNotFound
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from telegram.request import HTTPXRequest

from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeStartRefused,
)
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.outbound import OutboundURLRefused
from tests.ownership import SoleOwner

TELEGRAM_SECRET = "placeholder-secret-part-of-the-token"
TELEGRAM = {"bot_token": f"123456789:{TELEGRAM_SECRET}", "bot_username": "switch_bot"}
DISCORD = {"bot_token": "placeholder-discord-token", "guild_id": "111"}
MATTERMOST = {
    "url": "https://chat.example.invalid",
    "admin_user": "switch-admin",
    "admin_password": "placeholder",  # gitleaks:allow
    "team_name": "eng",
}
_ME = {
    "id": 123456789,
    "is_bot": True,
    "first_name": "Switch",
    "username": "switch_bot",
    "can_join_groups": True,
    "can_read_all_group_messages": True,
    "supports_inline_queries": False,
}


def _telegram_answers(monkeypatch: pytest.MonkeyPatch, status: int) -> list[str]:
    """Answer every Bot API call with `status`, recording the URLs asked for."""
    asked: list[str] = []

    async def do_request(
        self: HTTPXRequest, url: str, *args: Any, **kwargs: Any
    ) -> Any:
        asked.append(url)
        if status == 200:
            return 200, json.dumps({"ok": True, "result": _ME}).encode()
        body = {"ok": False, "error_code": status, "description": "Unauthorized"}
        return status, json.dumps(body).encode()

    monkeypatch.setattr(HTTPXRequest, "do_request", do_request)
    return asked


class TestTelegram:
    async def test_a_token_telegram_refuses_is_a_credential_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _telegram_answers(monkeypatch, 401)

        with pytest.raises(
            BridgeCredentialError, match="rejected the bot token"
        ) as caught:
            await TelegramAdapter.verify_credentials(dict(TELEGRAM))

        assert TELEGRAM_SECRET not in "".join(traceback.format_exception(caught.value))

    async def test_a_token_telegram_knows_is_accepted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        asked = _telegram_answers(monkeypatch, 200)

        await TelegramAdapter.verify_credentials(dict(TELEGRAM))

        assert [url.rsplit("/", 1)[-1] for url in asked] == ["getMe"]

    async def test_a_bridge_on_the_shared_bot_asks_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        asked = _telegram_answers(monkeypatch, 401)

        await TelegramAdapter.verify_credentials({"event_delivery": "shared"})

        assert asked == []


class TestDiscord:
    async def test_a_token_discord_refuses_is_a_credential_error(self) -> None:
        refused = AsyncMock(side_effect=discord.LoginFailure("Improper token"))
        with patch.object(discord.Client, "login", refused):
            with pytest.raises(BridgeCredentialError, match="rejected the bot token"):
                await DiscordAdapter.verify_credentials(dict(DISCORD))

        refused.assert_awaited_once_with(DISCORD["bot_token"])

    async def test_a_token_discord_knows_is_accepted(self) -> None:
        with patch.object(discord.Client, "login", AsyncMock()) as login:
            await DiscordAdapter.verify_credentials(dict(DISCORD))

        login.assert_awaited_once_with(DISCORD["bot_token"])

    async def test_a_bridge_on_the_shared_connection_asks_nothing(self) -> None:
        with patch.object(discord.Client, "login", AsyncMock()) as login:
            await DiscordAdapter.verify_credentials(
                {"guild_id": "111", "event_delivery": "shared"}
            )

        login.assert_not_awaited()


class _Driver:
    def __init__(self, *, login: Exception | None, team: Exception | None) -> None:
        self._login = login
        self.teams = MagicMock()
        self.teams.get_team_by_name.side_effect = team
        self.logged_out = False

    def login(self) -> None:
        if self._login is not None:
            raise self._login

    def logout(self) -> None:
        self.logged_out = True


def _mattermost_driver(driver: _Driver) -> Any:
    return patch.object(MattermostAdapter, "_create_driver", lambda *_, **__: driver)


class TestMattermost:
    async def test_a_refused_sign_in_is_a_credential_error(self) -> None:
        driver = _Driver(login=NoAccessTokenProvided("Invalid credentials"), team=None)
        with _mattermost_driver(driver):
            with pytest.raises(BridgeCredentialError, match="refused the sign-in"):
                await MattermostAdapter.verify_credentials(dict(MATTERMOST))

    async def test_a_team_it_cannot_find_is_a_credential_error(self) -> None:
        driver = _Driver(login=None, team=ResourceNotFound("not found"))
        with _mattermost_driver(driver):
            with pytest.raises(BridgeCredentialError, match="no team named 'eng'"):
                await MattermostAdapter.verify_credentials(dict(MATTERMOST))
        assert driver.logged_out

    async def test_a_working_sign_in_is_accepted_and_signed_out(self) -> None:
        driver = _Driver(login=None, team=None)
        with _mattermost_driver(driver):
            await MattermostAdapter.verify_credentials(dict(MATTERMOST))

        driver.teams.get_team_by_name.assert_called_once_with("eng")
        assert driver.logged_out


def _service(
    session_factory: async_sessionmaker[AsyncSession], config: Any
) -> CollaborationBridgeLifecycleService:
    service = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        provisioning=MagicMock(),
        session_factory=session_factory,
        config=config,
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
        ownership=SoleOwner(),
        cursor_writer=SoleOwner.cursor_writer(session_factory),
    )
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )
    return service


async def test_an_edit_is_not_signed_in_with_at_a_url_switch_may_not_reach(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Checking the credentials sends them to `url`, so the outbound policy
    decides first."""
    config = MagicMock()
    config.outbound_policy.check_url = AsyncMock(
        side_effect=OutboundURLRefused("chat.example.invalid is a private address")
    )
    driver = _Driver(login=None, team=None)
    driver.login = MagicMock()  # type: ignore[method-assign]

    with _mattermost_driver(driver):
        with pytest.raises(BridgeStartRefused, match="private address"):
            await _service(session_factory, config).check_edited_connection_config(
                bridge_id="the-edited-bridge",
                bridge_type="mattermost",
                connection_config=dict(MATTERMOST),
            )

    driver.login.assert_not_called()
