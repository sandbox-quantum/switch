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
import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from telegram.request import HTTPXRequest

from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost import adapter as mattermost_adapter
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
from switch_core.outbound import OutboundPolicy, OutboundURLRefused
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
            await TelegramAdapter.verify_credentials(
                dict(TELEGRAM), outbound_policy=OutboundPolicy.parse("")
            )

        assert TELEGRAM_SECRET not in "".join(traceback.format_exception(caught.value))

    async def test_a_token_telegram_knows_is_accepted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        asked = _telegram_answers(monkeypatch, 200)

        await TelegramAdapter.verify_credentials(
            dict(TELEGRAM), outbound_policy=OutboundPolicy.parse("")
        )

        assert [url.rsplit("/", 1)[-1] for url in asked] == ["getMe"]

    async def test_a_bridge_on_the_shared_bot_asks_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        asked = _telegram_answers(monkeypatch, 401)

        await TelegramAdapter.verify_credentials(
            {"event_delivery": "shared"}, outbound_policy=OutboundPolicy.parse("")
        )

        assert asked == []


class TestDiscord:
    async def test_a_token_discord_refuses_is_a_credential_error(self) -> None:
        refused = AsyncMock(side_effect=discord.LoginFailure("Improper token"))
        with patch.object(discord.Client, "login", refused):
            with pytest.raises(BridgeCredentialError, match="rejected the bot token"):
                await DiscordAdapter.verify_credentials(
                    dict(DISCORD), outbound_policy=OutboundPolicy.parse("")
                )

        refused.assert_awaited_once_with(DISCORD["bot_token"])

    async def test_a_token_discord_knows_is_accepted(self) -> None:
        with patch.object(discord.Client, "login", AsyncMock()) as login:
            await DiscordAdapter.verify_credentials(
                dict(DISCORD), outbound_policy=OutboundPolicy.parse("")
            )

        login.assert_awaited_once_with(DISCORD["bot_token"])

    async def test_a_bridge_on_the_shared_connection_asks_nothing(self) -> None:
        with patch.object(discord.Client, "login", AsyncMock()) as login:
            await DiscordAdapter.verify_credentials(
                {"guild_id": "111", "event_delivery": "shared"},
                outbound_policy=OutboundPolicy.parse(""),
            )

        login.assert_not_awaited()


class _FakeMattermost:
    """The REST API `verify_credentials` signs in to, noting each request."""

    def __init__(
        self,
        *,
        login_status: int,
        team_status: int,
        refused_paths: frozenset[str] = frozenset(),
    ) -> None:
        self.login_status = login_status
        self.team_status = team_status
        # Paths whose connection the outbound guard refuses, as it does when a
        # host re-resolves to a blocked address between requests.
        self.refused_paths = refused_paths
        self.requests: list[tuple[str, str]] = []
        self.policies: list[OutboundPolicy] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        if request.url.path in self.refused_paths:
            raise OutboundURLRefused("chat.example.invalid resolves to 10.0.0.5")
        if request.url.path == "/api/v4/users/login":
            if not 200 <= self.login_status < 300:
                return httpx.Response(
                    self.login_status, json={"message": "Invalid credentials"}
                )
            return httpx.Response(
                self.login_status, json={}, headers={"Token": "session-token"}
            )
        if request.url.path.startswith("/api/v4/teams/name/"):
            assert request.headers["Authorization"] == "Bearer session-token"
            if self.team_status != 200:
                return httpx.Response(self.team_status, json={"message": "not found"})
            return httpx.Response(200, json={"id": "team-1"})
        return httpx.Response(200, json={})

    def serve(self) -> Any:
        def client(policy: OutboundPolicy, **kwargs: Any) -> httpx.AsyncClient:
            self.policies.append(policy)
            kwargs.pop("verify")
            return httpx.AsyncClient(
                transport=httpx.MockTransport(self.handle), **kwargs
            )

        return patch.object(mattermost_adapter, "guarded_async_client", client)


class TestMattermost:
    async def test_a_refused_sign_in_is_a_credential_error(self) -> None:
        server = _FakeMattermost(login_status=401, team_status=200)
        with server.serve():
            with pytest.raises(BridgeCredentialError, match="refused the sign-in"):
                await MattermostAdapter.verify_credentials(
                    dict(MATTERMOST), outbound_policy=OutboundPolicy.parse("")
                )

    async def test_a_team_it_cannot_find_is_a_credential_error(self) -> None:
        server = _FakeMattermost(login_status=200, team_status=404)
        with server.serve():
            with pytest.raises(BridgeCredentialError, match="no team named 'eng'"):
                await MattermostAdapter.verify_credentials(
                    dict(MATTERMOST), outbound_policy=OutboundPolicy.parse("")
                )
        assert server.requests[-1] == ("POST", "/api/v4/users/logout")

    async def test_a_working_sign_in_is_accepted_and_signed_out(self) -> None:
        server = _FakeMattermost(login_status=200, team_status=200)
        policy = OutboundPolicy.parse("")
        with server.serve():
            await MattermostAdapter.verify_credentials(
                dict(MATTERMOST), outbound_policy=policy
            )

        assert server.requests == [
            ("POST", "/api/v4/users/login"),
            ("GET", "/api/v4/teams/name/eng"),
            ("POST", "/api/v4/users/logout"),
        ]
        assert server.policies == [policy]

    async def test_a_sign_in_answered_201_is_accepted(self) -> None:
        """Mattermost documents 201 for a successful sign-in."""
        server = _FakeMattermost(login_status=201, team_status=200)
        with server.serve():
            await MattermostAdapter.verify_credentials(
                dict(MATTERMOST), outbound_policy=OutboundPolicy.parse("")
            )
        assert ("GET", "/api/v4/teams/name/eng") in server.requests

    async def test_a_refusal_on_the_team_lookup_is_a_credential_error(self) -> None:
        server = _FakeMattermost(
            login_status=200,
            team_status=200,
            refused_paths=frozenset({"/api/v4/teams/name/eng"}),
        )
        with server.serve():
            with pytest.raises(BridgeCredentialError, match="may not connect"):
                await MattermostAdapter.verify_credentials(
                    dict(MATTERMOST), outbound_policy=OutboundPolicy.parse("")
                )

    async def test_a_refused_sign_out_keeps_the_team_lookup_error(self) -> None:
        server = _FakeMattermost(
            login_status=200,
            team_status=404,
            refused_paths=frozenset({"/api/v4/users/logout"}),
        )
        with server.serve():
            with pytest.raises(BridgeCredentialError, match="no team named 'eng'"):
                await MattermostAdapter.verify_credentials(
                    dict(MATTERMOST), outbound_policy=OutboundPolicy.parse("")
                )
        assert server.requests[-1] == ("POST", "/api/v4/users/logout")

    async def test_an_address_the_policy_blocks_is_not_signed_in_to(self) -> None:
        with pytest.raises(BridgeCredentialError, match="may not connect"):
            await MattermostAdapter.verify_credentials(
                {**MATTERMOST, "url": "http://127.0.0.1:9"},
                outbound_policy=OutboundPolicy.parse(""),
            )


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
    server = _FakeMattermost(login_status=200, team_status=200)

    with server.serve():
        with pytest.raises(BridgeStartRefused, match="private address"):
            await _service(session_factory, config).check_edited_connection_config(
                bridge_id="the-edited-bridge",
                bridge_type="mattermost",
                connection_config=dict(MATTERMOST),
            )

    assert server.requests == []
