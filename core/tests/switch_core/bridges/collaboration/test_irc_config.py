"""The IRC connection form, the credential check, and what the adapter
declares about the platform."""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.irc.adapter import (
    IrcAdapter,
    IrcConnectionConfig,
)
from switch_core.bridges.collaboration.irc.client import IrcLoginRefused
from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.bridges.collaboration.platforms import PLATFORMS
from tests.switch_core.bridges.collaboration.irc_fakes import (
    NICK,
    PASSWORD,
    FakeIrcServer,
    quick,
)


@pytest.fixture
async def server() -> AsyncIterator[FakeIrcServer]:
    async with FakeIrcServer() as running:
        yield running


@pytest.fixture
async def tls_server(tmp_path: Path) -> AsyncIterator[FakeIrcServer]:
    async with FakeIrcServer(tls_in=tmp_path) as running:
        yield running


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    quick(monkeypatch)


def _config(**overrides: Any) -> IrcConnectionConfig:
    return IrcConnectionConfig.model_validate(
        {"server": "irc.example.net", "nick": NICK, **overrides}
    )


def _checked(server: FakeIrcServer, **overrides: Any) -> dict[str, object]:
    return {
        "server": "127.0.0.1",
        "port": server.port,
        "tls": False,
        "nick": NICK,
        **overrides,
    }


def _logged_in(server: FakeIrcServer, password: str) -> dict[str, object]:
    """Over TLS, the only way a password is sent, to a server whose
    certificate nobody signed."""
    return {
        "server": "127.0.0.1",
        "port": server.port,
        "verify_tls": False,
        "nick": NICK,
        "account_password": password,
    }


# ── The form ─────────────────────────────────────────────────────────────────


def test_a_minimal_config_dials_tls_on_6697() -> None:
    config = _config()
    assert (config.port, config.tls, config.verify_tls) == (6697, True, True)
    assert config.account_name is None and config.account_password is None
    assert config.channel_list == []


def test_channels_are_lowercased_split_and_deduplicated() -> None:
    config = _config(channels="#Ops, #deploys #ops,,&local")
    assert config.channel_list == ["#ops", "#deploys", "&local"]


@pytest.mark.parametrize(
    "server",
    ["https://irc.example.net", "irc.example.net:6697", "irc example.net", ""],
)
def test_the_server_is_a_bare_hostname(server: str) -> None:
    with pytest.raises(ValidationError, match="hostname alone"):
        _config(server=server)


def test_an_ip_address_is_a_server() -> None:
    assert _config(server="[2001:db8::1]").server == "2001:db8::1"


@pytest.mark.parametrize("nick", ["1bot", "-bot", "bot name", "bot\r\nQUIT", ""])
def test_a_nick_must_be_one_the_network_takes(nick: str) -> None:
    with pytest.raises(ValidationError, match="nick must start"):
        _config(nick=nick)


@pytest.mark.parametrize("channel", ["ops", "#a,b:c", "#with space\x07", "#"])
def test_each_channel_must_be_a_channel_name(channel: str) -> None:
    with pytest.raises(ValidationError, match="not a channel name"):
        _config(channels=channel)


def test_a_password_is_only_sent_over_tls() -> None:
    with pytest.raises(ValidationError, match="Turn on TLS"):
        _config(tls=False, account_password=PASSWORD)


def test_a_blank_account_is_no_account() -> None:
    config = _config(account_name="  ", account_password="")
    assert config.account_name is None and config.account_password is None


def test_the_password_is_masked_and_never_echoed_in_errors() -> None:
    # Console masks a field whose name says it holds a password.
    secret_fields = [
        name
        for name in IrcConnectionConfig.model_json_schema()["properties"]
        if "password" in name
    ]
    assert secret_fields == ["account_password"]
    with pytest.raises(ValidationError) as refused:
        _config(account_password="has a space")
    assert "has a space" not in str(refused.value)


# ── What the adapter declares ────────────────────────────────────────────────


def test_irc_is_registered_with_its_name_and_icon() -> None:
    (registration,) = [p for p in PLATFORMS if p.key == "irc"]
    described = registration.adapter.describe("irc")
    assert described.display_name == "IRC"
    assert described.icon_svg is not None and described.icon_svg.startswith("<svg")


def test_what_irc_cannot_do_is_declared() -> None:
    assert IrcAdapter.keeps_quiet_unless_listening is True
    assert IrcAdapter.supports_directory_search is False
    assert IrcAdapter.supports_activity_reactions is False
    assert IrcAdapter.renders_custom_url_schemes is False
    assert IrcAdapter.channel_on_delete == "left"
    assert IrcAdapter.draws_session_activity is True


