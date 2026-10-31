"""Connecting a Rocket.Chat bridge: its settings, the credential check, and
what the adapter declares about the platform before any connection exists."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.bridges.collaboration.rocketchat.realtime import RealtimeLoginRefused
from switch_core.bridges.collaboration.rocketchat.rest import RocketChatApiError
from tests.switch_core.bridges.collaboration.rocketchat_fakes import (
    BOT_ID,
    SERVER,
    FakeRocketChat,
    config,
    refused,
)


def _raw(**overrides: Any) -> dict[str, object]:
    return config(**overrides).model_dump()


@pytest.mark.parametrize(
    ("given", "stored"),
    [
        ("https://chat.example.com", "https://chat.example.com"),
        ("https://chat.example.com/", "https://chat.example.com"),
        (" http://rc.internal:3000/ ", "http://rc.internal:3000"),
        ("https://example.com/chat/", "https://example.com/chat"),
    ],
)
def test_a_server_url_is_stored_without_its_trailing_slash(
    given: str, stored: str
) -> None:
    assert config(server_url=given).server_url == stored


@pytest.mark.parametrize(
    "bad",
    [
        "chat.example.com",
        "ftp://chat.example.com",
        "https://",
        "https://chat.example.com/?x=1",
        "https://chat.example.com:notaport",
    ],
)
def test_a_server_url_that_names_no_server_is_refused(bad: str) -> None:
    with pytest.raises(ValidationError, match="server_url"):
        config(server_url=bad)


@pytest.mark.parametrize("field", ["bot_user_id", "personal_access_token"])
def test_a_blank_credential_is_refused(field: str) -> None:
    with pytest.raises(ValidationError, match=field):
        config(**{field: "  "})


def test_the_token_is_masked_and_never_echoed_in_an_error() -> None:
    schema = RocketChatConnectionConfig.model_json_schema()
    # Console masks a field whose name says "token".
    assert "personal_access_token" in schema["properties"]
    with pytest.raises(ValidationError) as caught:
        config(personal_access_token="secret-value", server_url="nope")
    assert "secret-value" not in str(caught.value)


def test_the_platform_declares_itself() -> None:
    described = RocketChatAdapter.describe("rocketchat")
    assert described.display_name == "Rocket.Chat"
    assert described.icon_svg is not None and described.icon_svg.startswith("<svg")
    assert described.docs_slug is None


def test_what_the_platform_can_and_cannot_do_is_declared() -> None:
    assert RocketChatAdapter.keeps_quiet_unless_listening
    assert RocketChatAdapter.supports_channel_creation
    assert RocketChatAdapter.supports_directory_search
    assert RocketChatAdapter.supports_activity_reactions
    assert not RocketChatAdapter.activity_reactions_per_agent
    assert not RocketChatAdapter.renders_custom_url_schemes
    assert not RocketChatAdapter.receives_webhooks
    assert RocketChatAdapter.channel_on_delete == "archived"
    assert RocketChatAdapter(config=config()).slash_invite_hint() is None


def test_the_server_is_checked_against_the_outbound_policy() -> None:
    assert RocketChatAdapter.outbound_urls(_raw()) == [SERVER]


def test_a_bot_is_claimed_on_its_server_in_one_spelling() -> None:
    one = RocketChatAdapter.claimed_workspace(
        _raw(server_url="https://Chat.Example.com:443/")
    )
    other = RocketChatAdapter.claimed_workspace(_raw(server_url=SERVER))
    assert one == other == f"Rocket.Chat bot {BOT_ID} on https://chat.example.com"
    assert "test-placeholder-token" not in str(one)


def test_failures_are_classified_from_the_real_exception_types() -> None:
    classify = RocketChatAdapter.classify_failure
    assert classify(RealtimeLoginRefused("bad token")) == "auth_failed"
    unauthorised = RocketChatApiError(401, "You must be logged in")
    assert classify(unauthorised) == "auth_failed"
    forbidden = RocketChatApiError(400, "Not allowed [error-action-not-allowed]")
    assert classify(forbidden) == "platform_error"
    assert classify(httpx.ConnectError("refused")) == "network"
    assert classify(ValueError("not ours")) is None


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeRocketChat:
    """The fake behind `verify_credentials`, which builds a client of its own."""
    server = FakeRocketChat()
    monkeypatch.setattr(httpx, "AsyncClient", server.client)
    return server


async def test_good_credentials_are_accepted(fake: FakeRocketChat) -> None:
    await RocketChatAdapter.verify_credentials(_raw())
    [call] = fake.called("me")
    assert call.headers["X-User-Id"] == BOT_ID
    assert call.headers["X-Auth-Token"] == "test-placeholder-token"
    # The token travels only in a header.
    assert "test-placeholder-token" not in call.path + str(call.params)


async def test_a_rejected_token_says_which_fields_to_check(
    fake: FakeRocketChat,
) -> None:
    fake.on("me", lambda _: refused(401, "You must be logged in to do this."))
    with pytest.raises(BridgeCredentialError, match="did not accept the bot user ID"):
        await RocketChatAdapter.verify_credentials(_raw())


async def test_an_account_without_the_bot_role_is_refused(fake: FakeRocketChat) -> None:
    fake.on("me", lambda _: {"_id": BOT_ID, "username": "ada", "roles": ["user"]})
    with pytest.raises(BridgeCredentialError, match="ada is not a bot user"):
        await RocketChatAdapter.verify_credentials(_raw())


async def test_a_deactivated_bot_is_refused(fake: FakeRocketChat) -> None:
    fake.on(
        "me",
        lambda _: {"_id": BOT_ID, "username": "b", "roles": ["bot"], "active": False},
    )
    with pytest.raises(BridgeCredentialError, match="deactivated"):
        await RocketChatAdapter.verify_credentials(_raw())


async def test_something_that_is_not_rocket_chat_is_named(fake: FakeRocketChat) -> None:
    fake.on("me", lambda _: httpx.Response(502, text="<html>bad gateway</html>"))
    with pytest.raises(BridgeCredentialError, match="Check the server URL"):
        await RocketChatAdapter.verify_credentials(_raw())


async def test_an_unreachable_server_is_named(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real(
            transport=httpx.MockTransport(unreachable), base_url=kw["base_url"]
        ),
    )
    with pytest.raises(BridgeCredentialError, match="Could not reach Rocket.Chat"):
        await RocketChatAdapter.verify_credentials(_raw())
