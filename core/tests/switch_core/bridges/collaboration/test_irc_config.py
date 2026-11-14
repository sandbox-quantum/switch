"""The IRC connect form, what the adapter declares, and its credential check."""

from __future__ import annotations

import ssl

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.irc.adapter import (
    IrcAdapter,
    IrcConnectionConfig,
)
from switch_core.bridges.collaboration.irc.client import (
    IrcDisconnected,
    IrcLoginRefused,
)
from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.bridges.collaboration.platforms import PLATFORMS

from .irc_fakes import FakeIrcServer


def _config(**overrides: object) -> dict[str, object]:
    return {"server": "irc.example.net", "nick": "switchbot", **overrides}


# ── The form ─────────────────────────────────────────────────────────────────


def test_a_plain_bot_needs_only_a_server_and_a_nick() -> None:
    config = IrcConnectionConfig.model_validate(_config())
    assert (config.port, config.tls, config.verify_tls) == (6697, True, True)
    assert config.account is None and config.password is None
    assert config.channel_list() == []


def test_values_are_normalised() -> None:
    config = IrcConnectionConfig.model_validate(
        _config(server=" IRC.Example.NET ", nick=" switchbot ", channels="#a, #b ,,")
    )
    assert config.server == "irc.example.net"
    assert config.nick == "switchbot"
    assert config.channel_list() == ["#a", "#b"]


@pytest.mark.parametrize(
    ("overrides", "said"),
    [
        ({"server": "ircs://irc.example.net"}, "server's name alone"),
        ({"server": "irc example"}, "server's name alone"),
        ({"nick": "9lives"}, "A nick starts with a letter"),
        ({"nick": "has space"}, "A nick starts with a letter"),
        ({"channels": "ops"}, "is not a channel name"),
        ({"channels": "#ok, #not ok"}, "is not a channel name"),
        ({"port": 0}, "greater than or equal to 1"),
        ({"account": "bot"}, "or neither"),
        ({"password": "s3cret"}, "or neither"),
        (
            {"account": "bot", "password": "s3cret", "tls": False, "port": 6667},
            "Turn on TLS",
        ),
    ],
)
def test_refuses_what_the_bot_cannot_use(
    overrides: dict[str, object], said: str
) -> None:
    with pytest.raises(ValidationError) as caught:
        IrcConnectionConfig.model_validate(_config(**overrides))
    assert said in str(caught.value)


def test_blank_login_fields_mean_no_login() -> None:
    config = IrcConnectionConfig.model_validate(_config(account=" ", password=""))
    assert config.account is None and config.password is None


def test_the_password_field_is_one_console_masks() -> None:
    # Console masks a field whose name contains `password`; the form is the
    # model's JSON schema, so the name is what has to hold.
    schema = IrcConnectionConfig.model_json_schema()
    assert "password" in schema["properties"]
    assert schema["properties"]["password"]["title"] == "Services password"


def test_the_password_is_never_in_the_configs_text() -> None:
    config = IrcConnectionConfig.model_validate(
        _config(account="bot", password="hunter2-x")
    )
    assert "hunter2-x" not in repr(config.settings())
    assert "hunter2-x" not in repr(config)


# ── What the adapter declares ────────────────────────────────────────────────


def test_registered_as_irc() -> None:
    registration = next(p for p in PLATFORMS if p.key == "irc")
    assert registration.adapter is IrcAdapter
    assert registration.config is IrcConnectionConfig
    described = IrcAdapter.describe("irc")
    assert described.display_name == "IRC"
    assert described.icon_svg is not None and described.icon_svg.startswith("<svg")


def test_declares_what_irc_cannot_do() -> None:
    assert IrcAdapter.keeps_quiet_unless_listening is True
    assert IrcAdapter.supports_directory_search is False
    assert IrcAdapter.supports_activity_reactions is False
    assert IrcAdapter.renders_custom_url_schemes is False
    assert IrcAdapter.receives_webhooks is False
    assert IrcAdapter.channel_on_delete == "left"


