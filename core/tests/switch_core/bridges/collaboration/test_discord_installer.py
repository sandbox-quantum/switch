"""The distributed Discord installer: the authorize URL, the tokenless grant,
and the two half-states its connection config refuses.

Discord has no webhook, so the inbound half of the ABC is stubbed to raise;
those stubs are tested only to prove they fail loud rather than silently doing
nothing, because nothing reaches them in normal operation.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from switch_core.bridges.collaboration.discord.adapter import DiscordConnectionConfig
from switch_core.bridges.collaboration.discord.install import (
    PERMISSIONS,
    SCOPES,
    DiscordAppInstaller,
)
from switch_core.bridges.collaboration.install import MessagingInstallError


@pytest.fixture
def installer() -> DiscordAppInstaller:
    return DiscordAppInstaller(
        client_id="123456789012345678",
        client_secret="secret",
        application_id="123456789012345678",
    )


class TestTheAuthorizeUrl:
    def test_it_carries_the_state_and_redirect_unchanged(
        self, installer: DiscordAppInstaller
    ) -> None:
        redirect = "https://switch.example/messaging/discord/oauth/callback"
        url = installer.authorize_url(state="opaque-state", redirect_uri=redirect)
        query = parse_qs(urlparse(url).query)
        assert query["state"] == ["opaque-state"]
        assert query["redirect_uri"] == [redirect]
        assert query["response_type"] == ["code"]

    def test_it_asks_for_the_pinned_scopes_and_permissions(
        self, installer: DiscordAppInstaller
    ) -> None:
        """Decision #11: the scopes and permission integer are fixed in code,
        and this is where the authorize URL is held to them."""
        url = installer.authorize_url(state="s", redirect_uri="https://x.example/cb")
        query = parse_qs(urlparse(url).query)
        assert query["scope"] == [" ".join(SCOPES)]
        assert query["permissions"] == [str(PERMISSIONS)]


class TestRedeem:
    async def _grant(
        self,
        installer: DiscordAppInstaller,
        monkeypatch: pytest.MonkeyPatch,
        response: httpx.Response,
    ):
        async def fake_post(self, url, **kwargs):  # type: ignore[no-untyped-def]
            return response

        monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
        return await installer.redeem(code="the-code", redirect_uri="https://x/cb")

    async def test_a_good_exchange_becomes_a_tokenless_grant(
        self, installer: DiscordAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        grant = await self._grant(
            installer,
            monkeypatch,
            httpx.Response(
                200,
                json={
                    "access_token": "user-token-we-drop",
                    "scope": "bot applications.commands",
                    "guild": {"id": "42", "name": "Acme"},
                },
            ),
        )
        assert grant.external_workspace_id == "42"
        assert grant.workspace_name == "Acme"
        assert grant.bot_token is None
        assert grant.scopes == "bot applications.commands"

    async def test_a_guild_with_no_name_falls_back_to_its_id(
        self, installer: DiscordAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        grant = await self._grant(
            installer,
            monkeypatch,
            httpx.Response(200, json={"guild": {"id": "42"}}),
        )
        assert grant.workspace_name == "42"

    async def test_a_non_2xx_is_refused(
        self, installer: DiscordAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(MessagingInstallError, match="Discord refused"):
            await self._grant(
                installer, monkeypatch, httpx.Response(400, text="invalid_grant")
            )

    async def test_no_guild_means_the_bot_was_not_added(
        self, installer: DiscordAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No `guild` in the response is the bot scope dropped or a cancel; there
        is nothing to attribute the install to."""
        with pytest.raises(MessagingInstallError, match="no guild"):
            await self._grant(
                installer,
                monkeypatch,
                httpx.Response(200, json={"access_token": "t"}),
            )


class TestConnectionConfig:
    def test_it_renders_a_shared_tokenless_config(
        self, installer: DiscordAppInstaller
    ) -> None:
        from switch_core.bridges.collaboration.install import InstallGrant

        config = installer.connection_config(
            InstallGrant(
                external_workspace_id="42",
                workspace_name="Acme",
                bot_token=None,
                scopes="bot applications.commands",
            )
        )
        assert config == {"guild_id": "42", "event_delivery": "shared"}


class TestTheWebhookHalfIsStubbed:
    """Discord delivers over the Gateway; these raise so a mistaken caller sees
    it rather than silently getting nothing.

    `verify_webhook` is the exception: it is the one an unauthenticated stranger
    can reach (it runs first for any POST to `/messaging/discord/*`), so it
    raises `MessagingInstallError`, which the route turns into a 404 rather than
    a repeatable 500."""

    async def test_revoke_raises(self, installer: DiscordAppInstaller) -> None:
        with pytest.raises(NotImplementedError):
            await installer.revoke(bot_token="whatever")

    def test_verify_webhook_raises_not_found(
        self, installer: DiscordAppInstaller
    ) -> None:
        with pytest.raises(MessagingInstallError):
            installer.verify_webhook(headers={}, body=b"")

    def test_parse_webhook_raises(self, installer: DiscordAppInstaller) -> None:
        with pytest.raises(NotImplementedError):
            installer.parse_webhook(endpoint="events", headers={}, body=b"")

    def test_workspace_of_event_raises(self, installer: DiscordAppInstaller) -> None:
        with pytest.raises(NotImplementedError):
            installer.workspace_of_event({})

    def test_revocation_of_event_raises(self, installer: DiscordAppInstaller) -> None:
        with pytest.raises(NotImplementedError):
            installer.revocation_of_event({})


class TestConnectionConfigHalfStates:
    """The two shapes that look configured and cannot work."""

    def test_own_connection_needs_a_token(self) -> None:
        with pytest.raises(ValueError, match="bot_token is required"):
            DiscordConnectionConfig(guild_id="42", event_delivery="own_connection")

    def test_shared_must_not_carry_a_token(self) -> None:
        with pytest.raises(ValueError, match="bot_token must be empty"):
            DiscordConnectionConfig(
                guild_id="42", event_delivery="shared", bot_token="a-token"
            )

    def test_a_self_registered_config_still_validates(self) -> None:
        """The default path is unchanged: own_connection with a token."""
        config = DiscordConnectionConfig(guild_id="42", bot_token="a-token")
        assert config.event_delivery == "own_connection"

    def test_a_shared_config_validates_without_a_token(self) -> None:
        config = DiscordConnectionConfig(guild_id="42", event_delivery="shared")
        assert config.bot_token is None
