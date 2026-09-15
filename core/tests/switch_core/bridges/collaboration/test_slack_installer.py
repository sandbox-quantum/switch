"""What the installer does with what Slack sends back, including when it lies.

The install endpoints are the only ones in the system a stranger can reach
with no credential at all, so the interesting cases here are the hostile and
the malformed ones rather than the happy path.
"""

from __future__ import annotations

import hashlib
import hmac
import time

import pytest
from slack_sdk.web.async_client import AsyncWebClient

from switch_core.bridges.collaboration.install import (
    InstallGrant,
    MessagingInstallerRegistry,
    MessagingInstallError,
    WebhookAuthenticityError,
    events_path,
    oauth_callback_path,
    public_url,
)
from switch_core.bridges.collaboration.slack.adapter import SlackConnectionConfig
from switch_core.bridges.collaboration.slack.install import (
    BOT_SCOPES,
    SlackAppInstaller,
)

_SIGNING_SECRET = "test-signing-secret"


@pytest.fixture
def installer() -> SlackAppInstaller:
    return SlackAppInstaller(
        client_id="1234.5678",
        client_secret="test-client-secret",
        signing_secret=_SIGNING_SECRET,
    )


def _sign(body: bytes, timestamp: str) -> str:
    digest = hmac.new(
        _SIGNING_SECRET.encode(),
        b"v0:" + timestamp.encode() + b":" + body,
        hashlib.sha256,
    ).hexdigest()
    return f"v0={digest}"


def _signed_headers(body: bytes, *, age_seconds: int = 0) -> dict[str, str]:
    timestamp = str(int(time.time()) - age_seconds)
    return {
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": _sign(body, timestamp),
    }


class TestAuthorizeUrl:
    def test_it_carries_the_state_and_redirect_unchanged(
        self, installer: SlackAppInstaller
    ) -> None:
        redirect = public_url("https://switch.example", oauth_callback_path("slack"))
        url = installer.authorize_url(state="opaque-state", redirect_uri=redirect)

        assert url.startswith("https://slack.com/oauth/v2/authorize?")
        assert "state=opaque-state" in url
        assert (
            "redirect_uri=https%3A%2F%2Fswitch.example%2Fmessaging%2Fslack%2Foauth%2Fcallback"
            in url
        )

    def test_it_asks_for_every_scope_the_bot_needs(
        self, installer: SlackAppInstaller
    ) -> None:
        url = installer.authorize_url(state="s", redirect_uri="https://x.example/cb")
        for scope in BOT_SCOPES:
            assert scope.replace(":", "%3A") in url


class TestWebhookVerification:
    def test_a_correctly_signed_body_passes(self, installer: SlackAppInstaller) -> None:
        body = b'{"type":"event_callback","team_id":"T1"}'
        installer.verify_webhook(headers=_signed_headers(body), body=body)

    def test_a_tampered_body_is_refused(self, installer: SlackAppInstaller) -> None:
        body = b'{"type":"event_callback","team_id":"T1"}'
        headers = _signed_headers(body)
        with pytest.raises(WebhookAuthenticityError):
            installer.verify_webhook(headers=headers, body=body + b" ")

    def test_an_old_signature_is_refused(self, installer: SlackAppInstaller) -> None:
        """Replay window. A capture stays valid forever without it."""
        body = b'{"team_id":"T1"}'
        with pytest.raises(WebhookAuthenticityError):
            installer.verify_webhook(
                headers=_signed_headers(body, age_seconds=60 * 10), body=body
            )

    def test_missing_headers_are_refused_rather_than_skipped(
        self, installer: SlackAppInstaller
    ) -> None:
        with pytest.raises(WebhookAuthenticityError):
            installer.verify_webhook(headers={}, body=b"{}")

    def test_a_nonnumeric_timestamp_is_a_bad_signature_not_a_crash(
        self, installer: SlackAppInstaller
    ) -> None:
        """Reachable by anyone who finds the URL.

        The verifier calls `int()` on the header, so without the guard this
        unauthenticated input is a 500 and a traceback per request rather than
        a 401.
        """
        body = b"{}"
        with pytest.raises(WebhookAuthenticityError):
            installer.verify_webhook(
                headers={
                    "X-Slack-Request-Timestamp": "not-a-number",
                    "X-Slack-Signature": "v0=deadbeef",
                },
                body=body,
            )

    def test_header_case_does_not_matter(self, installer: SlackAppInstaller) -> None:
        body = b'{"team_id":"T1"}'
        headers = {k.lower(): v for k, v in _signed_headers(body).items()}
        installer.verify_webhook(headers=headers, body=body)


class TestWorkspaceOfEvent:
    def test_it_reads_the_team_id(self, installer: SlackAppInstaller) -> None:
        assert installer.workspace_of_event({"team_id": "T123"}) == "T123"

    @pytest.mark.parametrize("payload", [{}, {"team_id": ""}, {"team_id": 7}])
    def test_an_event_naming_no_workspace_is_refused(
        self, installer: SlackAppInstaller, payload: dict
    ) -> None:
        """An event we cannot route is not an event to guess at.

        There is no sensible default here: picking any tenant would deliver a
        stranger's message into somebody's rooms.
        """
        with pytest.raises(WebhookAuthenticityError):
            installer.workspace_of_event(payload)