def test_one_bridge_per_nick_per_network() -> None:
    assert IrcAdapter.claimed_workspace(_config()) == "irc switchbot@irc.example.net"
    assert IrcAdapter.claimed_workspace(_config(nick="SwitchBot")) == (
        IrcAdapter.claimed_workspace(_config())
    )


def test_the_server_is_checked_by_the_outbound_policy() -> None:
    assert IrcAdapter.outbound_urls(_config(port=6697)) == [
        "https://irc.example.net:6697"
    ]


def test_failures_are_classified() -> None:
    assert IrcAdapter.classify_failure(IrcLoginRefused("no")) == "auth_failed"
    assert IrcAdapter.classify_failure(IrcDisconnected("gone")) == "network"
    assert IrcAdapter.classify_failure(TimeoutError()) == "network"
    assert (
        IrcAdapter.classify_failure(ssl.SSLCertVerificationError()) == "config_invalid"
    )
    assert IrcAdapter.classify_failure(ValueError()) is None


def test_a_nick_without_a_login_cannot_be_linked() -> None:
    assert IrcAdapter.unlinkable_account_reason("nick:ada") is not None
    assert IrcAdapter.unlinkable_account_reason("account:ada") is None


# ── Checking the login before saving ─────────────────────────────────────────


async def _verify(server: FakeIrcServer, **overrides: object) -> None:
    await IrcAdapter.verify_credentials(
        _config(
            server="127.0.0.1",
            port=server.port,
            tls=server.tls,
            verify_tls=False,
            **overrides,
        )
    )


async def test_accepts_a_plain_bot() -> None:
    async with FakeIrcServer() as server:
        await _verify(server)
    assert any(line == "NICK switchbot" for line in server.received)


async def test_accepts_a_sasl_login() -> None:
    async with FakeIrcServer(tls=True) as server:
        await _verify(server, account="switchbot", password="s3cret")
    assert "AUTHENTICATE PLAIN" in server.received


async def test_names_a_wrong_password_without_echoing_it() -> None:
    async with FakeIrcServer(tls=True) as server:
        with pytest.raises(BridgeCredentialError) as caught:
            await _verify(server, account="switchbot", password="wrong-one")
    assert "Invalid account credentials" in str(caught.value)
    assert "wrong-one" not in str(caught.value)


@pytest.mark.parametrize("style", ["atheme", "ergo"])
async def test_logs_in_through_nickserv_without_sasl(style: str) -> None:
    caps = ("server-time", "message-tags")
    async with FakeIrcServer(tls=True, caps=caps, nickserv=style) as server:
        await _verify(server, account="switchbot", password="s3cret")
    assert "PRIVMSG NickServ :IDENTIFY switchbot s3cret" in server.received


async def test_says_what_nickserv_said_when_it_refuses() -> None:
    async with FakeIrcServer(tls=True, caps=(), nickserv="atheme") as server:
        with pytest.raises(BridgeCredentialError) as caught:
            await _verify(server, account="switchbot", password="nope-nope")
    assert "Invalid password" in str(caught.value)


async def test_says_when_the_nick_and_its_fallbacks_are_taken() -> None:
    taken = {"switchbot", "switchbot_", "switchbot__", "switchbot___"}
    async with FakeIrcServer(taken=taken) as server:
        with pytest.raises(BridgeCredentialError) as caught:
            await _verify(server)
    assert "in use" in str(caught.value)


async def test_refuses_a_certificate_it_cannot_verify() -> None:
    async with FakeIrcServer(tls=True) as server:
        with pytest.raises(BridgeCredentialError) as caught:
            await IrcAdapter.verify_credentials(
                _config(server="127.0.0.1", port=server.port)
            )
    assert "could not be verified" in str(caught.value)


async def test_says_when_the_server_cannot_be_reached() -> None:
    async with FakeIrcServer() as server:
        port = server.port
    with pytest.raises(BridgeCredentialError) as caught:
        await IrcAdapter.verify_credentials(
            _config(server="127.0.0.1", port=port, tls=False)
        )
    assert "Could not reach 127.0.0.1" in str(caught.value)
