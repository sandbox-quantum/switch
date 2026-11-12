"""The Matrix connection: what the form accepts, and checking the token first."""

from __future__ import annotations

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.matrix.adapter import (
    MatrixAdapter,
    MatrixConnectionConfig,
)
from switch_core.bridges.collaboration.matrix.client import MatrixApiError
from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.bridges.collaboration.platforms import PLATFORMS
from tests.switch_core.bridges.collaboration.matrix_fakes import (
    BOT,
    HOMESERVER,
    TOKEN,
    FakeHomeserver,
    Recorder,
    make_adapter,
    serve,
    start,
)

VALID = {"homeserver_url": HOMESERVER, "bot_user_id": BOT, "access_token": TOKEN}


class TestConfig:
    def test_a_homeserver_the_bots_id_and_a_token_are_all_it_needs(self) -> None:
        config = MatrixConnectionConfig.model_validate(VALID)
        assert config.homeserver_url == HOMESERVER
        assert config.bot_user_id == BOT
        assert config.accept_invites_from_other_servers is False

    def test_a_trailing_slash_and_spaces_are_tidied(self) -> None:
        config = MatrixConnectionConfig.model_validate(
            {
                "homeserver_url": f" {HOMESERVER}/ ",
                "bot_user_id": f" {BOT} ",
                "access_token": f" {TOKEN} ",
            }
        )
        assert config.homeserver_url == HOMESERVER
        assert config.bot_user_id == BOT
        assert config.access_token == TOKEN

    @pytest.mark.parametrize(
        ("url", "says"),
        [
            ("http://matrix.example.org", "https"),
            ("ftp://matrix.example.org", "https"),
            ("matrix.example.org", "naming the homeserver"),
            ("https://matrix.example.org/?x=1", "no query"),
            ("https://user:pw@matrix.example.org", "credentials"),
            ("https://matrix.example.org:99999", "invalid port"),
        ],
    )
    def test_an_address_the_token_should_not_go_to_is_refused(
        self, url: str, says: str
    ) -> None:
        with pytest.raises(ValidationError, match=says):
            MatrixConnectionConfig.model_validate({**VALID, "homeserver_url": url})

    def test_plain_http_is_for_a_homeserver_on_this_machine_only(self) -> None:
        config = MatrixConnectionConfig.model_validate(
            {**VALID, "homeserver_url": "http://localhost:8008"}
        )
        assert config.homeserver_url == "http://localhost:8008"

    @pytest.mark.parametrize("token", ["", "   ", "syt_a b"])
    def test_a_token_must_be_one_word(self, token: str) -> None:
        with pytest.raises(ValidationError, match="access_token"):
            MatrixConnectionConfig.model_validate({**VALID, "access_token": token})

    @pytest.mark.parametrize(
        "user_id", ["switch-bot", "@switch-bot", "switch-bot:example.org", "@a b:x"]
    )
    def test_the_bots_id_must_be_a_full_matrix_id(self, user_id: str) -> None:
        with pytest.raises(ValidationError, match="bot_user_id"):
            MatrixConnectionConfig.model_validate({**VALID, "bot_user_id": user_id})

    @pytest.mark.parametrize(
        "user_id",
        ["@switch:example.org:8448", "@switch:192.0.2.1", "@switch:[2001:db8::1]:8448"],
    )
    def test_any_server_name_the_spec_allows_is_accepted(self, user_id: str) -> None:
        config = MatrixConnectionConfig.model_validate(
            {**VALID, "bot_user_id": user_id}
        )
        assert config.bot_user_id == user_id

    def test_the_token_is_not_echoed_in_a_validation_error(self) -> None:
        with pytest.raises(ValidationError) as caught:
            MatrixConnectionConfig.model_validate(
                {**VALID, "homeserver_url": "http://matrix.example.org"}
            )
        assert TOKEN not in str(caught.value)

    def test_the_form_masks_the_token(self) -> None:
        schema = MatrixConnectionConfig.model_json_schema()
        # Console masks a field whose name contains `token`.
        assert set(schema["required"]) == {
            "homeserver_url",
            "bot_user_id",
            "access_token",
        }
        assert schema["properties"]["accept_invites_from_other_servers"]["type"] == (
            "boolean"
        )


class TestRegistration:
    def test_it_is_registered_as_matrix(self) -> None:
        registration = next(p for p in PLATFORMS if p.key == "matrix")
        assert registration.adapter is MatrixAdapter
        assert registration.config is MatrixConnectionConfig

    def test_it_names_itself_and_ships_a_logo(self) -> None:
        described = MatrixAdapter.describe("matrix")
        assert described.display_name == "Matrix"
        assert described.icon_svg is not None and "<svg" in described.icon_svg

    def test_what_it_can_and_cannot_do_is_declared(self) -> None:
        assert MatrixAdapter.keeps_quiet_unless_listening is True
        assert MatrixAdapter.supports_channel_creation is True
        assert MatrixAdapter.supports_directory_search is True
        assert MatrixAdapter.draws_session_activity is True
        assert MatrixAdapter.renders_custom_url_schemes is False
        assert MatrixAdapter.receives_webhooks is False
        adapter = MatrixAdapter(config=MatrixConnectionConfig.model_validate(VALID))
        # No slash commands: Matrix has no API to register them.
        assert adapter.slash_invite_hint() is None

    def test_the_homeserver_is_checked_against_the_outbound_policy(self) -> None:
        assert MatrixAdapter.outbound_urls(dict(VALID)) == [HOMESERVER]

    def test_the_bot_account_is_what_a_connection_claims(self) -> None:
        assert MatrixAdapter.claimed_workspace(dict(VALID)) == (
            "Matrix account @switch-bot:example.org"
        )

    def test_one_account_written_two_ways_is_one_claim(self) -> None:
        shouted = {**VALID, "bot_user_id": "@Switch-Bot:Example.ORG"}
        assert MatrixAdapter.claimed_workspace(shouted) == (
            MatrixAdapter.claimed_workspace(dict(VALID))
        )