class TestRedeem:
    async def _redeem_returning(
        self, monkeypatch: pytest.MonkeyPatch, installer: SlackAppInstaller, response
    ) -> InstallGrant:
        async def fake(self, **kwargs):  # noqa: ANN001, ANN202
            return response

        monkeypatch.setattr(AsyncWebClient, "oauth_v2_access", fake)
        return await installer.redeem(code="c", redirect_uri="https://x.example/cb")

    async def test_a_good_grant_becomes_the_three_things_we_keep(
        self, installer: SlackAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        grant = await self._redeem_returning(
            monkeypatch,
            installer,
            {
                "ok": True,
                "access_token": "xoxb-granted",
                "scope": "chat:write,commands",
                "team": {"id": "T123", "name": "Acme"},
            },
        )
        assert grant == InstallGrant(
            external_workspace_id="T123",
            bot_token="xoxb-granted",
            scopes="chat:write,commands",
        )

    async def test_a_two_hundred_saying_not_ok_is_still_a_failure(
        self, installer: SlackAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Slack answers 200 with `ok: false` for most refusals."""
        with pytest.raises(MessagingInstallError, match="invalid_code"):
            await self._redeem_returning(
                monkeypatch, installer, {"ok": False, "error": "invalid_code"}
            )

    async def test_an_org_wide_install_is_refused_with_a_reason(
        self, installer: SlackAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It has an enterprise id and no single workspace id to be unique on."""
        with pytest.raises(MessagingInstallError, match="org-wide"):
            await self._redeem_returning(
                monkeypatch,
                installer,
                {
                    "ok": True,
                    "access_token": "xoxb-granted",
                    "is_enterprise_install": True,
                    "enterprise": {"id": "E1"},
                    "team": None,
                },
            )

    async def test_a_grant_with_no_workspace_is_refused(
        self, installer: SlackAppInstaller, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(MessagingInstallError, match="nothing to record"):
            await self._redeem_returning(
                monkeypatch, installer, {"ok": True, "access_token": "xoxb-granted"}
            )


class TestConnectionConfig:
    def test_a_grant_renders_a_config_the_adapter_accepts(
        self, installer: SlackAppInstaller
    ) -> None:
        """The seam: after this an installed bridge is an ordinary bridge."""
        rendered = installer.connection_config(
            InstallGrant(
                external_workspace_id="T123",
                bot_token="xoxb-granted",
                scopes="chat:write",
            )
        )
        config = SlackConnectionConfig.model_validate(
            {**rendered, "event_delivery": "webhook"}
        )
        assert config.bot_token == "xoxb-granted"
        assert config.workspace_id == "T123"
        assert config.app_token is None


class TestDeliveryModeValidation:
    def test_socket_mode_without_an_app_token_is_refused(self) -> None:
        """The failure that otherwise reads as "Slack is quiet today"."""
        with pytest.raises(ValueError, match="app_token is required"):
            SlackConnectionConfig.model_validate(
                {"bot_token": "xoxb-x", "workspace_id": "T1"}
            )

    def test_a_webhook_bridge_with_an_app_token_is_refused(self) -> None:
        with pytest.raises(ValueError, match="must be empty"):
            SlackConnectionConfig.model_validate(
                {
                    "bot_token": "xoxb-x",
                    "workspace_id": "T1",
                    "app_token": "xapp-x",
                    "event_delivery": "webhook",
                }
            )

    def test_the_hand_registered_shape_still_validates(self) -> None:
        config = SlackConnectionConfig.model_validate(
            {"bot_token": "xoxb-x", "app_token": "xapp-x", "workspace_id": "T1"}
        )
        assert config.event_delivery == "socket_mode"

    def test_the_registration_form_never_offers_the_delivery_mode(self) -> None:
        """It is not a question an operator filling that form can be asked."""
        assert (
            "event_delivery"
            not in SlackConnectionConfig.model_json_schema()["properties"]
        )


class TestRegistry:
    def test_an_unregistered_platform_says_what_to_do(self) -> None:
        registry = MessagingInstallerRegistry()
        with pytest.raises(MessagingInstallError, match="no slack app is registered"):
            registry.get("slack")

    def test_registering_twice_is_refused(self, installer: SlackAppInstaller) -> None:
        registry = MessagingInstallerRegistry()
        registry.register(installer)
        with pytest.raises(MessagingInstallError, match="already registered"):
            registry.register(installer)

    def test_a_registered_installer_comes_back(
        self, installer: SlackAppInstaller
    ) -> None:
        registry = MessagingInstallerRegistry()
        registry.register(installer)
        assert registry.get("slack") is installer
        assert registry.platforms() == ["slack"]


class TestPaths:
    def test_the_public_prefix_bypasses_bearer_auth(self) -> None:
        """Otherwise every Slack event is a 401 nobody sees."""
        from switch_core.bridges.agent.auth import PUBLIC_PATH_PREFIXES

        assert events_path("slack").startswith(PUBLIC_PATH_PREFIXES)

    def test_joining_an_origin_with_a_trailing_slash_does_not_double_it(self) -> None:
        """Slack compares the redirect byte for byte."""
        assert public_url(
            "https://switch.example/", oauth_callback_path("slack")
        ) == public_url("https://switch.example", oauth_callback_path("slack"))