def test_the_outbound_policy_checks_the_address_the_bot_dials() -> None:
    assert IrcAdapter.outbound_urls(
        {"server": "irc.example.net", "port": 6697, "nick": NICK}
    ) == ["https://irc.example.net:6697"]
    assert IrcAdapter.outbound_urls(
        {"server": "2001:db8::1", "port": 7000, "nick": NICK}
    ) == ["https://[2001:db8::1]:7000"]


def test_one_nick_on_one_network_is_one_claim() -> None:
    claim = IrcAdapter.claimed_workspace(
        {"server": "IRC.example.net", "nick": "SwitchBot", "account_password": PASSWORD}
    )
    assert claim == "IRC nick switchbot on irc.example.net:6697"
    assert PASSWORD not in (claim or "")


def test_a_refused_login_is_an_auth_failure() -> None:
    assert IrcAdapter.classify_failure(IrcLoginRefused("no")) == "auth_failed"
    assert IrcAdapter.classify_failure(ConnectionResetError()) is None


def test_only_a_logged_in_person_can_be_linked() -> None:
    assert IrcAdapter.unlinkable_account_reason("account:ada") is None
    reason = IrcAdapter.unlinkable_account_reason("nick:ada")
    assert reason is not None and "not logged in" in reason


# ── Checking credentials against a server ────────────────────────────────────


async def test_a_bot_without_an_account_registers_and_quits(
    server: FakeIrcServer,
) -> None:
    await IrcAdapter.verify_credentials(_checked(server))
    await server.wait_for(lambda: bool(server.sent("QUIT")))
    assert not server.sent("AUTHENTICATE")


async def test_sasl_logs_the_account_in(
    tls_server: FakeIrcServer,
) -> None:
    await IrcAdapter.verify_credentials(_logged_in(tls_server, PASSWORD))
    assert [line.params for line in tls_server.sent("AUTHENTICATE")][0] == ("PLAIN",)
    assert not tls_server.said("NickServ")


async def test_a_wrong_password_is_refused_clearly(
    tls_server: FakeIrcServer,
) -> None:
    with pytest.raises(BridgeCredentialError) as refused:
        await IrcAdapter.verify_credentials(_logged_in(tls_server, "not-the-password"))
    message = str(refused.value)
    assert "would not log the bot in as switchbot" in message
    assert "SASL authentication failed" in message
    assert "not-the-password" not in message


async def test_without_sasl_nickserv_logs_the_account_in(
    tls_server: FakeIrcServer,
) -> None:
    del tls_server.caps["sasl"]
    await IrcAdapter.verify_credentials(_logged_in(tls_server, PASSWORD))
    assert tls_server.said("NickServ") == [f"IDENTIFY {NICK} {PASSWORD}"]


async def test_nickserv_confirming_with_the_bots_account_is_a_login(
    tls_server: FakeIrcServer,
) -> None:
    del tls_server.caps["sasl"]
    tls_server.nickserv_sends_900 = False
    await IrcAdapter.verify_credentials(_logged_in(tls_server, PASSWORD))


async def test_nickserv_refusing_says_what_nickserv_said(
    tls_server: FakeIrcServer,
) -> None:
    del tls_server.caps["sasl"]
    with pytest.raises(BridgeCredentialError, match="Invalid password"):
        await IrcAdapter.verify_credentials(_logged_in(tls_server, "not-the-password"))


async def test_a_nick_the_network_will_not_take_is_refused(
    server: FakeIrcServer,
) -> None:
    server.taken = {NICK, f"{NICK}_", f"{NICK}__", f"{NICK}___"}
    with pytest.raises(BridgeCredentialError, match="Nickname is already in use"):
        await IrcAdapter.verify_credentials(_checked(server))


async def test_a_certificate_nobody_signed_is_refused_unless_trusted(
    tls_server: FakeIrcServer,
) -> None:
    checked = {**_logged_in(tls_server, PASSWORD), "verify_tls": True}
    with pytest.raises(BridgeCredentialError, match="CERTIFICATE_VERIFY_FAILED"):
        await IrcAdapter.verify_credentials(checked)


async def test_a_server_nobody_answers_at_is_unreachable() -> None:
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        port = unused.getsockname()[1]
    with pytest.raises(BridgeCredentialError, match="Could not reach the IRC server"):
        await IrcAdapter.verify_credentials(
            {"server": "127.0.0.1", "port": port, "tls": False, "nick": NICK}
        )