class TestVerifyCredentials:
    async def test_a_token_of_the_bot_account_passes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        serve(monkeypatch, homeserver)
        await MatrixAdapter.verify_credentials(dict(VALID))
        assert [r.url.path for r in homeserver.requests] == [
            "/_matrix/client/v3/account/whoami"
        ]

    async def test_a_token_of_another_account_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise a connection could claim an account by typing its ID, and
        keep the account's owner from connecting it."""
        serve(monkeypatch, FakeHomeserver(user_id="@someone-else:example.org"))
        with pytest.raises(
            BridgeCredentialError,
            match="belongs to @someone-else:example.org, not @switch-bot:example.org",
        ):
            await MatrixAdapter.verify_credentials(dict(VALID))

    async def test_a_refused_token_says_so_without_quoting_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        serve(monkeypatch, FakeHomeserver(token="syt_another_placeholder"))
        with pytest.raises(BridgeCredentialError, match="does not accept") as caught:
            await MatrixAdapter.verify_credentials(dict(VALID))
        assert "M_UNKNOWN_TOKEN" in str(caught.value)
        assert TOKEN not in str(caught.value)

    async def test_an_unreachable_homeserver_is_a_clear_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        serve(monkeypatch, FakeHomeserver(unreachable=True))
        with pytest.raises(BridgeCredentialError, match="Could not reach"):
            await MatrixAdapter.verify_credentials(dict(VALID))

    async def test_a_server_error_is_not_read_as_a_bad_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        serve(monkeypatch, FakeHomeserver(whoami=(502, {})))
        with pytest.raises(BridgeCredentialError, match="answered 502"):
            await MatrixAdapter.verify_credentials(dict(VALID))

    @pytest.mark.parametrize(
        ("answer", "says"),
        [
            (
                httpx.Response(301, headers={"location": "https://www.example.org/"}),
                "a redirect",
            ),
            (
                httpx.Response(
                    200,
                    content=b"<html>Welcome</html>",
                    headers={"content-type": "text/html"},
                ),
                "not JSON",
            ),
            (httpx.Response(200, content=b""), "an empty body"),
            (httpx.Response(200, json=["not", "an", "object"]), "not an object"),
        ],
    )
    async def test_a_website_at_the_address_is_told_apart_from_a_homeserver(
        self, monkeypatch: pytest.MonkeyPatch, answer: httpx.Response, says: str
    ) -> None:
        """Usually the server name, entered where the client address belongs."""
        serve(monkeypatch, FakeHomeserver(raw={("GET", "whoami"): lambda: answer}))
        with pytest.raises(BridgeCredentialError) as caught:
            await MatrixAdapter.verify_credentials(dict(VALID))
        message = str(caught.value)
        assert "is not a Matrix homeserver's client API" in message
        assert says in message
        assert ".well-known/matrix/client" in message

    async def test_an_answer_with_no_account_in_it_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        serve(monkeypatch, FakeHomeserver(whoami=(200, {})))
        with pytest.raises(BridgeCredentialError, match="not a Matrix homeserver"):
            await MatrixAdapter.verify_credentials(dict(VALID))

    async def test_a_guest_account_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        serve(
            monkeypatch,
            FakeHomeserver(whoami=(200, {"user_id": BOT, "is_guest": True})),
        )
        with pytest.raises(BridgeCredentialError, match="guest"):
            await MatrixAdapter.verify_credentials(dict(VALID))


class TestFailures:
    def _error(self, status: int, errcode: str | None) -> MatrixApiError:
        return MatrixApiError(
            method="GET",
            path="/_matrix/client/v3/sync",
            status=status,
            errcode=errcode,
            error="placeholder",
            retry_after_ms=None,
        )

    def test_a_rejected_token_is_an_auth_failure(self) -> None:
        assert MatrixAdapter.classify_failure(self._error(401, "M_UNKNOWN_TOKEN")) == (
            "auth_failed"
        )

    def test_any_other_refusal_is_the_platform(self) -> None:
        assert MatrixAdapter.classify_failure(self._error(403, "M_FORBIDDEN")) == (
            "platform_error"
        )

    def test_anything_else_is_left_to_switch(self) -> None:
        assert MatrixAdapter.classify_failure(ValueError("x")) is None

    async def test_starting_with_a_revoked_token_is_a_credential_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(token="syt_another_placeholder")
        adapter = make_adapter(monkeypatch, homeserver)
        with pytest.raises(BridgeCredentialError, match="no longer accepts"):
            await start(adapter, Recorder())

    async def test_starting_on_another_account_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A token edited to another account's would bridge rooms nobody claimed."""
        homeserver = FakeHomeserver(user_id="@someone-else:example.org")
        adapter = make_adapter(monkeypatch, homeserver)
        with pytest.raises(BridgeCredentialError, match="now belongs to"):
            await start(adapter, Recorder())


class TestOutboundPolicy:
    async def test_the_running_bridge_connects_through_the_deployments_policy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        adapter = make_adapter(monkeypatch, homeserver, listening=False)
        await start(adapter, Recorder())
        await adapter.stop()
        assert homeserver.clients == [("guarded", adapter.outbound_policy)]

    async def test_only_the_credential_check_uses_an_unguarded_client(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It runs after the lifecycle checked the URL against the policy, and
        before there is a bridge to hold one."""
        homeserver = FakeHomeserver()
        serve(monkeypatch, homeserver)
        await MatrixAdapter.verify_credentials(dict(VALID))
        assert homeserver.clients == [("unguarded", None)]
